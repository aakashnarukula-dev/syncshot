/**
 * Sync engine — the realtime brain that ties Firebase to the OS glue.
 *
 * Lives for the lifetime of the (always-alive, possibly hidden) main webview.
 * On start it: loads local prefs (deviceId/name/paused), wires the
 * Rust-emitted Tauri events (`new-screenshot`, `clipboard-changed`) to the
 * publishers, and follows auth state — listeners run while a user is signed
 * in (email-link OTP; every device shares the account, data under
 * users/{uid}) and stop on sign-out.
 *
 * Pure logic — no React. It reads/writes the zustand sync store directly so
 * any window can render the live state.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  incomingScreenshotPreview,
  incomingScreenshotSaved,
  registerScreenshotLoadMore,
  useSyncStore,
} from "@/stores/syncStore";
import { logout, watchAuth } from "./firebase";
import { loadSyncPrefs, saveDeviceId, saveDeviceName, savePaused } from "./persistence";
import { registerDevice, touchDevice, watchDeviceRevocation } from "./devices";
import {
  cloudScreenshotPath,
} from "./order";
import {
  backfillScreenshotThumbUrls,
  clearPreloadedScreenshotImages,
  preloadScreenshotImages,
  publishScreenshot,
  storageDownloadUrl,
  subscribeScreenshots,
} from "./screenshots";
import { subscribeClipboard, writeClipboardEntry } from "./clipboard";
import {
  clipboardSignature,
  screenshotsSignature,
  type ClipboardDoc,
  type DeviceRef,
  type ScreenshotDoc,
} from "./types";

let started = false;
let device: DeviceRef | null = null;
let deviceId: string | null = null;

let unsubScreenshots: (() => void) | null = null;
let unsubClipboard: (() => void) | null = null;
let unsubDeviceRevocation: (() => void) | null = null;
let unsubAuth: (() => void) | null = null;
let unlistenNewShot: UnlistenFn | null = null;
let unlistenClipChanged: UnlistenFn | null = null;

// Signature of the last snapshot written to the store. Firestore fires plenty
// of echo snapshots (cache replays, latency-compensation double-fires) whose
// rendered content is identical; skipping the store write for those avoids a
// full App re-render per echo while uploads/downloads churn.
let lastScreenshotsSig: string | null = null;
// Same skip for clipboard snapshots — without it every echo snapshot replaced
// the store array identity and re-rendered all ~200 clipboard cards.
let lastClipboardSig: string | null = null;
// Newest clipboard hash seen (any device) — suppresses echo when we re-copy a
// remote entry (set_clipboard_text would otherwise bounce back via the poller).
let recentClipHash: string | null = null;
// First authoritative snapshot is the launch baseline, never a stream of fresh
// arrivals. Later remote docs above this server-timestamp mark are genuinely new
// and may reveal the pill. Keeping the ids lets the full-download completion fire
// exactly one local-ready callback for the same shot.
let incomingBaselineReady = false;
let incomingHighWater = Number.NEGATIVE_INFINITY;
const freshIncomingIds = new Set<string>();
const knownIncomingIds = new Set<string>();
let listenerStartedAt = 0;
let lastPresenceTouchAt = 0;
let presenceTimer: ReturnType<typeof setInterval> | null = null;

function store() {
  return useSyncStore.getState();
}

function touchCurrentDevice(force = false): void {
  const current = device;
  if (!current) return;
  const now = Date.now();
  if (!force && now - lastPresenceTouchAt < 60_000) return;
  lastPresenceTouchAt = now;
  void touchDevice(current).catch((err) =>
    console.error("device presence update failed:", err),
  );
}

function markFreshIncoming(item: ScreenshotDoc): void {
  freshIncomingIds.add(item.id);
  if (item.thumbPath) {
    void storageDownloadUrl(item.thumbPath)
      .then((url) => {
        const preview = new Image();
        preview.src = url;
      })
      .catch(() => {});
    incomingScreenshotPreview(item, cloudScreenshotPath(item.id, item.sha256));
  }
}

function handleScreenshots(
  items: ScreenshotDoc[],
  hasMore: boolean,
  fromCache: boolean,
): void {
  const uid = store().uid;
  if (uid) backfillScreenshotThumbUrls(uid, items);
  preloadScreenshotImages(items);
  const sig = screenshotsSignature(items, hasMore);
  if (sig !== lastScreenshotsSig) {
    lastScreenshotsSig = sig;
    store().setScreenshots(items, hasMore);
  }

  if (!fromCache) {
    if (!incomingBaselineReady) {
      incomingHighWater = items.reduce(
        (latest, item) => Math.max(latest, item.createdAt ?? Number.NEGATIVE_INFINITY),
        Number.NEGATIVE_INFINITY,
      );
      for (const item of items) {
        knownIncomingIds.add(item.id);
        if (
          item.device.deviceId !== deviceId &&
          item.createdAt !== null &&
          item.createdAt >= listenerStartedAt
        ) {
          markFreshIncoming(item);
        }
      }
      incomingBaselineReady = true;
    } else {
      const fresh = items.filter(
        (item) =>
          !knownIncomingIds.has(item.id) &&
          item.device.deviceId !== deviceId &&
          item.createdAt !== null &&
          (item.createdAt >= incomingHighWater || item.createdAt >= listenerStartedAt),
      );
      for (const item of fresh) {
        markFreshIncoming(item);
      }
      incomingHighWater = items.reduce(
        (latest, item) => Math.max(latest, item.createdAt ?? Number.NEGATIVE_INFINITY),
        incomingHighWater,
      );
      for (const item of items) knownIncomingIds.add(item.id);
    }
  }

  for (const item of items) {
    if (
      item.status === "full" &&
      item.fullPath &&
      item.device.deviceId !== deviceId &&
      freshIncomingIds.delete(item.id)
    ) {
      // Cloud-only Mac: no full-image download on arrival. The rail already
      // paints the tiny Firebase thumbnail; full bytes are fetched only when
      // the user opens/copies/drags the shot.
      incomingScreenshotSaved(item, cloudScreenshotPath(item.id, item.sha256));
    }
  }
}

function handleClipboard(items: ClipboardDoc[]): void {
  const sig = clipboardSignature(items);
  if (sig !== lastClipboardSig) {
    lastClipboardSig = sig;
    store().setClipboard(items);
  }
  if (items.length > 0) recentClipHash = items[0].hash;
}

function stopListeners(): void {
  clearPreloadedScreenshotImages();
  unsubDeviceRevocation?.();
  unsubDeviceRevocation = null;
  unsubScreenshots?.();
  unsubScreenshots = null;
  if (presenceTimer) clearInterval(presenceTimer);
  presenceTimer = null;
  registerScreenshotLoadMore(null);
  unsubClipboard?.();
  unsubClipboard = null;
  lastScreenshotsSig = null;
  lastClipboardSig = null;
  incomingBaselineReady = false;
  incomingHighWater = Number.NEGATIVE_INFINITY;
  freshIncomingIds.clear();
  knownIncomingIds.clear();
  listenerStartedAt = 0;
}

function startListeners(uid: string): void {
  stopListeners();
  listenerStartedAt = Date.now() - 10_000;
  const currentDevice = device;
  if (currentDevice) {
    // Presence is best-effort: an offline Mac still gets its cached Library and
    // queues regular Firestore writes. The next online auth session refreshes it.
    void registerDevice(currentDevice).catch((err) =>
      console.error("device registration failed:", err),
    );
    unsubDeviceRevocation = watchDeviceRevocation(
      currentDevice,
      () => {
        // A listener can fire more than once (cache/server metadata updates).
        // Auth's signed-out transition tears this subscription down; avoid
        // starting duplicate sign-out requests before that happens.
        if (!device) return;
        void logout().catch((err) => console.error("remote device sign-out failed:", err));
      },
      (err) => console.error("device revocation listener error:", err),
    );
    touchCurrentDevice(true);
    presenceTimer = setInterval(() => touchCurrentDevice(), 60_000);
  }
  const screenshots = subscribeScreenshots(uid, handleScreenshots, (err) =>
    console.error("screenshots listener error:", err),
  );
  unsubScreenshots = screenshots.unsubscribe;
  // Expose the page-grower to the Library grid (via the store) so scrolling near
  // the bottom pulls in older shots instead of fetching all 100+ up front.
  registerScreenshotLoadMore(screenshots.loadMore);
  unsubClipboard = subscribeClipboard(uid, handleClipboard, (err) =>
    console.error("clipboard listener error:", err),
  );
}

/** Sign this Mac out: listeners stop and the store flips to signedOut via the
 *  auth watcher. Local files/screenshots on disk are untouched. */
export async function signOutDevice(): Promise<void> {
  await logout();
}

/** Update the device display name (persisted + reflected in future writes). */
export async function updateDeviceName(name: string): Promise<void> {
  const trimmed = name.trim() || "Mac";
  store().setDeviceName(trimmed);
  if (device) device.name = trimmed;
  await saveDeviceName(trimmed);
  if (device) await registerDevice(device);
}

/** Current device reference (uid/deviceId/name/platform), or null before sign-in. */
export function getDevice(): DeviceRef | null {
  return device;
}

/** Toggle clipboard capture pause (persisted). */
export async function setSyncPaused(paused: boolean): Promise<void> {
  store().setPaused(paused);
  await savePaused(paused);
}

/** Idempotent. Safe to call from a React effect (guards StrictMode double-run). */
export async function startSyncEngine(): Promise<void> {
  if (started) return;
  started = true;

  const prefs = await loadSyncPrefs();
  if (prefs.deviceName) store().setDeviceName(prefs.deviceName);
  store().setPaused(prefs.paused);

  deviceId = prefs.deviceId;
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    await saveDeviceId(deviceId);
  }

  // Wire OS events up front (cheap, no network) so captures/copies that land
  // before sign-in completes are simply ignored (uid/device still null).
  unlistenNewShot = await listen<string>("new-screenshot", (event) => {
    const { uid } = store();
    if (uid && device) {
      touchCurrentDevice(true);
      publishScreenshot(uid, device, event.payload).catch((err) =>
        console.error("publish screenshot failed:", err),
      );
    }
  });

  unlistenClipChanged = await listen<{ text: string }>("clipboard-changed", (event) => {
    const { uid, paused } = store();
    if (!uid || !device || paused) return;
    touchCurrentDevice();
    writeClipboardEntry(uid, device, event.payload.text, recentClipHash)
      .then((hash) => {
        if (hash) recentClipHash = hash;
      })
      .catch((err) => console.error("write clipboard failed:", err));
  });

  unsubAuth = watchAuth(
    (user) => {
      if (user) {
        device = {
          uid: user.uid,
          deviceId: deviceId!,
          name: store().deviceName,
          platform: "mac",
        };
        store().setAuth(user.uid, user.phoneNumber ?? user.email);
        startListeners(user.uid);
      } else {
        device = null;
        stopListeners();
        store().setSignedOut();
      }
    },
    (err) => store().setAuthError(err.message),
  );
}

/** Tear down listeners + OS event subscriptions (used on full app teardown). */
export function stopSyncEngine(): void {
  stopListeners();
  unsubAuth?.();
  unsubAuth = null;
  unlistenNewShot?.();
  unlistenNewShot = null;
  unlistenClipChanged?.();
  unlistenClipChanged = null;
  started = false;
}

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
import { registerScreenshotLoadMore, useSyncStore } from "@/stores/syncStore";
import { logout, watchAuth } from "./firebase";
import { loadSyncPrefs, saveDeviceId, saveDeviceName, savePaused } from "./persistence";
import { publishScreenshot, saveReceivedScreenshot, subscribeScreenshots } from "./screenshots";
import { subscribeClipboard, writeClipboardEntry } from "./clipboard";
import type { ClipboardDoc, DeviceRef, ScreenshotDoc } from "./types";

let started = false;
let device: DeviceRef | null = null;
let deviceId: string | null = null;

let unsubScreenshots: (() => void) | null = null;
let unsubClipboard: (() => void) | null = null;
let unsubAuth: (() => void) | null = null;
let unlistenNewShot: UnlistenFn | null = null;
let unlistenClipChanged: UnlistenFn | null = null;

// Full images already pulled to disk — avoids re-saving on every snapshot.
const savedFullIds = new Set<string>();
// Newest clipboard hash seen (any device) — suppresses echo when we re-copy a
// remote entry (set_clipboard_text would otherwise bounce back via the poller).
let recentClipHash: string | null = null;

function store() {
  return useSyncStore.getState();
}

function handleScreenshots(items: ScreenshotDoc[], hasMore: boolean): void {
  store().setScreenshots(items, hasMore);
  for (const item of items) {
    if (
      item.status === "full" &&
      item.fullPath &&
      item.device.deviceId !== deviceId &&
      !savedFullIds.has(item.id)
    ) {
      savedFullIds.add(item.id);
      saveReceivedScreenshot(item).catch((err) => {
        savedFullIds.delete(item.id); // allow a retry on the next snapshot
        console.error("save received screenshot failed:", err);
      });
    }
  }
}

function handleClipboard(items: ClipboardDoc[]): void {
  store().setClipboard(items);
  if (items.length > 0) recentClipHash = items[0].hash;
}

function stopListeners(): void {
  unsubScreenshots?.();
  unsubScreenshots = null;
  registerScreenshotLoadMore(null);
  unsubClipboard?.();
  unsubClipboard = null;
}

function startListeners(uid: string): void {
  stopListeners();
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
      publishScreenshot(uid, device, event.payload).catch((err) =>
        console.error("publish screenshot failed:", err),
      );
    }
  });

  unlistenClipChanged = await listen<{ text: string }>("clipboard-changed", (event) => {
    const { uid, paused } = store();
    if (!uid || !device || paused) return;
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

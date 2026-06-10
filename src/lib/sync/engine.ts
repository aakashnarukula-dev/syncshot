/**
 * Sync engine — the realtime brain that ties Firebase to the OS glue.
 *
 * Lives for the lifetime of the (always-alive, possibly hidden) main webview.
 * On start it: ensures an anonymous identity, restores the persisted library,
 * starts Firestore listeners, and wires the Rust-emitted Tauri events
 * (`new-screenshot`, `clipboard-changed`) to the publishers.
 *
 * Pure logic — no React. It reads/writes the zustand sync store directly so
 * any window can render the live state.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useSyncStore } from "@/stores/syncStore";
import { ensureAnonAuth, refreshIdToken } from "./firebase";
import { loadSyncPrefs, saveDeviceName, saveLibId, savePaused } from "./persistence";
import { publishScreenshot, saveReceivedScreenshot, subscribeScreenshots } from "./screenshots";
import { subscribeClipboard, writeClipboardEntry } from "./clipboard";
import type { ClipboardDoc, DeviceRef, ScreenshotDoc } from "./types";

let started = false;
let device: DeviceRef | null = null;

let unsubScreenshots: (() => void) | null = null;
let unsubClipboard: (() => void) | null = null;
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

function handleScreenshots(items: ScreenshotDoc[]): void {
  store().setScreenshots(items);
  const uid = device?.uid;
  for (const item of items) {
    if (
      item.status === "full" &&
      item.fullPath &&
      item.device.uid !== uid &&
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
  unsubClipboard?.();
  unsubClipboard = null;
}

function startListeners(libId: string): void {
  stopListeners();
  unsubScreenshots = subscribeScreenshots(libId, handleScreenshots, (err) =>
    console.error("screenshots listener error:", err),
  );
  unsubClipboard = subscribeClipboard(libId, handleClipboard, (err) =>
    console.error("clipboard listener error:", err),
  );
}

/**
 * Adopt a library (after createLibrary / redeemPairingCode): persist it, force
 * a token refresh so the `libId` claim is live, then start listeners.
 */
export async function adoptLibrary(libId: string): Promise<void> {
  store().setLibId(libId);
  await saveLibId(libId);
  await refreshIdToken();
  startListeners(libId);
}

/** Update the device display name (persisted + reflected in future writes). */
export async function updateDeviceName(name: string): Promise<void> {
  const trimmed = name.trim() || "Mac";
  store().setDeviceName(trimmed);
  if (device) device.name = trimmed;
  await saveDeviceName(trimmed);
}

/** Current device reference (uid/name/platform), or null before auth. */
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

  // Wire OS events up front (cheap, no network) so captures/copies that land
  // before auth completes are simply ignored (libId/device still null).
  unlistenNewShot = await listen<string>("new-screenshot", (event) => {
    const { libId } = store();
    if (libId && device) {
      publishScreenshot(libId, device, event.payload).catch((err) =>
        console.error("publish screenshot failed:", err),
      );
    }
  });

  unlistenClipChanged = await listen<{ text: string }>("clipboard-changed", (event) => {
    const { libId, paused } = store();
    if (!libId || !device || paused) return;
    writeClipboardEntry(libId, device, event.payload.text, recentClipHash)
      .then((hash) => {
        if (hash) recentClipHash = hash;
      })
      .catch((err) => console.error("write clipboard failed:", err));
  });

  try {
    const user = await ensureAnonAuth();
    device = { uid: user.uid, name: store().deviceName, platform: "mac" };
    store().setAuth(user.uid);

    if (prefs.libId) {
      store().setLibId(prefs.libId);
      await refreshIdToken();
      startListeners(prefs.libId);
    }
  } catch (err) {
    store().setAuthError(err instanceof Error ? err.message : String(err));
  }
}

/** Tear down listeners + OS event subscriptions (used on full app teardown). */
export function stopSyncEngine(): void {
  stopListeners();
  unlistenNewShot?.();
  unlistenNewShot = null;
  unlistenClipChanged?.();
  unlistenClipChanged = null;
  started = false;
}

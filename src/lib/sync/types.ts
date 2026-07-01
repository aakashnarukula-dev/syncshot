/**
 * Shared types for the Firebase realtime sync engine.
 *
 * These mirror the Firestore document shapes defined in the binding spec
 * (the CONTRACT). Field names/types here MUST match what the Android and
 * Firebase workers implement to. Do not rename fields without updating the spec.
 */

export type Platform = "mac" | "android";

/** Embedded reference to the device that produced a doc. All devices share one
 *  auth uid (same account); `deviceId` is the per-install identity used to skip
 *  a device's own docs on the receive path. */
export interface DeviceRef {
  uid: string;
  deviceId: string;
  name: string;
  platform: Platform;
}

/**
 * `users/{uid}/screenshots/{id}`
 * `createdAt` is a Firestore server timestamp on the wire; normalized to
 * milliseconds-since-epoch (or null while the server value resolves) in the
 * client store.
 */
export interface ScreenshotDoc {
  id: string;
  sha256: string;
  createdAt: number | null;
  device: DeviceRef;
  width: number;
  height: number;
  bytes: number;
  /** Real image MIME from the uploader (e.g. a phone JPEG is "image/jpeg", not
   *  the "image/png" the Mac always captures). Drives the on-disk extension on
   *  the save/paste/download path so a synced shot gets a Finder/QuickLook
   *  preview — never assume PNG. */
  mime: string;
  thumbPath: string;
  fullPath: string | null;
  status: "thumb" | "full";
}

/**
 * `users/{uid}/clipboard/{id}`
 */
export interface ClipboardDoc {
  id: string;
  text: string;
  hash: string;
  createdAt: number | null;
  device: DeviceRef;
  pinned: boolean;
  charCount: number;
}

/**
 * Cheap identity signature for a screenshot snapshot: covers every field a
 * consumer actually renders/acts on (id, status, createdAt, blob paths) plus
 * the window's hasMore flag. The engine uses it to SKIP the store write for
 * echo snapshots (cache replays, unrelated-field touches) — every skipped
 * write is a full App re-render avoided while uploads/downloads churn.
 */
export function screenshotsSignature(
  items: ScreenshotDoc[],
  hasMore: boolean,
): string {
  let sig = hasMore ? "1" : "0";
  for (const i of items) {
    sig += `|${i.id}:${i.status}:${i.createdAt ?? ""}:${i.thumbPath}:${i.fullPath ?? ""}`;
  }
  return sig;
}

/** Max clipboard text size synced (spec: 100 KB cap to stay well under 1 MB). */
export const CLIPBOARD_MAX_BYTES = 100 * 1024;

/**
 * Screenshot listener paging. The Library grid lazy-loads: it subscribes to a
 * small FIRST window (enough to fill the viewport + a little overscan — the Mac
 * grid shows ~5–12 tiles) and GROWS the live window by one page each time the
 * user scrolls near the bottom (see subscribeScreenshots / its loadMore). This
 * replaces the old fixed limit(100) that fetched + rendered every shot up front
 * and made the user wait.
 */
export const SCREENSHOTS_PAGE_SIZE = 16;
/** Clipboard listener page size (spec). */
export const CLIPBOARD_LIMIT = 200;

/** Thumbnail encode params (spec: 320px max edge, WebP q≈0.70). */
export const THUMB_MAX_EDGE = 320;
export const THUMB_WEBP_QUALITY = 0.7;

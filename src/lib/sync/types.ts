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
  mime: "image/png";
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

/** Max clipboard text size synced (spec: 100 KB cap to stay well under 1 MB). */
export const CLIPBOARD_MAX_BYTES = 100 * 1024;

/** Listener page sizes (spec). */
export const SCREENSHOTS_LIMIT = 100;
export const CLIPBOARD_LIMIT = 200;

/** Thumbnail encode params (spec: 320px max edge, WebP q≈0.70). */
export const THUMB_MAX_EDGE = 320;
export const THUMB_WEBP_QUALITY = 0.7;

/**
 * Pill-column ordering — pure, Firebase-FREE helpers for resolving a local cache
 * file's backing doc and its TRUE creation time, and for ordering the edge
 * "Screenshots" column newest-first.
 *
 * Lives in its own module (NOT screenshots.ts) on purpose: App.tsx imports the
 * column ordering on the startup-critical path, and screenshots.ts transitively
 * pulls in the whole Firebase SDK (~715KB) which the app deliberately defers off
 * first paint. These helpers only touch the zustand store + plain strings, so
 * App.tsx can import them statically without dragging Firebase into the entry
 * chunk. screenshots.ts re-exports `cacheDocId`/`findDocForCachePath` so existing
 * importers keep working.
 */

import { useSyncStore } from "@/stores/syncStore";
import type { ScreenshotDoc } from "./types";

/**
 * The pill column knows screenshots by their local CACHE PATH, not their
 * Firestore id. A screenshot RECEIVED from another device is written to the
 * cache as `{docId}.png` (see `saveReceivedScreenshot`), so its doc id is
 * recoverable from the filename. Locally-captured shots use a generated
 * filename (no embedded id) and return their basename, which simply won't
 * match any doc id — the caller falls back to a content hash.
 */
export function cacheDocId(path: string): string | null {
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const id = dot > 0 ? base.slice(0, dot) : base;
  return id || null;
}

/**
 * Resolve the Firestore screenshot doc backing a local cache PATH, for either
 * kind of cached shot:
 *   • RECEIVED — cached as `{docId}.png`, so the id is in the filename.
 *   • OWN-DEVICE CAPTURE — cached as `shot_{ts}.png` (no embedded id); its doc id
 *     was recorded at publish time in `syncStore.localCaptureDocIds`.
 *
 * Returns the matching loaded `ScreenshotDoc`, or null if neither lookup hits a
 * doc in the current subscription window. This is what lets an own-device shot
 * fall back to its cloud thumb/full (render) and be re-materialized on open —
 * the same safety net synced shots already had — so it never strands on
 * "Unavailable".
 */
export function findDocForCachePath(path: string): ScreenshotDoc | null {
  const { screenshots, localCaptureDocIds } = useSyncStore.getState();
  const byName = cacheDocId(path);
  if (byName) {
    const match = screenshots.find((s) => s.id === byName);
    if (match) return match;
  }
  const mappedId = localCaptureDocIds[path];
  if (mappedId) {
    const match = screenshots.find((s) => s.id === mappedId);
    if (match) return match;
  }
  return null;
}

/**
 * The capture epoch (ms-since-epoch) embedded in an own-capture cache filename
 * `shot_{ts}.png`. `ts` is epoch MILLISECONDS — see Rust `generate_filename`
 * (`get_timestamp().as_millis()`), so it shares one scale with a doc's
 * `createdAt`. null when the name isn't that shape.
 */
function captureTsFromName(path: string): number | null {
  const base = path.split(/[\\/]/).pop() ?? "";
  const m = base.match(/^shot_(\d+)\./);
  if (!m) return null;
  const ms = Number(m[1]);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * A screenshot's TRUE creation time (epoch ms) for column ordering — NOT its
 * local file mtime. Resolution order:
 *   1. the backing doc's server `createdAt` (received shots AND published own
 *      captures — resolved by `{docId}` filename or the capture-path→id map),
 *   2. the capture epoch parsed from an own-capture `shot_{ts}` filename,
 *   3. null — neither resolves (a never-synced legacy file, or a `{docId}` file
 *      whose doc hasn't paged into the live window yet); the caller falls back
 *      to file mtime order.
 *
 * Why not mtime: a synced phone shot is (re)written locally whenever it
 * downloads, so its file mtime is the DOWNLOAD time, not the capture time. On
 * quit/reopen the subscription re-downloads, bumping those files' mtime above an
 * older Mac capture — which is exactly what floated phone shots to the top and
 * sank the Mac's newest shot. The doc `createdAt` is stable across reopen and
 * independent of when a file was last fetched.
 */
export function screenshotCreatedAt(path: string): number | null {
  const doc = findDocForCachePath(path);
  if (doc?.createdAt != null) return doc.createdAt;
  return captureTsFromName(path);
}

/**
 * Order local cache paths NEWEST-FIRST by each screenshot's true creation time
 * (`screenshotCreatedAt`), so the newest shot — Mac or phone — is always on top
 * and the order is STABLE across quit/reopen (it never depends on when a file
 * was last re-downloaded).
 *
 * `paths` arrives mtime-desc from Rust `list_screenshots`, so an item's incoming
 * INDEX is its mtime rank. Items with a resolved creation time sort above
 * mtime-only ones (a known, trustworthy time beats a downloaded-file mtime), and
 * the unresolved tail keeps its mtime order. Pure + deterministic: same inputs →
 * same output, so reopen order == session order.
 */
export function orderScreenshotsByCreatedAt(paths: string[]): string[] {
  const decorated = paths.map((path, index) => ({
    path,
    index,
    ts: screenshotCreatedAt(path),
  }));
  decorated.sort((a, b) => {
    if (a.ts != null && b.ts != null) return b.ts - a.ts; // both known → newest first
    if (a.ts != null) return -1; // a known, b mtime-only → known wins
    if (b.ts != null) return 1;
    return a.index - b.index; // both mtime-only → preserve mtime order
  });
  return decorated.map((d) => d.path);
}

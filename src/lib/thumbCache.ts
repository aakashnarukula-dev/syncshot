/**
 * Module-level thumbnail blob-URL cache + request pipeline for the edge rail.
 *
 * Why module-level: the column used to mint (and revoke) every blob URL inside
 * each tile's effect, so every collapse/re-expand replayed the full
 * IPC → decode → blob cycle for the whole visible column. URLs now live here,
 * survive any mount cycle, and are revoked ONLY on LRU eviction — reopening
 * the rail costs zero IPC for cached thumbs.
 *
 * Request hygiene: at most MAX_INFLIGHT `get_screenshot_thumbnail` calls run at
 * once (Rust gates decodes too, but an unbounded frontend fan-out still floods
 * the IPC channel and keeps abandoned work queued). Requests for tiles that
 * scroll away are cancelled while still queued. There is deliberately NO
 * timeout on the local call: abandoning it left the Rust decode running AND
 * fell through to a per-tile Firebase fetch — the remote fallback is now only
 * taken on a definite local error (the invoke rejecting).
 */

import { invoke } from "@tauri-apps/api/core";
import { LruCache } from "./lruCache";
import { TaskGate } from "./taskGate";

/** Longest side of the cached column thumbnail. ~2x the 240px column width so
 * it stays crisp on Retina while decoding ~50-100x faster than a full shot. */
export const THUMB_MAX_PX = 512;

const CACHE_CAP = 300;
const MAX_INFLIGHT = 5;

/** Definite local-thumbnail failure (Rust rejected) — the only case where the
 * tile may fall back to the remote Firebase URL. */
export class ThumbLocalError extends Error {}

const cache = new LruCache<string, string>(CACHE_CAP, (_path, url) => {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
});
const gate = new TaskGate(MAX_INFLIGHT);

interface InflightEntry {
  promise: Promise<string | null>;
  refs: number;
  cancel: () => void;
}
const inflight = new Map<string, InflightEntry>();

function requestBytes(
  path: string,
  load: () => Promise<ArrayBuffer>,
  mime: string,
): ThumbRequest {
  const cached = cache.get(path);
  if (cached) {
    return { promise: Promise.resolve(cached), release: () => {} };
  }

  let entry = inflight.get(path);
  if (!entry) {
    const handle = gate.schedule(load);
    const promise = handle.promise.then(
      (bytes) => {
        inflight.delete(path);
        if (bytes === null) return null;
        if (bytes.byteLength === 0) throw new ThumbLocalError("empty thumbnail");
        const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
        cache.set(path, url);
        return url;
      },
      (err) => {
        inflight.delete(path);
        throw err instanceof ThumbLocalError ? err : new ThumbLocalError(String(err));
      },
    );
    entry = { promise, refs: 0, cancel: handle.cancel };
    inflight.set(path, entry);
  }

  entry.refs += 1;
  let released = false;
  const tracked = entry;
  return {
    promise: entry.promise,
    release: () => {
      if (released) return;
      released = true;
      tracked.refs -= 1;
      if (tracked.refs <= 0) tracked.cancel();
    },
  };
}

/** Synchronous cache hit (refreshes LRU recency) — lets a remounting tile
 * commit its thumbnail in its initial render, before any effect runs. */
export function getCachedThumbUrl(path: string): string | null {
  return cache.get(path) ?? null;
}

/** Seed an in-memory preview without writing the selected image to disk. */
export function cacheThumbBlob(path: string, blob: Blob): string {
  const url = URL.createObjectURL(blob);
  cache.set(path, url);
  return url;
}

/** Seed a tiny editor-generated preview synchronously across webviews. */
export function cacheThumbDataUrl(path: string, dataUrl: string): string {
  cache.set(path, dataUrl);
  return dataUrl;
}

export interface ThumbRequest {
  /** Resolves to a blob URL, or null if the request was cancelled before it
   * started. Rejects with ThumbLocalError on a definite local failure. */
  promise: Promise<string | null>;
  /** The requesting tile went away. The queued IPC is dropped once no tile
   * still wants this path; an already-running request completes and caches. */
  release: () => void;
}

export function requestThumbUrl(path: string): ThumbRequest {
  return requestBytes(
    path,
    () => invoke<ArrayBuffer>("get_screenshot_thumbnail", { path, maxPx: THUMB_MAX_PX }),
    "image/png",
  );
}

/**
 * Fetch a cloud thumbnail through Rust and keep the resulting blob URL in the
 * same bounded memory cache as local thumbnails. This avoids two WKWebView
 * problems at once: remote image requests no longer compete with full-image
 * prefetches, and a remounted tile paints synchronously from a stable blob URL
 * instead of waiting for a second cross-origin image load/onLoad cycle.
 *
 * `path` includes the screenshot content version, so an edited screenshot can
 * never reuse its predecessor's pixels. No screenshot bytes are persisted.
 */
export function requestRemoteThumbUrl(path: string, url: string): ThumbRequest {
  return requestBytes(
    path,
    () => invoke<ArrayBuffer>("read_remote_image_bytes", { url }),
    "image/webp",
  );
}

/** Warm a local staging screenshot's thumbnail before swapping it into the
 * rail. Keeping the previous tile visible until this resolves removes the
 * editor-save blank/shimmer frame. */
export async function primeThumb(path: string): Promise<string | null> {
  const request = requestThumbUrl(path);
  try {
    return await request.promise;
  } finally {
    request.release();
  }
}

/** Transfer a ready optimistic thumbnail to its stable cloud rail identity. */
export async function cloneThumb(from: string, to: string): Promise<void> {
  // The publisher may already have seeded the destination with its compact
  // WebP. Keep that instead of copying a full-size optimistic import preview.
  if (cache.get(to)) return;
  const source = cache.get(from) ?? await primeThumb(from);
  if (!source) return;
  const blob = await fetch(source).then((response) => response.blob());
  cache.set(to, URL.createObjectURL(blob));
}

/** Shot deleted — drop (and revoke) its cached thumbnail immediately. */
export function dropThumb(path: string): void {
  cache.delete(path);
}

/** Library wiped (sign-out) — drop and revoke everything. */
export function clearThumbs(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Drag icon: ask Rust for the on-disk PATH of the cached thumbnail
// (get_screenshot_thumbnail_path — same cache/pipeline as the bytes command),
// so no bytes cross IPC and nothing is re-encoded. If that command fails, fall
// back to the older blob → dataURL → save_edited_image round-trip against the
// already-fetched thumbnail bytes. Either way the path is memoized per shot —
// a repeat drag of the same shot costs nothing.
// ---------------------------------------------------------------------------

let tempDirPromise: Promise<string> | null = null;
function getTempDir(): Promise<string> {
  if (!tempDirPromise) {
    tempDirPromise = invoke<string>("get_temp_directory").catch((err) => {
      tempDirPromise = null;
      throw err;
    });
  }
  return tempDirPromise;
}

const dragIcons = new Map<string, Promise<string | null>>();

export function ensureDragIconPath(path: string): Promise<string | null> {
  let pending = dragIcons.get(path);
  if (!pending) {
    pending = (async () => {
      try {
        return await invoke<string>("get_screenshot_thumbnail_path", {
          path,
          maxPx: THUMB_MAX_PX,
        });
      } catch {
        // Rust path variant failed — fall back to the byte round-trip below.
      }
      const url = cache.peek(path);
      if (!url) return null;
      const blob = await fetch(url).then((r) => r.blob());
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      const tempDir = await getTempDir();
      const safe = path.replace(/[^a-zA-Z0-9._-]/g, "_");
      return await invoke<string>("save_edited_image", {
        imageData: dataUrl,
        saveDir: tempDir,
        copyToClip: false,
        overwritePath: `${tempDir}/sx-drag-${safe}`,
      });
    })().catch(() => {
      dragIcons.delete(path); // allow a retry on the next drag
      return null;
    });
    dragIcons.set(path, pending);
  }
  return pending;
}

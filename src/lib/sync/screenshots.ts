/**
 * ScreenshotX sync — Firestore listener + thumbnail-first publisher.
 *
 * Publish path (capturing device):
 *   read PNG bytes -> sha256 -> dedupe query -> 320px WebP thumb (canvas)
 *   -> upload thumb -> setDoc(status:'thumb') -> upload full.png
 *   -> updateDoc(status:'full', fullPath, bytes)
 *
 * Receive path: subscribe to the newest 100 screenshots; once status flips to
 * 'full' the engine resolves the full image's tokenized getDownloadURL and asks
 * Rust to HTTP-download the bytes (sidesteps webview CORS — see
 * saveReceivedScreenshot) and save them into the local cache.
 */

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  Timestamp,
  type DocumentData,
} from "firebase/firestore";
import { deleteObject, getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { db, storage } from "./firebase";
import { sha256Hex } from "./hash";
import {
  SCREENSHOTS_PAGE_SIZE,
  THUMB_MAX_EDGE,
  THUMB_WEBP_QUALITY,
  type DeviceRef,
  type ScreenshotDoc,
} from "./types";

function screenshotsCol(uid: string) {
  return collection(db, "users", uid, "screenshots");
}

function tsToMillis(value: unknown): number | null {
  return value instanceof Timestamp ? value.toMillis() : null;
}

function mapDoc(id: string, data: DocumentData): ScreenshotDoc {
  return {
    id,
    sha256: data.sha256 ?? "",
    createdAt: tsToMillis(data.createdAt),
    device: (data.device ?? { uid: "", name: "", platform: "mac" }) as DeviceRef,
    width: data.width ?? 0,
    height: data.height ?? 0,
    bytes: data.bytes ?? 0,
    mime: "image/png",
    thumbPath: data.thumbPath ?? "",
    fullPath: data.fullPath ?? null,
    status: data.status === "full" ? "full" : "thumb",
  };
}

/** Handle to a live, growing screenshot subscription. */
export interface ScreenshotsSubscription {
  /** Stop the realtime listener. */
  unsubscribe: () => void;
  /**
   * Grow the live window by one page (reveals older shots). No-op while a grow
   * is already in flight, or once the end of the collection has been reached.
   */
  loadMore: () => void;
}

/**
 * A live, GROWING subscription to the newest screenshots (createdAt desc).
 *
 * Instead of fetching every shot up front — the old fixed limit(100), which
 * made the user wait while 100+ docs + images loaded — we subscribe to a small
 * first window (SCREENSHOTS_PAGE_SIZE, enough to fill the viewport plus
 * overscan) and grow that window by one page each time `loadMore()` is called
 * (the grid calls it as the user scrolls near the bottom).
 *
 * We grow the `limit` of a SINGLE realtime query rather than stitching together
 * per-page startAfter() cursors: one onSnapshot keeps the WHOLE loaded window
 * live, so a brand-new capture still streams to the TOP and edits/deletes
 * inside the window stay realtime — with none of the manual merge/dedup or
 * page-boundary drift that multiple independent page listeners would incur.
 * Firestore serves the unchanged overlap from its local cache on each grow, so
 * only the newly-revealed older docs cost reads.
 *
 * `onChange` is called with the current window and `hasMore` — true when the
 * window came back full (older shots probably exist beyond it). Once a grow
 * returns fewer docs than requested we've hit the end and `loadMore()` no-ops.
 */
export function subscribeScreenshots(
  uid: string,
  onChange: (items: ScreenshotDoc[], hasMore: boolean) => void,
  onError?: (err: Error) => void,
): ScreenshotsSubscription {
  let windowSize = SCREENSHOTS_PAGE_SIZE;
  let lastSize = 0;
  let growing = false;
  let unsub: (() => void) | null = null;

  const subscribe = () => {
    unsub?.();
    const q = query(
      screenshotsCol(uid),
      orderBy("createdAt", "desc"),
      limit(windowSize),
    );
    unsub = onSnapshot(
      q,
      (snap) => {
        lastSize = snap.size;
        growing = false;
        // A full window implies more (older) docs may exist beyond it.
        const hasMore = snap.size >= windowSize;
        onChange(snap.docs.map((d) => mapDoc(d.id, d.data())), hasMore);
      },
      (err) => {
        growing = false;
        onError?.(err);
      },
    );
  };

  subscribe();

  return {
    unsubscribe: () => {
      unsub?.();
      unsub = null;
    },
    loadMore: () => {
      // Nothing left to fetch if the last window wasn't even full (we already
      // have everything), or a grow is already pending.
      if (growing || lastSize < windowSize) return;
      growing = true;
      windowSize += SCREENSHOTS_PAGE_SIZE;
      subscribe();
    },
  };
}

function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to decode screenshot image"));
    };
    img.src = url;
  });
}

async function makeThumb(
  blob: Blob,
): Promise<{ width: number; height: number; thumb: Blob }> {
  const img = await blobToImage(blob);
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  const ratio = Math.min(THUMB_MAX_EDGE / width, THUMB_MAX_EDGE / height, 1);
  const w = Math.max(1, Math.round(width * ratio));
  const h = Math.max(1, Math.round(height * ratio));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);
  const thumb = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("WebP thumbnail encode failed"))),
      "image/webp",
      THUMB_WEBP_QUALITY,
    );
  });
  return { width, height, thumb };
}

/**
 * Publish a locally-captured screenshot file at `path` to the library.
 * No-op (returns false) if an identical image (same sha256) already exists.
 */
export async function publishScreenshot(
  uid: string,
  device: DeviceRef,
  path: string,
): Promise<boolean> {
  const resp = await fetch(convertFileSrc(path));
  const blob = await resp.blob();
  const buf = await blob.arrayBuffer();
  const sha256 = await sha256Hex(buf);

  // Content-addressed dedup — skip if this exact image is already synced.
  const dupes = await getDocs(
    query(screenshotsCol(uid), where("sha256", "==", sha256), limit(1)),
  );
  if (!dupes.empty) return false;

  const { width, height, thumb } = await makeThumb(blob);

  // Allocate the doc id up front so the Storage path can use it.
  const docRef = doc(screenshotsCol(uid));
  const id = docRef.id;

  const thumbRef = ref(storage, `users/${uid}/screenshots/${id}/thumb.webp`);
  await uploadBytes(thumbRef, thumb, { contentType: "image/webp" });

  await setDoc(docRef, {
    sha256,
    createdAt: serverTimestamp(),
    device,
    width,
    height,
    bytes: blob.size,
    mime: "image/png",
    thumbPath: thumbRef.fullPath,
    fullPath: null,
    status: "thumb",
  });

  const fullRef = ref(storage, `users/${uid}/screenshots/${id}/full.png`);
  await uploadBytes(fullRef, blob, { contentType: "image/png" });

  await updateDoc(docRef, {
    status: "full",
    fullPath: fullRef.fullPath,
    bytes: blob.size,
  });

  return true;
}

/**
 * Resolve a PUBLIC, shareable download URL for a locally-captured screenshot
 * at `path`, uploading it to the library first if it isn't synced yet.
 *
 * Reuses the publisher's content-addressed dedup (same sha256): if a doc for
 * this image already exists with its full.png uploaded, we reuse that Storage
 * object; if only the thumb exists we finish the full upload onto the same doc;
 * otherwise we run the full thumb+doc+full publish. The returned URL carries a
 * long-lived download token that anyone can open (capability, not rule-gated).
 */
export async function shareScreenshotLink(
  uid: string,
  device: DeviceRef,
  path: string,
): Promise<string> {
  const resp = await fetch(convertFileSrc(path));
  const blob = await resp.blob();
  const buf = await blob.arrayBuffer();
  const sha256 = await sha256Hex(buf);

  const dupes = await getDocs(
    query(screenshotsCol(uid), where("sha256", "==", sha256), limit(1)),
  );

  // Already synced: reuse the existing object, finishing the full upload if the
  // earlier publish only got as far as the thumbnail.
  if (!dupes.empty) {
    const existing = dupes.docs[0];
    const data = existing.data();
    if (data.fullPath) {
      return getDownloadURL(ref(storage, data.fullPath as string));
    }
    const fullRef = ref(
      storage,
      `users/${uid}/screenshots/${existing.id}/full.png`,
    );
    await uploadBytes(fullRef, blob, { contentType: "image/png" });
    await updateDoc(existing.ref, {
      status: "full",
      fullPath: fullRef.fullPath,
      bytes: blob.size,
    });
    return getDownloadURL(fullRef);
  }

  // Not synced yet: full publish (mirrors publishScreenshot's thumb-first path).
  const { width, height, thumb } = await makeThumb(blob);

  const docRef = doc(screenshotsCol(uid));
  const id = docRef.id;

  const thumbRef = ref(storage, `users/${uid}/screenshots/${id}/thumb.webp`);
  await uploadBytes(thumbRef, thumb, { contentType: "image/webp" });

  await setDoc(docRef, {
    sha256,
    createdAt: serverTimestamp(),
    device,
    width,
    height,
    bytes: blob.size,
    mime: "image/png",
    thumbPath: thumbRef.fullPath,
    fullPath: null,
    status: "thumb",
  });

  const fullRef = ref(storage, `users/${uid}/screenshots/${id}/full.png`);
  await uploadBytes(fullRef, blob, { contentType: "image/png" });

  await updateDoc(docRef, {
    status: "full",
    fullPath: fullRef.fullPath,
    bytes: blob.size,
  });

  return getDownloadURL(fullRef);
}

/**
 * Persist a received full screenshot to disk via Rust (saves into the local
 * screenshot cache and copies the image to the clipboard). Returns the saved
 * file path.
 *
 * The raw bytes are fetched in RUST, not the webview: we resolve the full
 * image's tokenized `getDownloadURL` (a capability that bypasses Storage rules
 * AND CORS) and hand the URL to the `download_synced_image` command. The
 * webview's `getBytes()`/`getBlob()` would issue a cross-origin XHR the bucket
 * blocks without CORS config, so a 2nd device's upload (e.g. Android) could not
 * be saved here; Rust HTTP is not subject to webview CORS, making cross-device
 * receive work with zero bucket-CORS setup.
 */
export async function saveReceivedScreenshot(
  item: ScreenshotDoc,
): Promise<string> {
  if (!item.fullPath) throw new Error("Screenshot has no full image yet");
  const url = await getDownloadURL(ref(storage, item.fullPath));
  return invoke<string>("download_synced_image", {
    url,
    name: `${item.id}.png`,
  });
}

/**
 * Resolve a tokenized download URL for a Storage object (thumb or full image).
 * The `?token=` is a capability that bypasses Storage security rules AND CORS,
 * so the URL renders directly in an `<img src>` with NO bucket-CORS config —
 * unlike getBytes()/getBlob(), whose cross-origin XHR the bucket blocks without
 * CORS. The webview's CSP img-src must allow firebasestorage.googleapis.com.
 */
export async function storageDownloadUrl(storagePath: string): Promise<string> {
  return getDownloadURL(ref(storage, storagePath));
}

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
 * Backfill the Mac's EXISTING local screenshot library to the cloud on sign-in.
 *
 * The capture-time publisher (`publishScreenshot`, wired to the `new-screenshot`
 * event) only uploads shots taken WHILE signed in. Anything captured before the
 * first sign-in — or before this device ever published — would otherwise never
 * reach `users/{uid}/screenshots`, so a freshly-paired Mac shows up empty on
 * other devices. This walks the local cache and publishes each file.
 *
 * Dedup + idempotency come free: `publishScreenshot` content-addresses by
 * sha256 and no-ops (returns false) when the image is already synced, so
 * re-running this is safe and never double-uploads. Returns the count newly
 * published. A small concurrency pool keeps a large library from issuing
 * hundreds of simultaneous hashes/uploads.
 */
export async function backfillScreenshots(
  uid: string,
  device: DeviceRef,
  paths: string[],
  concurrency = 3,
): Promise<number> {
  let published = 0;
  let next = 0;
  async function worker(): Promise<void> {
    while (next < paths.length) {
      const path = paths[next++];
      try {
        if (await publishScreenshot(uid, device, path)) published++;
      } catch (err) {
        console.error("backfill publish failed:", path, err);
      }
    }
  }
  const workers = Math.max(1, Math.min(concurrency, paths.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return published;
}

/**
 * Delete a screenshot's Firestore doc and BOTH Storage blobs (thumb + full).
 * The deterministic `users/{uid}/screenshots/{id}/{thumb.webp,full.png}` paths
 * are deleted in addition to whatever `thumbPath`/`fullPath` the doc carried, so
 * orphaned/corrupted docs whose fields are missing still get their blobs swept.
 * Storage deletes are best-effort (a missing object is not an error here).
 */
async function deleteDocAndBlobs(
  uid: string,
  id: string,
  thumbPath?: string | null,
  fullPath?: string | null,
): Promise<void> {
  const blobPaths = new Set<string>([
    `users/${uid}/screenshots/${id}/thumb.webp`,
    `users/${uid}/screenshots/${id}/full.png`,
  ]);
  if (thumbPath) blobPaths.add(thumbPath);
  if (fullPath) blobPaths.add(fullPath);
  await Promise.all(
    [...blobPaths].map((p) => deleteObject(ref(storage, p)).catch(() => {})),
  );
  await deleteDoc(doc(screenshotsCol(uid), id));
}

/** Remove the local cache copy of a synced shot (`{id}.png`), if present. */
async function deleteLocalCacheById(id: string): Promise<void> {
  try {
    const dir = await invoke<string>("get_desktop_directory");
    await invoke("delete_file", { path: `${dir}/${id}.png` });
  } catch {
    /* best-effort: no cache copy or dir unavailable */
  }
}

/**
 * Delete a screenshot KNOWN BY ITS DOC (Library grid). Removes the Firestore
 * doc, its Storage blobs, and any local cache copy so it disappears from this
 * device AND every other device's subscription — not just locally.
 */
export async function deleteScreenshotDoc(
  uid: string,
  item: ScreenshotDoc,
): Promise<void> {
  await deleteDocAndBlobs(uid, item.id, item.thumbPath, item.fullPath);
  await deleteLocalCacheById(item.id);
}

/**
 * Delete a screenshot KNOWN BY ITS LOCAL CACHE PATH (pill column).
 *
 * Resolves the matching Firestore doc(s) by content hash — robust for
 * locally-captured shots whose filename carries no doc id — and falls back to
 * the `{id}.png` filename convention when the file is already gone and can't be
 * hashed. Deleting the doc + blobs (not just the local file) is what stops the
 * subscription from re-downloading the shot on the next snapshot, so a deleted
 * tile stays deleted. The local cache file is removed last, after it's been
 * read for the hash.
 */
export async function deleteScreenshotByPath(
  uid: string,
  path: string,
): Promise<void> {
  let matched: { id: string; thumbPath?: string | null; fullPath?: string | null }[] = [];
  try {
    const resp = await fetch(convertFileSrc(path));
    const buf = await resp.arrayBuffer();
    const sha256 = await sha256Hex(buf);
    const snap = await getDocs(
      query(screenshotsCol(uid), where("sha256", "==", sha256)),
    );
    matched = snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        thumbPath: data.thumbPath ?? null,
        fullPath: data.fullPath ?? null,
      };
    });
  } catch (err) {
    console.error("hash-based screenshot lookup failed:", err);
  }

  // File gone / never synced under a hash we can read — fall back to the
  // doc id embedded in a received shot's `{id}.png` cache filename.
  if (matched.length === 0) {
    const id = cacheDocId(path);
    if (id) matched = [{ id }];
  }

  await Promise.all(
    matched.map((m) => deleteDocAndBlobs(uid, m.id, m.thumbPath, m.fullPath)),
  );

  await invoke("delete_file", { path }).catch(() => {});
}

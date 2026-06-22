/**
 * SyncShot sync — Firestore listener + thumbnail-first publisher.
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

import { invoke } from "@tauri-apps/api/core";
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
import { renameCapturePath, useSyncStore } from "@/stores/syncStore";
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

/**
 * Read a LOCAL cache file's raw, full-res bytes via Rust IPC.
 *
 * We do NOT use `fetch(convertFileSrc(path))` here: the RELEASE webview runs on
 * the `http://localhost:38217` origin, which CANNOT CORS-load an `asset://`
 * URL, so that fetch REJECTS for local files in release (it only happened to
 * work in `tauri dev`, whose `tauri://localhost` origin is exempt). Reading the
 * bytes in Rust is origin-independent — works in dev AND release — and is the
 * own-capture twin of how RECEIVED shots already avoid CORS (Rust HTTP fetch in
 * `saveReceivedScreenshot`). `read_image_bytes` returns a `tauri::ipc::Response`
 * so this resolves to an ArrayBuffer, not a JSON number array.
 */
async function readLocalBytes(path: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("read_image_bytes", { path });
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
    // Honor the uploader's REAL type — a phone (e.g. Samsung) screenshot is
    // JPEG (mime "image/jpeg", full.jpg). Forcing "image/png" here is what made
    // the save/paste/download path write `.png` over JPEG bytes → no preview.
    mime: typeof data.mime === "string" && data.mime ? data.mime : "image/png",
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
 * `onChange` is called with the current window, `hasMore` — true when the
 * window came back full (older shots probably exist beyond it; once a grow
 * returns fewer docs than requested we've hit the end and `loadMore()` no-ops) —
 * and `fromCache` (Firestore served this snapshot from its LOCAL cache, not the
 * server). The full-set delete-reconcile must trust ONLY authoritative server
 * snapshots: a from-cache snapshot can momentarily replay a stale/empty set and
 * would wrongly purge still-present shots.
 */
export function subscribeScreenshots(
  uid: string,
  onChange: (items: ScreenshotDoc[], hasMore: boolean, fromCache: boolean) => void,
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
        onChange(
          snap.docs.map((d) => mapDoc(d.id, d.data())),
          hasMore,
          snap.metadata.fromCache,
        );
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
 * Adopt the doc-id filename for a locally-captured cache file: rename its
 * on-disk file IN PLACE from the capture name (`shot_{ts}.png`, no embedded id)
 * to `{docId}.png`, then swap the pill column's path reference to match.
 *
 * This is the real fix for own-device captures showing "Unavailable" / their
 * copy-link copying nothing. The pill column renders LOCAL cache files; a
 * RECEIVED shot is cached as `{docId}.png`, so the tile resolves its backing
 * cloud doc straight from the filename (`cacheDocId` -> `findDocForCachePath`)
 * and the render fallback / copy-link doc lookup / tap-open all work. An own
 * capture was stuck as `shot_{ts}.png` (no id), so those recovery paths had
 * nothing to resolve. Giving it the SAME `{docId}.png` name closes the gap.
 *
 * We RENAME rather than write a SECOND `{docId}.png` (the naive "obvious fix"):
 * the column polls the cache dir, so two files for one capture would DOUBLE the
 * tile. The path swap keeps the live column consistent without the poll
 * mistaking the rename for a brand-new shot. Best-effort: returns the new path,
 * or the original if the rename is a no-op / fails (the path->docId map below
 * still backs the cloud fallback). The bytes are NOT re-read — a rename reuses
 * the file already on disk.
 */
async function adoptDocIdFilename(path: string, docId: string): Promise<string> {
  let newPath = path;
  try {
    newPath = await invoke<string>("rename_screenshot_to_doc_id", { path, docId });
  } catch (err) {
    console.error("adopt doc-id cache filename failed:", path, err);
    newPath = path;
  }
  if (newPath !== path) renameCapturePath(path, newPath);
  useSyncStore.getState().mapLocalCapture(newPath, docId);
  return newPath;
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
  const buf = await readLocalBytes(path);
  const blob = new Blob([buf]);
  const sha256 = await sha256Hex(buf);

  // Content-addressed dedup — skip if this exact image is already synced.
  const dupes = await getDocs(
    query(screenshotsCol(uid), where("sha256", "==", sha256), limit(1)),
  );
  if (!dupes.empty) {
    // Already synced (e.g. backfill re-run): adopt the doc-id cache filename so
    // this own capture resolves its cloud copy by filename, exactly like a
    // received shot (and swap the column path to the renamed file).
    await adoptDocIdFilename(path, dupes.docs[0].id);
    return false;
  }

  const { width, height, thumb } = await makeThumb(blob);

  // Allocate the doc id up front so the Storage path can use it.
  const docRef = doc(screenshotsCol(uid));
  const id = docRef.id;
  // Remember capture-path → doc id immediately so the tile/open-handler can
  // reach the cloud copy during the upload window, before the on-disk file is
  // renamed below (own captures are cached as `shot_{ts}.png` with no embedded
  // id — see syncStore.localCaptureDocIds).
  useSyncStore.getState().mapLocalCapture(path, id);

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

  // Adopt the doc-id cache filename (`shot_{ts}.png` → `{docId}.png`) so the
  // pill column's local file carries the id: tap-open / copy-link / the render
  // fallback all resolve the cloud doc straight from the filename. Done AFTER
  // the doc is created (not at capture time): the renamed file matches
  // RECEIVED_CACHE_ID and so becomes subject to reconcileLocalCache — renaming
  // before the doc exists on the server could let a reconcile snapshot whose
  // keep-set lacks this fresh id delete the just-captured file.
  await adoptDocIdFilename(path, id);

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
  const buf = await readLocalBytes(path);
  const blob = new Blob([buf]);
  const sha256 = await sha256Hex(buf);

  const dupes = await getDocs(
    query(screenshotsCol(uid), where("sha256", "==", sha256), limit(1)),
  );

  // Already synced: reuse the existing object, finishing the full upload if the
  // earlier publish only got as far as the thumbnail.
  if (!dupes.empty) {
    const existing = dupes.docs[0];
    useSyncStore.getState().mapLocalCapture(path, existing.id);
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
  useSyncStore.getState().mapLocalCapture(path, id);

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

/** Image extensions the cache / save / paste path recognizes (lowercase, no
 *  dot). `jpeg` normalizes to `jpg`. Mirrors the Rust sniff set. */
const KNOWN_IMAGE_EXTS: Record<string, string> = {
  png: "png",
  jpg: "jpg",
  jpeg: "jpg",
  gif: "gif",
  webp: "webp",
  heic: "heic",
  heif: "heic",
};

/** Map an image MIME type to its file extension, or null if unrecognized. */
function extFromMime(mime?: string | null): string | null {
  if (!mime) return null;
  const sub = mime.toLowerCase().replace(/^image\//, "");
  return KNOWN_IMAGE_EXTS[sub] ?? null;
}

/** Extract a known image extension from a Storage object path (e.g. the
 *  uploader's `…/full.jpg`), or null if absent/unrecognized. */
function extFromStoragePath(path?: string | null): string | null {
  if (!path) return null;
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  return KNOWN_IMAGE_EXTS[base.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * The on-disk cache filename a received shot should be saved under, deriving the
 * extension from the screenshot's REAL type rather than hardcoding `.png`:
 * `doc.mime` first (the uploader's content type), then the Storage object's own
 * extension (`full.jpg`), falling back to `png`. Rust still re-sniffs the bytes
 * and corrects the extension if needed (see `synced_filename_for`), but starting
 * from the true type means a valid format Rust's magic-byte sniff doesn't cover
 * still lands with a sensible extension — never a JPEG written as `.png` (which
 * is what stripped the Finder/QuickLook preview on phone screenshots).
 */
export function receivedCacheName(item: ScreenshotDoc): string {
  const ext = extFromMime(item.mime) ?? extFromStoragePath(item.fullPath) ?? "png";
  return `${item.id}.${ext}`;
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
    name: receivedCacheName(item),
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
 * Return a LOCAL path whose file is present for the screenshot at `path`, so the
 * editor/preview always has bytes to open. The captured/cached file is used
 * as-is when it exists; if it's gone (e.g. an own-device shot whose local copy
 * was evicted) we re-download the cloud full image into the cache and open that.
 * Falls back to the original path when no cloud doc can be resolved.
 */
export async function ensureLocalScreenshot(path: string): Promise<string> {
  try {
    // Cheap existence probe in Rust — NOT a CORS `asset://` fetch (which always
    // rejects from the release localhost origin, forcing a needless cloud
    // re-download even when the file is right there on disk).
    if (await invoke<boolean>("file_exists", { path })) return path;
  } catch {
    /* probe failed → treat as missing, try the cloud copy below */
  }
  const docMatch = findDocForCachePath(path);
  if (docMatch?.fullPath) {
    try {
      return await saveReceivedScreenshot(docMatch);
    } catch {
      /* download failed — fall through to the original path */
    }
  }
  return path;
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

/** Image extensions a received shot may be cached under. The receive path saves
 *  `{id}.<ext>` where the extension follows the type SNIFFED from the bytes (a
 *  phone JPEG is no longer forced to `.png` — see Rust `persist_synced_image`),
 *  so a delete must try every known extension. */
const CACHE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "heic"] as const;

/** Remove the local cache copy of a synced shot (`{id}.<ext>`), if present.
 *  Tries every known image extension since the cached file's extension follows
 *  its real, sniffed type — not always `.png`. */
export async function deleteLocalCacheById(id: string): Promise<void> {
  try {
    const dir = await invoke<string>("get_desktop_directory");
    await Promise.all(
      CACHE_EXTENSIONS.map((ext) =>
        invoke("delete_file", { path: `${dir}/${id}.${ext}` }).catch(() => {}),
      ),
    );
  } catch {
    /* best-effort: no cache copy or dir unavailable */
  }
}

/**
 * A SYNCED shot's cache file is named `{firestoreDocId}.<ext>`, and a Firestore
 * auto id is exactly 20 chars of [A-Za-z0-9] — no separators. This matches BOTH
 * a received shot AND a published own-device capture, which is renamed from its
 * capture name to `{docId}.<ext>` once it has a backing cloud doc (see
 * `adoptDocIdFilename`). An UNpublished local file — `shot_…` straight from
 * capture, plus `screenshot_…`, `region_…`, `syncshot_…`, `synced_…` — always
 * carries an underscore, so it never matches. The full-set reconcile uses this to
 * delete only files that DO have a cloud doc (and so should follow a cloud
 * delete), never an unpublished local-only capture.
 */
const RECEIVED_CACHE_ID = /^[A-Za-z0-9]{20}$/;

/**
 * FULL-SET cache reconcile against the authoritative server doc set.
 *
 * The per-snapshot reconcile only knew the ids it had SEEN in this session, so a
 * bulk cloud delete left ghost tiles for received shots cached in a PRIOR session
 * (or that had never paged into the live window). This sweeps the actual cache
 * directory: every synced-shot file (`{docId}.<ext>`) whose doc id is absent
 * from `keepIds` is gone from the server and its local copy is deleted, so the
 * edge rail (which polls the cache dir) drops it. Files carrying a cloud doc id
 * are touched (see RECEIVED_CACHE_ID) — received shots AND published own captures
 * (renamed to `{docId}.<ext>`), so a deleted own shot also drops; an UNpublished
 * local capture (`shot_…`) is never removed.
 *
 * MUST be called only with the set from an AUTHORITATIVE, COMPLETE server
 * snapshot (not Firestore's local cache, and not a capped/`hasMore` window), or
 * a still-present shot would be wrongly purged.
 */
export async function reconcileLocalCache(keepIds: Set<string>): Promise<void> {
  try {
    const dir = await invoke<string>("get_desktop_directory");
    const files = await invoke<string[]>("list_screenshots", { dir });
    const stale = files.filter((p) => {
      const id = cacheDocId(p);
      return id !== null && RECEIVED_CACHE_ID.test(id) && !keepIds.has(id);
    });
    await Promise.all(
      stale.map((p) => invoke("delete_file", { path: p }).catch(() => {})),
    );
  } catch {
    /* best-effort: cache dir unavailable or list failed */
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
    const buf = await readLocalBytes(path);
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

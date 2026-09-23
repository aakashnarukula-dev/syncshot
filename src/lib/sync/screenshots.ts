/**
 * SyncShot sync — Firestore listener + thumbnail-first publisher.
 *
 * Publish path (capturing device):
 *   read PNG bytes -> sha256 -> dedupe query -> 320px WebP thumb (canvas)
 *   -> upload thumb -> setDoc(status:'thumb') -> upload full.png
 *   -> updateDoc(status:'full', fullPath, bytes)
 *
 * Receive path: subscribe to a small newest-first page. Tiles stream the tiny
 * cloud thumbnail directly; full bytes are fetched only for explicit actions.
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
import {
  cloudScreenshotId,
  cloudScreenshotPath,
  isCloudScreenshotPath,
  isSyncedCacheFile,
} from "./order";
import { db, storage } from "./firebase";
import { sha256Hex } from "./hash";
import { makeThumb } from "./thumbs";
import { createDownloadUrlCache } from "./downloadUrlCache";
import { cacheThumbBlob, requestRemoteThumbUrl } from "@/lib/thumbCache";
import { RAIL_THUMB_BUFFER } from "@/lib/railWindow";
import {
  SCREENSHOTS_PAGE_SIZE,
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
    thumbUrl: data.thumbUrl ?? null,
    fullPath: data.fullPath ?? null,
    fullUrl: data.fullUrl ?? null,
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
async function adoptCloudIdentity(path: string, docId: string, version?: string): Promise<string> {
  const cloudPath = cloudScreenshotPath(docId, version);
  useSyncStore.getState().mapLocalCapture(path, docId);
  renameCapturePath(path, cloudPath);
  return cloudPath;
}

/** What a publish attempt resolved to — used by backfill to feed its ledger. */
interface PublishOutcome {
  /** True when a NEW doc was created (false = sha256 dupe no-op). */
  published: boolean;
  /** The backing cloud doc id (new or pre-existing dupe). */
  docId: string;
  sha256: string;
  /** The file's path AFTER the doc-id rename (== input path if rename failed). */
  finalPath: string;
}

const IMPORT_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

function normalizedImageMime(mime: string): string {
  const normalized = mime.toLowerCase();
  if (!IMPORT_IMAGE_MIMES.has(normalized)) {
    throw new Error("Choose a PNG, JPEG, GIF, or WebP image");
  }
  return normalized;
}

function extensionForMime(mime: string): string {
  if (mime === "image/jpeg") return "jpg";
  return mime.slice("image/".length);
}

function readBlobArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error("Could not read image"));
    reader.readAsArrayBuffer(blob);
  });
}

async function publishBlobDetailed(
  uid: string,
  device: DeviceRef,
  path: string,
  buf: ArrayBuffer,
  blob: Blob,
  mime: string,
  eagerThumb = true,
  adoptAfterFull = false,
): Promise<PublishOutcome> {
  const shaPromise = sha256Hex(buf);
  const thumbPromise = eagerThumb ? makeThumb(blob) : null;
  const sha256 = await shaPromise;

  const dupes = await getDocs(
    query(screenshotsCol(uid), where("sha256", "==", sha256), limit(1)),
  );
  if (!dupes.empty) {
    const existing = dupes.docs[0];
    const existingData = typeof existing.data === "function" ? existing.data() : {};
    const version = (existingData.sha256 as string | undefined) ?? sha256;
    const cloudPath = cloudScreenshotPath(existing.id, version);
    const preview = thumbPromise ? await thumbPromise.catch(() => null) : null;
    if (preview) cacheThumbBlob(cloudPath, preview.thumb);
    const finalPath = await adoptCloudIdentity(path, existing.id, version);
    return { published: false, docId: existing.id, sha256, finalPath };
  }

  const { width, height, thumb } = await (thumbPromise ?? makeThumb(blob));
  const docRef = doc(screenshotsCol(uid));
  const id = docRef.id;
  useSyncStore.getState().mapLocalCapture(path, id);

  const thumbRef = ref(storage, `users/${uid}/screenshots/${id}/thumb.webp`);
  await uploadBytes(thumbRef, thumb, { contentType: "image/webp" });
  const thumbUrlPromise = getDownloadURL(thumbRef);

  const cloudPath = cloudScreenshotPath(id, sha256);
  cacheThumbBlob(cloudPath, thumb);
  let finalPath = cloudPath;

  await setDoc(docRef, {
    sha256,
    createdAt: serverTimestamp(),
    device,
    width,
    height,
    bytes: blob.size,
    mime,
    thumbPath: thumbRef.fullPath,
    thumbUrl: null,
    fullPath: null,
    fullUrl: null,
    status: "thumb",
  });

  // Keep the optimistic staging identity until Firestore contains its cloud
  // replacement. Renaming before setDoc let the rail synchronizer observe a
  // cloud path absent from the snapshot and briefly remove it (or show both).
  if (!adoptAfterFull) finalPath = await adoptCloudIdentity(path, id, sha256);

  const ext = extensionForMime(mime);
  const fullRef = ref(storage, `users/${uid}/screenshots/${id}/full.${ext}`);
  const fullUpload = uploadBytes(fullRef, blob, { contentType: mime });
  const thumbUrl = await thumbUrlPromise;
  await updateDoc(docRef, { thumbUrl });
  await fullUpload;
  const fullUrl = await getDownloadURL(fullRef);

  await updateDoc(docRef, {
    status: "full",
    fullPath: fullRef.fullPath,
    fullUrl,
    bytes: blob.size,
  });

  if (adoptAfterFull) finalPath = await adoptCloudIdentity(path, id, sha256);
  return { published: true, docId: id, sha256, finalPath };
}

export interface PublishScreenshotResult {
  published: boolean;
  docId: string;
  cloudPath: string;
}

async function publishScreenshotDetailed(
  uid: string,
  device: DeviceRef,
  path: string,
  eagerThumb = true,
  adoptAfterFull = false,
): Promise<PublishOutcome> {
  const buf = await readLocalBytes(path);
  return publishBlobDetailed(
    uid,
    device,
    path,
    buf,
    new Blob([buf], { type: "image/png" }),
    "image/png",
    eagerThumb,
    adoptAfterFull,
  );
}

/** Upload a manually selected image straight from browser memory. The source
 * file is never copied into SyncShot's Application Support directory. */
export async function publishImportedImage(
  uid: string,
  device: DeviceRef,
  stagingPath: string,
  file: File,
): Promise<PublishScreenshotResult> {
  const mime = normalizedImageMime(file.type);
  const buf = await readBlobArrayBuffer(file);
  const outcome = await publishBlobDetailed(
    uid,
    device,
    stagingPath,
    buf,
    file,
    mime,
    true,
    true,
  );
  return {
    published: outcome.published,
    docId: outcome.docId,
    cloudPath: outcome.finalPath,
  };
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
  const outcome = await publishScreenshotDetailed(uid, device, path, true, true);
  // Captures and editor exports are staging files only. Firebase is the
  // screenshot library; remove the staging file after full upload/dedupe.
  await invoke("delete_file", { path }).catch(() => {});
  return outcome.published;
}

/** Publish an editor replacement and reveal which cloud document owns it.
 * The doc id matters when the edited bytes dedupe to the original: callers
 * must not delete that same document after the upload resolves. */
export async function publishScreenshotReplacement(
  uid: string,
  device: DeviceRef,
  path: string,
): Promise<PublishScreenshotResult> {
  const outcome = await publishScreenshotDetailed(uid, device, path, true, true);
  await invoke("delete_file", { path }).catch(() => {});
  return {
    published: outcome.published,
    docId: outcome.docId,
    cloudPath: outcome.finalPath,
  };
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
  const cloudDoc = findDocForCachePath(path);
  if (cloudDoc?.fullPath) return cloudDoc.fullUrl ?? downloadUrls.get(cloudDoc.fullPath);
  if (isCloudScreenshotPath(path)) {
    throw new Error("Screenshot is still uploading");
  }
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
      return downloadUrls.get(data.fullPath as string);
    }
    const fullRef = ref(
      storage,
      `users/${uid}/screenshots/${existing.id}/full.png`,
    );
    await uploadBytes(fullRef, blob, { contentType: "image/png" });
    const fullUrl = await getDownloadURL(fullRef);
    await updateDoc(existing.ref, {
      status: "full",
      fullPath: fullRef.fullPath,
      fullUrl,
      bytes: blob.size,
    });
    return fullUrl;
  }

  // Not synced yet: full publish (mirrors publishScreenshot's thumb-first path).
  const { width, height, thumb } = await makeThumb(blob);

  const docRef = doc(screenshotsCol(uid));
  const id = docRef.id;
  useSyncStore.getState().mapLocalCapture(path, id);

  const thumbRef = ref(storage, `users/${uid}/screenshots/${id}/thumb.webp`);
  await uploadBytes(thumbRef, thumb, { contentType: "image/webp" });
  const thumbUrlPromise = getDownloadURL(thumbRef);

  await setDoc(docRef, {
    sha256,
    createdAt: serverTimestamp(),
    device,
    width,
    height,
    bytes: blob.size,
    mime: "image/png",
    thumbPath: thumbRef.fullPath,
    thumbUrl: null,
    fullPath: null,
    fullUrl: null,
    status: "thumb",
  });

  const fullRef = ref(storage, `users/${uid}/screenshots/${id}/full.png`);
  const fullUpload = uploadBytes(fullRef, blob, { contentType: "image/png" });
  const thumbUrl = await thumbUrlPromise;
  await updateDoc(docRef, { thumbUrl });
  await fullUpload;
  const fullUrl = await getDownloadURL(fullRef);

  await updateDoc(docRef, {
    status: "full",
    fullPath: fullRef.fullPath,
    fullUrl,
    bytes: blob.size,
  });

  return fullUrl;
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
 * Materialize a received full screenshot in the system temp directory for a
 * short-lived native operation. No persistent SyncShot cache is written.
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
  const url = await downloadUrls.get(item.fullPath);
  try {
    return await invoke<string>("download_temporary_image", {
      url,
      name: receivedCacheName(item),
    });
  } catch (err) {
    // The cached URL may be stale (object replaced/revoked) — drop it so the
    // caller's retry resolves a fresh one.
    downloadUrls.invalidate(item.fullPath);
    throw err;
  }
}

/**
 * Module-level download-URL cache: tokenized URLs are long-lived capabilities,
 * so N tiles resolving the same Storage path within an hour cost ONE RPC
 * total (in-flight dedup included) instead of one per tile per mount.
 */
const downloadUrls = createDownloadUrlCache((p) => getDownloadURL(ref(storage, p)));
const pendingThumbUrlBackfills = new Set<string>();

/** Upgrade older visible docs with direct thumbnail/full URLs. This only
 * resolves Storage metadata; it does not download or persist image bytes.
 * Later rail paints and editor opens skip Storage RPCs entirely. */
export function backfillScreenshotThumbUrls(uid: string, items: ScreenshotDoc[]): void {
  // Match the five-item viewport plus one warm item. Resolving the entire page
  // at once would slow visible thumbnails through avoidable contention.
  for (const item of items.slice(0, 6)) {
    const needsThumb = !!item.thumbPath && !item.thumbUrl;
    const needsFull = !!item.fullPath && !item.fullUrl;
    if ((!needsThumb && !needsFull) || pendingThumbUrlBackfills.has(item.id)) continue;
    pendingThumbUrlBackfills.add(item.id);
    const thumb = needsThumb
      ? storageDownloadUrl(item.thumbPath, item.sha256)
      : Promise.resolve(item.thumbUrl ?? null);
    const full = needsFull
      ? storageDownloadUrl(item.fullPath!, item.sha256)
      : Promise.resolve(item.fullUrl ?? null);
    void Promise.all([thumb, full])
      .then(([thumbUrl, fullUrl]) => {
        const patch: { thumbUrl?: string; fullUrl?: string } = {};
        if (needsThumb && thumbUrl) patch.thumbUrl = thumbUrl;
        if (needsFull && fullUrl) patch.fullUrl = fullUrl;
        return Object.keys(patch).length > 0
          ? updateDoc(doc(screenshotsCol(uid), item.id), patch)
          : undefined;
      })
      .catch(() => {})
      .finally(() => pendingThumbUrlBackfills.delete(item.id));
  }
}

/**
 * Resolve a tokenized download URL for a Storage object (thumb or full image).
 * The `?token=` is a capability that bypasses Storage security rules AND CORS,
 * so the URL renders directly in an `<img src>` with NO bucket-CORS config —
 * unlike getBytes()/getBlob(), whose cross-origin XHR the bucket blocks without
 * CORS. The webview's CSP img-src must allow firebasestorage.googleapis.com.
 *
 * Cached (~1h TTL + in-flight dedup) — call freely per tile render.
 */
export async function storageDownloadUrl(
  storagePath: string,
  contentVersion?: string,
): Promise<string> {
  const url = await downloadUrls.get(storagePath);
  if (!contentVersion) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}syncshotVersion=${encodeURIComponent(contentVersion)}`;
}

// Five screenshots fit in the rail. Keep three more tiny thumbnails hot below
// the viewport, while full-resolution bytes are buffered only for the visible
// five. This is deliberately independent from Firestore's metadata page size:
// loading 16 lightweight docs is cheap; downloading 16 multi-megabyte images
// before the user can see five is not.
export const RAIL_VISIBLE_SCREENSHOTS = 5;
export const RAIL_THUMB_BUFFER_SCREENSHOTS = RAIL_THUMB_BUFFER;
const MAX_RECENT_FULL_IMAGES = 16;

const prefetchedFullImages = new Map<string, true>();
let pendingFullUrls: string[] = [];
let fullPreloadRunning = false;
let fullPreloadDrain: Promise<void> = Promise.resolve();
let imagePreloadGeneration = 0;

function rememberFullImage(url: string): void {
  prefetchedFullImages.delete(url);
  prefetchedFullImages.set(url, true);
  while (prefetchedFullImages.size > MAX_RECENT_FULL_IMAGES) {
    const oldest = prefetchedFullImages.keys().next().value as string | undefined;
    if (!oldest) break;
    prefetchedFullImages.delete(oldest);
  }
}

function hasFullImage(url: string): boolean {
  if (!prefetchedFullImages.has(url)) return false;
  rememberFullImage(url);
  return true;
}

function versionedDirectUrl(url: string, version: string): string {
  if (!version || url.includes("syncshotVersion=")) return url;
  return `${url}${url.includes("?") ? "&" : "?"}syncshotVersion=${encodeURIComponent(version)}`;
}

/** Resolve exact versioned thumbnail URL used by both rail preloader and
 * editor. Sharing one resolver matters because Rust's RAM cache is URL-keyed:
 * an unversioned editor URL would miss bytes already warmed under the
 * versioned URL and download the same image again on click. */
export async function resolveScreenshotThumbnailUrl(
  item: ScreenshotDoc,
): Promise<string | null> {
  if (item.thumbPath) {
    return item.thumbUrl
      ? versionedDirectUrl(item.thumbUrl, item.sha256)
      : storageDownloadUrl(item.thumbPath, item.sha256);
  }
  // Legacy documents predate cloud thumbnails. They remain lazy and bounded,
  // but use the full object as a last-resort source until rewritten by an edit.
  if (!item.fullPath) return null;
  return item.fullUrl
    ? versionedDirectUrl(item.fullUrl, item.sha256)
    : storageDownloadUrl(item.fullPath, item.sha256);
}

/** Resolve exact versioned full-image URL shared by prefetch, open, and copy. */
export async function resolveScreenshotFullImageUrl(
  item: ScreenshotDoc,
): Promise<string | null> {
  if (item.status !== "full" || !item.fullPath) return null;
  return item.fullUrl
    ? versionedDirectUrl(item.fullUrl, item.sha256)
    : storageDownloadUrl(item.fullPath, item.sha256);
}

async function primeCloudThumbnail(item: ScreenshotDoc): Promise<void> {
  const url = await resolveScreenshotThumbnailUrl(item);
  if (!url) return;
  const request = requestRemoteThumbUrl(
    cloudScreenshotPath(item.id, item.sha256),
    url,
  );
  try {
    await request.promise;
  } finally {
    request.release();
  }
}

function scheduleFullImageBuffer(urls: string[], generation: number): void {
  const next = urls.filter((url) => !hasFullImage(url));
  if (next.length === 0 || generation !== imagePreloadGeneration) return;

  // Coalesce rapid scroll events. One active viewport may finish; any queued
  // intermediate viewports are replaced by the newest one instead of forming
  // an unbounded download queue behind the user's scroll position.
  pendingFullUrls = [...new Set(next)];
  if (fullPreloadRunning) return;

  fullPreloadRunning = true;
  fullPreloadDrain = (async () => {
    try {
      while (pendingFullUrls.length > 0) {
        const batch = pendingFullUrls;
        pendingFullUrls = [];
        if (generation !== imagePreloadGeneration) continue;
        try {
          const warmed = await invoke<string[]>("prefetch_remote_images", { urls: batch });
          if (generation !== imagePreloadGeneration) continue;
          for (const url of warmed) rememberFullImage(url);
        } catch {
          // A future viewport entry retries; failures are never marked warm.
        }
      }
    } finally {
      fullPreloadRunning = false;
    }
  })();
}

/**
 * Prime one rail viewport, not the whole Firestore page. Visible thumbnails
 * enter the shared five-wide request gate first; three following thumbnails
 * form the scroll buffer. Only after the visible thumbnails settle do the five
 * nearby full images enter Rust's bounded RAM cache for instant open/copy.
 */
export function preloadScreenshotImages(
  items: ScreenshotDoc[],
  visibleCount = RAIL_VISIBLE_SCREENSHOTS,
): void {
  const generation = imagePreloadGeneration;
  const visible = items.slice(0, Math.max(0, visibleCount));
  const buffer = items.slice(
    visible.length,
    visible.length + RAIL_THUMB_BUFFER_SCREENSHOTS,
  );

  // Calling in this order enqueues all visible items ahead of buffer work.
  const visibleThumbs = visible.map((item) => primeCloudThumbnail(item));
  for (const item of buffer) void primeCloudThumbnail(item).catch(() => {});

  void Promise.allSettled(visibleThumbs).then(async () => {
    if (generation !== imagePreloadGeneration) return;
    const fullUrls = (await Promise.all(
      visible.map((item) => resolveScreenshotFullImageUrl(item).catch(() => null)),
    )).filter((url): url is string => !!url);
    scheduleFullImageBuffer(fullUrls, generation);
  });
}

/** Prime the live virtual window after scroll. Visible paths come first, then
 * the overscan paths; local/import staging entries are ignored. */
export function preloadScreenshotPaths(
  visiblePaths: string[],
  bufferedPaths: string[],
): void {
  const visible = visiblePaths
    .map((path) => findDocForCachePath(path))
    .filter((item): item is ScreenshotDoc => !!item);
  const visibleIds = new Set(visible.map((item) => item.id));
  const buffer = bufferedPaths
    .map((path) => findDocForCachePath(path))
    .filter((item): item is ScreenshotDoc => !!item && !visibleIds.has(item.id));
  preloadScreenshotImages(
    [...visible, ...buffer.slice(0, RAIL_THUMB_BUFFER_SCREENSHOTS)],
    visible.length,
  );
}

/** Clear all image buffers at an auth boundary. Serialized after outstanding
 * prefetch work so an old-account request cannot repopulate the native cache
 * after it was cleared. */
export function clearPreloadedScreenshotImages(): void {
  imagePreloadGeneration += 1;
  pendingFullUrls = [];
  prefetchedFullImages.clear();
  fullPreloadDrain = fullPreloadDrain
    .catch(() => {})
    .then(async () => {
      await invoke("clear_remote_image_cache").catch(() => {});
    });
}

/** Copy full-resolution screenshot bytes to NSPasteboard without persisting a
 * Mac cache file. Local staging captures still use the existing file command. */
export async function copyScreenshotToClipboard(path: string): Promise<void> {
  const item = findDocForCachePath(path);
  if (item?.fullPath) {
    const url = await resolveScreenshotFullImageUrl(item);
    if (!url) throw new Error("Screenshot is still uploading");
    await invoke("copy_remote_image_to_clipboard", { url });
    return;
  }
  if (isCloudScreenshotPath(path)) {
    throw new Error("Screenshot is still uploading");
  }
  try {
    await invoke("copy_to_clipboard", { path });
  } catch (localError) {
    // A local capture/editor export is only staging. If its Firebase publisher
    // removed it between tile click and native fs::read, retry from the cloud
    // document that replaced it instead of making the copy action flaky.
    const replacement = findDocForCachePath(path);
    if (!replacement?.fullPath) throw localError;
    const url = await resolveScreenshotFullImageUrl(replacement);
    if (!url) throw localError;
    await invoke("copy_remote_image_to_clipboard", { url });
  }
}

/** Save the original full-resolution image to the user's Downloads directory.
 * Cloud screenshots stay cloud-only until this explicit user action and reuse
 * the native in-memory preload buffer instead of downloading through WebKit. */
export async function downloadScreenshotToDownloads(path: string): Promise<string> {
  const saveCloudItem = async (item: ScreenshotDoc): Promise<string> => {
    const url = await resolveScreenshotFullImageUrl(item);
    if (!url) throw new Error("Screenshot is still uploading");
    return invoke<string>("save_image_to_downloads", {
      path: null,
      url,
      name: `SyncShot-${receivedCacheName(item)}`,
    });
  };

  const item = findDocForCachePath(path);
  if (item?.fullPath) return saveCloudItem(item);
  if (isCloudScreenshotPath(path)) {
    throw new Error("Screenshot is still uploading");
  }

  const name = path.split(/[\\/]/).pop() || "SyncShot.png";
  try {
    return await invoke<string>("save_image_to_downloads", {
      path,
      url: null,
      name,
    });
  } catch (localError) {
    // Publisher may remove a staging file between click and native read. Retry
    // from its replacement cloud document, matching copy/open race handling.
    const replacement = findDocForCachePath(path);
    if (!replacement?.fullPath) throw localError;
    return saveCloudItem(replacement);
  }
}

/** Drop a cached download URL (e.g. after a consumer's <img> load 404'd). */
export function invalidateStorageDownloadUrl(storagePath: string): void {
  downloadUrls.invalidate(storagePath);
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
  const cloudId = cloudScreenshotId(path);
  if (cloudId) return cloudId;
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
const temporaryCloudFiles = new Map<string, Promise<string>>();

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
    const ownStagingPath = Object.entries(useSyncStore.getState().localCaptureDocIds)
      .find(([, id]) => id === docMatch.id)?.[0];
    if (ownStagingPath) {
      try {
        if (await invoke<boolean>("file_exists", { path: ownStagingPath })) {
          return ownStagingPath;
        }
      } catch {
        /* staging probe failed → use cloud materialization below */
      }
    }
    let pending = temporaryCloudFiles.get(path);
    if (!pending) {
      pending = (async () => {
        const url = await resolveScreenshotFullImageUrl(docMatch);
        if (!url) throw new Error("Screenshot is still uploading");
        const localPath = await invoke<string>("download_temporary_image", {
          url,
          name: receivedCacheName(docMatch),
        });
        useSyncStore.getState().mapLocalCapture(localPath, docMatch.id);
        return localPath;
      })().catch((error) => {
        temporaryCloudFiles.delete(path);
        throw error;
      });
      temporaryCloudFiles.set(path, pending);
    }
    try {
      return await pending;
    } catch {
      /* download failed — fall through to the cloud identity */
    }
  }
  return path;
}

/** Release a native-action materialization and allow a later drag to fetch a
 * fresh file. Safe to call repeatedly for duplicate drag-end notifications. */
export async function releaseTemporaryScreenshot(
  cloudPath: string,
  localPath: string,
): Promise<void> {
  temporaryCloudFiles.delete(cloudPath);
  await invoke("delete_file", { path: localPath }).catch(() => {});
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
 * Dedup + idempotency come free: publishing content-addresses by sha256, so
 * re-running this is safe and never double-uploads. Successfully migrated
 * files are deleted; failures stay available for retry. Returns the count newly
 * published. A small concurrency pool bounds simultaneous work.
 *
 * PERF: files already named `{docId}.<ext>` (received shots AND published own
 * captures — renamed on publish) PROVABLY have a cloud doc, so they're skipped
 * up front. Without this filter every launch re-read the ENTIRE library's
 * bytes over IPC and re-hashed + dupe-queried each file (multi-GB of reads for
 * a few-hundred-shot library) just to no-op — the single biggest source of
 * "everything is laggy right after the rail opens". Only genuinely unpublished
 * names (`shot_…` etc.) are still checked, uploaded, and removed.
 */
export async function backfillScreenshots(
  uid: string,
  device: DeviceRef,
  allPaths: string[],
  concurrency = 3,
): Promise<number> {
  const candidates = allPaths.filter((p) => !isSyncedCacheFile(p));
  if (candidates.length === 0) return 0;

  let published = 0;
  let next = 0;
  async function worker(): Promise<void> {
    while (next < candidates.length) {
      const path = candidates[next++];
      try {
        // Backfill is duplicate-heavy by definition; never speculatively decode
        // thumbnails for files whose sha256 query will short-circuit.
        const outcome = await publishScreenshotDetailed(uid, device, path, false);
        if (outcome.published) published++;
        await invoke("delete_file", { path }).catch(() => {});
      } catch (err) {
        console.error("backfill publish failed:", path, err);
      }
    }
  }
  const workers = Math.max(1, Math.min(concurrency, candidates.length));
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
    `users/${uid}/screenshots/${id}/full.jpg`,
    `users/${uid}/screenshots/${id}/full.gif`,
    `users/${uid}/screenshots/${id}/full.webp`,
  ]);
  if (thumbPath) blobPaths.add(thumbPath);
  if (fullPath) blobPaths.add(fullPath);
  for (const p of blobPaths) downloadUrls.invalidate(p);
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
  const direct = findDocForCachePath(path);
  if (direct) {
    await deleteDocAndBlobs(uid, direct.id, direct.thumbPath, direct.fullPath);
    if (!isCloudScreenshotPath(path)) {
      await invoke("delete_file", { path }).catch(() => {});
    }
    return;
  }
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

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
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { db, storage } from "./firebase";
import { sha256Hex } from "./hash";
import {
  SCREENSHOTS_LIMIT,
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

/**
 * Subscribe to the newest screenshots (createdAt desc, limit 100). Returns an
 * unsubscribe function.
 */
export function subscribeScreenshots(
  uid: string,
  onChange: (items: ScreenshotDoc[]) => void,
  onError?: (err: Error) => void,
): () => void {
  const q = query(
    screenshotsCol(uid),
    orderBy("createdAt", "desc"),
    limit(SCREENSHOTS_LIMIT),
  );
  return onSnapshot(
    q,
    (snap) => onChange(snap.docs.map((d) => mapDoc(d.id, d.data()))),
    (err) => onError?.(err),
  );
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

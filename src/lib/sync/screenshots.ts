/**
 * ScreenshotX sync — Firestore listener + thumbnail-first publisher.
 *
 * Publish path (capturing device):
 *   read PNG bytes -> sha256 -> dedupe query -> 320px WebP thumb (canvas)
 *   -> upload thumb -> setDoc(status:'thumb') -> upload full.png
 *   -> updateDoc(status:'full', fullPath, bytes)
 *
 * Receive path: subscribe to the newest 100 screenshots; the engine downloads
 * the full image once status flips to 'full' and hands the bytes to Rust.
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
import { getBytes, getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { db, storage } from "./firebase";
import { sha256Hex } from "./hash";
import {
  SCREENSHOTS_LIMIT,
  THUMB_MAX_EDGE,
  THUMB_WEBP_QUALITY,
  type DeviceRef,
  type ScreenshotDoc,
} from "./types";

function screenshotsCol(libId: string) {
  return collection(db, "libraries", libId, "screenshots");
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
  libId: string,
  onChange: (items: ScreenshotDoc[]) => void,
  onError?: (err: Error) => void,
): () => void {
  const q = query(
    screenshotsCol(libId),
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
  libId: string,
  device: DeviceRef,
  path: string,
): Promise<boolean> {
  const resp = await fetch(convertFileSrc(path));
  const blob = await resp.blob();
  const buf = await blob.arrayBuffer();
  const sha256 = await sha256Hex(buf);

  // Content-addressed dedup — skip if this exact image is already synced.
  const dupes = await getDocs(
    query(screenshotsCol(libId), where("sha256", "==", sha256), limit(1)),
  );
  if (!dupes.empty) return false;

  const { width, height, thumb } = await makeThumb(blob);

  // Allocate the doc id up front so the Storage path can use it.
  const docRef = doc(screenshotsCol(libId));
  const id = docRef.id;

  const thumbRef = ref(storage, `libraries/${libId}/screenshots/${id}/thumb.webp`);
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

  const fullRef = ref(storage, `libraries/${libId}/screenshots/${id}/full.png`);
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
  libId: string,
  device: DeviceRef,
  path: string,
): Promise<string> {
  const resp = await fetch(convertFileSrc(path));
  const blob = await resp.blob();
  const buf = await blob.arrayBuffer();
  const sha256 = await sha256Hex(buf);

  const dupes = await getDocs(
    query(screenshotsCol(libId), where("sha256", "==", sha256), limit(1)),
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
      `libraries/${libId}/screenshots/${existing.id}/full.png`,
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

  const docRef = doc(screenshotsCol(libId));
  const id = docRef.id;

  const thumbRef = ref(storage, `libraries/${libId}/screenshots/${id}/thumb.webp`);
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

  const fullRef = ref(storage, `libraries/${libId}/screenshots/${id}/full.png`);
  await uploadBytes(fullRef, blob, { contentType: "image/png" });

  await updateDoc(docRef, {
    status: "full",
    fullPath: fullRef.fullPath,
    bytes: blob.size,
  });

  return getDownloadURL(fullRef);
}

/** Download Storage bytes at `fullPath` (a `libraries/.../full.png` path). */
export async function downloadStorageBytes(fullPath: string): Promise<Uint8Array> {
  const ab = await getBytes(ref(storage, fullPath));
  return new Uint8Array(ab);
}

/**
 * Persist a received full screenshot to disk via Rust (saves into the
 * ScreenshotX folder and copies the image to the clipboard). Returns the saved
 * file path.
 */
export async function saveReceivedScreenshot(
  item: ScreenshotDoc,
): Promise<string> {
  if (!item.fullPath) throw new Error("Screenshot has no full image yet");
  const bytes = await downloadStorageBytes(item.fullPath);
  return invoke<string>("save_synced_image", {
    bytes: Array.from(bytes),
    name: `${item.id}.png`,
  });
}

/** Build a blob-URL preview of a screenshot's WebP thumbnail (CSP-safe). */
export async function loadThumbObjectUrl(thumbPath: string): Promise<string> {
  const bytes = await downloadStorageBytes(thumbPath);
  const blob = new Blob([bytes], { type: "image/webp" });
  return URL.createObjectURL(blob);
}

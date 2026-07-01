/**
 * Thumbnail encode worker — decodes the FULL-RES capture and produces the
 * 320px WebP thumb entirely OFF the webview main thread.
 *
 * The old path (`<img>` load + `<canvas>` drawImage + toBlob) decoded a
 * 3420x2224 retina PNG on the MAIN thread per publish/share/backfill file —
 * multi-hundred-ms jank frames exactly while the edge rail is open. Here the
 * decode (createImageBitmap), scale (OffscreenCanvas drawImage) and encode
 * (convertToBlob) all run inside this module worker; the main thread only
 * passes Blobs across (structured clone of a Blob is by-reference, no copy).
 *
 * `convertToBlob({type:"image/webp"})` mirrors the main-thread
 * `toBlob(…, "image/webp")` behavior: an engine without WebP encode falls back
 * to PNG per spec, same as before.
 */

import { THUMB_MAX_EDGE, THUMB_WEBP_QUALITY } from "./types";

export interface ThumbRequest {
  id: number;
  blob: Blob;
}

export type ThumbResponse =
  | { id: number; ok: true; width: number; height: number; thumb: Blob }
  | { id: number; ok: false; error: string };

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<ThumbRequest>) => void) | null;
  postMessage: (msg: ThumbResponse) => void;
};

scope.onmessage = async (e: MessageEvent<ThumbRequest>) => {
  const { id, blob } = e.data;
  try {
    // Single decode: full bitmap gives the natural dimensions (needed for the
    // Firestore doc) AND is the drawImage source for the scaled thumb.
    const bmp = await createImageBitmap(blob);
    const width = bmp.width;
    const height = bmp.height;
    const ratio = Math.min(THUMB_MAX_EDGE / width, THUMB_MAX_EDGE / height, 1);
    const w = Math.max(1, Math.round(width * ratio));
    const h = Math.max(1, Math.round(height * ratio));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D context unavailable in worker");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const thumb = await canvas.convertToBlob({
      type: "image/webp",
      quality: THUMB_WEBP_QUALITY,
    });
    scope.postMessage({ id, ok: true, width, height, thumb });
  } catch (err) {
    scope.postMessage({ id, ok: false, error: String(err) });
  }
};

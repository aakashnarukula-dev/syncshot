/**
 * makeThumb — 320px WebP thumbnail + natural dimensions for a capture Blob.
 *
 * Preferred path: a shared module Web Worker (thumb.worker.ts) does the decode
 * + scale + encode off the main thread — zero main-thread jank even for retina
 * full-res PNGs. Fallback path (worker/OffscreenCanvas unavailable, worker
 * crash, or a per-image worker failure): the original main-thread
 * `<img>` + `<canvas>` pipeline, byte-for-byte the old behavior.
 */

import { THUMB_MAX_EDGE, THUMB_WEBP_QUALITY } from "./types";
import type { ThumbResponse } from "./thumb.worker";

export interface ThumbResult {
  width: number;
  height: number;
  thumb: Blob;
}

/** A hung worker must not strand publishes forever — reject and fall back. */
const WORKER_TIMEOUT_MS = 30_000;

let worker: Worker | null = null;
// Worker permanently unusable (unsupported env or crashed) — stop trying.
let workerBroken = false;
let nextId = 1;
const pending = new Map<
  number,
  { resolve: (r: ThumbResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
>();

function settle(id: number, result: ThumbResult | Error): void {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  clearTimeout(p.timer);
  if (result instanceof Error) p.reject(result);
  else p.resolve(result);
}

function failAllPending(err: Error): void {
  for (const id of [...pending.keys()]) settle(id, err);
}

function getWorker(): Worker | null {
  if (workerBroken) return null;
  if (
    typeof Worker === "undefined" ||
    typeof OffscreenCanvas === "undefined" ||
    typeof createImageBitmap !== "function"
  ) {
    workerBroken = true;
    return null;
  }
  if (!worker) {
    try {
      worker = new Worker(new URL("./thumb.worker.ts", import.meta.url), {
        type: "module",
      });
      worker.onmessage = (e: MessageEvent<ThumbResponse>) => {
        const msg = e.data;
        settle(msg.id, msg.ok ? { width: msg.width, height: msg.height, thumb: msg.thumb } : new Error(msg.error));
      };
      worker.onerror = () => {
        failAllPending(new Error("thumb worker crashed"));
        workerBroken = true;
        worker?.terminate();
        worker = null;
      };
    } catch {
      workerBroken = true;
      worker = null;
    }
  }
  return worker;
}

function workerThumb(w: Worker, blob: Blob): Promise<ThumbResult> {
  const id = nextId++;
  return new Promise<ThumbResult>((resolve, reject) => {
    const timer = setTimeout(
      () => settle(id, new Error("thumb worker timed out")),
      WORKER_TIMEOUT_MS,
    );
    pending.set(id, { resolve, reject, timer });
    w.postMessage({ id, blob });
  });
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

/** Original main-thread pipeline — the fallback when the worker can't run. */
async function makeThumbMainThread(blob: Blob): Promise<ThumbResult> {
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

export async function makeThumb(blob: Blob): Promise<ThumbResult> {
  const w = getWorker();
  if (w) {
    try {
      return await workerThumb(w, blob);
    } catch (err) {
      // Per-image failure or crash — retry this image on the main thread so a
      // publish never fails just because the worker path did.
      console.error("thumb worker failed, falling back to main thread:", err);
    }
  }
  return makeThumbMainThread(blob);
}

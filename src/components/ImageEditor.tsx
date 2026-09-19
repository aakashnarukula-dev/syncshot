import { useState, useRef, useEffect, useCallback } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize, availableMonitors } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { AnnotationToolbar } from "./editor/AnnotationToolbar";
import { AnnotationCanvas } from "./editor/AnnotationCanvas";
import { OCRResultsDialog } from "./editor/OCRResultsDialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "./ui/dialog";
import { Button } from "./ui/button";
import { Annotation, ToolType } from "@/types/annotations";
import { usePreviewGenerator } from "@/hooks/usePreviewGenerator";
import { recognizeTextFromCanvas } from "@/lib/ocr";
import {
  useSettings,
  useAnnotations,
  editorActions,
  useEditorStore,
  type EditorSettings,
} from "@/stores";

/** Shift an annotation (and its endpoints) by a delta, used after cropping. */
function offsetAnnotation(a: Annotation, dx: number, dy: number): Annotation {
  const next = { ...a, x: a.x + dx, y: a.y + dy };
  if (next.type === "line" || next.type === "arrow") {
    next.endX += dx;
    next.endY += dy;
    if (next.controlPoints) {
      next.controlPoints = next.controlPoints.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    }
  }
  return next;
}

interface ImageEditorProps {
  // The editor window is a reused singleton (hidden on close, shown on the
  // next open), so save/cancel/export are handled INTERNALLY — no shell
  // callbacks.
  imagePath: string;
}

interface EditorPendingSource {
  imagePath: string;
  imageUrl?: string | null;
  previewUrl?: string | null;
}

/** URL sentinel the singleton window boots with before any image is chosen. */
const PENDING_SENTINEL = "__pending__";

/** Opaque screenshots do not need the expensive full-image alpha scan. */
function hasTransparentOuterCorner(image: HTMLImageElement): boolean {
  const w = image.naturalWidth;
  const h = image.naturalHeight;
  if (w < 1 || h < 1) return false;
  const probe = document.createElement("canvas");
  probe.width = 2;
  probe.height = 2;
  const ctx = probe.getContext("2d");
  if (!ctx) return true;
  ctx.drawImage(image, 0, 0, 1, 1, 0, 0, 1, 1);
  ctx.drawImage(image, w - 1, 0, 1, 1, 1, 0, 1, 1);
  ctx.drawImage(image, 0, h - 1, 1, 1, 0, 1, 1, 1);
  ctx.drawImage(image, w - 1, h - 1, 1, 1, 1, 1, 1, 1);
  const data = ctx.getImageData(0, 0, 2, 2).data;
  return data[3] < 250 || data[7] < 250 || data[11] < 250 || data[15] < 250;
}

/** Small cross-window preview for an immediate rail replacement after save. */
function makeOptimisticThumbnail(canvas: HTMLCanvasElement): string {
  const maxEdge = 512;
  const scale = Math.min(1, maxEdge / Math.max(canvas.width, canvas.height));
  const thumb = document.createElement("canvas");
  thumb.width = Math.max(1, Math.round(canvas.width * scale));
  thumb.height = Math.max(1, Math.round(canvas.height * scale));
  const ctx = thumb.getContext("2d");
  if (!ctx) return "";
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, thumb.width, thumb.height);
  return thumb.toDataURL("image/webp", 0.78);
}

/** Where saves land — read fresh on every save so pref changes apply to a reused window. */
async function loadSaveDir(): Promise<string> {
  try {
    return await invoke<string>("get_temp_directory");
  } catch {}
  return "";
}

export function ImageEditor({ imagePath }: ImageEditorProps) {
  // Use Zustand store with selectors for optimized re-renders
  const settings = useSettings();
  const annotations = useAnnotations();
  // Use stable actions object (not a hook, doesn't cause re-renders)
  const actions = editorActions;
  
  // The image currently open. `nonce` forces a fresh load + AnnotationCanvas
  // remount even when the SAME path is reopened (a crop may have replaced the
  // in-memory base image, and canvas-local zoom/pan must reset per session).
  const [openReq, setOpenReq] = useState(() => ({
    path: imagePath && imagePath !== PENDING_SENTINEL ? imagePath : "",
    url: "",
    previewUrl: "",
    nonce: 0,
  }));
  // True from "new image requested" until the preview for it lands — the hook
  // keeps the PREVIOUS session's previewUrl until it regenerates, so render a
  // loading state instead of flashing the old screenshot.
  const [awaitingPreview, setAwaitingPreview] = useState(false);

  // Screenshot image state
  const [screenshotImage, setScreenshotImage] = useState<HTMLImageElement | null>(null);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  
  // Save/copy state
  const [isSaving, setIsSaving] = useState(false);
  const [isCopying, setIsCopying] = useState(false);
  
  // OCR state
  const [isOCRProcessing, setIsOCRProcessing] = useState(false);
  const [ocrResults, setOcrResults] = useState<string>("");
  const [showOCRDialog, setShowOCRDialog] = useState(false);

  // Unsaved-changes confirm dialog
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const annotationsCountRef = useRef(0);

  // Annotation UI state (not part of undo/redo)
  const [selectedTool, setSelectedTool] = useState<ToolType>("select");
  const [selectedAnnotation, setSelectedAnnotation] = useState<Annotation | null>(null);
  const [activeColor, setActiveColor] = useState("#FF3300");

  // Crop undo stack — base image isn't in the store, so crops undo locally.
  const cropUndoRef = useRef<Array<{ image: HTMLImageElement; annotations: Annotation[]; settings: EditorSettings }>>([]);

  // Tracks the path represented by the latest persisted editor result. Every
  // crop/save creates a replacement file; the main window serially removes the
  // previous local/cloud version. Unique paths keep rapid edits race-free and
  // force the thumbnail/webview to decode the new bytes immediately.
  const lastCropPathRef = useRef<string | null>(null);
  const editorPersistQueueRef = useRef<Promise<void>>(Promise.resolve());

  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Toolbar wrapper — measured (not hardcoded) so the window height budget
  // matches the real toolbar row exactly. Fallback to 45 if unmeasurable.
  const toolbarRef = useRef<HTMLDivElement>(null);
  // The native singleton is hidden on open. Reveal exactly once, only after the
  // final full-resolution canvas has painted and its geometry is settled.
  const revealedNonceRef = useRef<number>(-1);
  const autoCopiedNonceRef = useRef<number>(-1);

  // Preview generator hook
  const { previewUrl, error: previewError, renderHighQualityCanvas } = usePreviewGenerator({
    screenshotImage,
    settings,
    canvasRef,
    padding: settings.padding,
  });

  // Combined error
  const error = loadError || previewError;

  useEffect(() => {
    editorActions.initialize();
  }, []);

  useEffect(() => {
    annotationsCountRef.current = annotations.length;
  }, [annotations.length]);

  // Wipe everything a previous editing session could leave behind. Runs on
  // every open AND close so a reused window always starts clean.
  const resetEditorSession = useCallback(() => {
    editorActions.reset();
    cropUndoRef.current = [];
    lastCropPathRef.current = null;
    setSelectedAnnotation(null);
    setSelectedTool("select");
    setShowCloseConfirm(false);
    setShowOCRDialog(false);
    setOcrResults("");
    setScreenshotImage(null);
    setImageLoaded(false);
    setLoadError(null);
  }, []);

  const openImage = useCallback((source: EditorPendingSource) => {
    resetEditorSession();
    editorActions.initialize();
    setAwaitingPreview(true);
    setOpenReq((prev) => ({
      path: source.imagePath,
      url: source.imageUrl ?? "",
      previewUrl: source.previewUrl ?? "",
      nonce: prev.nonce + 1,
    }));
  }, [resetEditorSession]);

  // Close = reset + HIDE (never destroy) so the webview stays warm for the
  // next open. "editor-closed" must go out before the hide so the main
  // window's open-editor counter resumes display-follow reliably.
  const closeEditor = useCallback(async () => {
    resetEditorSession();
    setOpenReq((prev) => ({ path: "", url: "", previewUrl: "", nonce: prev.nonce + 1 }));
    try { await emit("editor-closed"); } catch {}
    try { await getCurrentWindow().hide(); } catch {}
  }, [resetEditorSession]);

  // Image delivery: opens park the path in a Rust slot and ping "editor-open".
  // Pulling (take semantics) instead of reading event payloads makes delivery
  // race-free across webview boot — a ping that fired mid-boot is covered by
  // the take on mount, and each request is consumed exactly once.
  const consumePendingOpen = useCallback(async () => {
    try {
      const pending = await invoke<EditorPendingSource | null>("take_editor_pending_path");
      if (pending) openImage(pending);
    } catch (e) {
      console.error("take_editor_pending_path failed:", e);
    }
  }, [openImage]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        unlisten = await listen("editor-open", () => { void consumePendingOpen(); });
      } catch {}
      if (!disposed) void consumePendingOpen();
    })();
    return () => { disposed = true; unlisten?.(); };
  }, [consumePendingOpen]);

  useEffect(() => {
    const w = getCurrentWindow();
    let unlistenClose: (() => void) | null = null;
    (async () => {
      try {
        unlistenClose = await w.onCloseRequested(async (event) => {
          // Always intercept: the singleton window hides instead of closing.
          event.preventDefault();
          if (annotationsCountRef.current > 0) {
            setShowCloseConfirm(true);
            return;
          }
          await closeEditor();
        });
      } catch {}
    })();
    return () => { unlistenClose?.(); };
  }, [closeEditor]);

  // Restore window state on every open (a reused window may have been left
  // fullscreen OR maximized/zoomed by the previous session). A maximized macOS
  // window will NOT shrink on setSize(), so it must be un-maximized here before
  // the img.onload handler resizes it — otherwise the canvas contain-fits into
  // an oversized window and leaves a thick black letterbox.
  useEffect(() => {
    if (!openReq.path) return;
    revealedNonceRef.current = -1;
    const restoreWindowState = async () => {
      const appWindow = getCurrentWindow();
      // Un-fullscreen / un-maximize first, each guarded so one failing (or a
      // method being unavailable) never blocks the others.
      try { await appWindow.setFullscreen(false); } catch (err) { console.error("setFullscreen(false) failed:", err); }
      try {
        if (await appWindow.isMaximized()) await appWindow.unmaximize();
      } catch {
        // isMaximized() unavailable/failed — un-maximize unconditionally.
        try { await appWindow.unmaximize(); } catch (err) { console.error("unmaximize failed:", err); }
      }
      try { await appWindow.setAlwaysOnTop(false); } catch (err) { console.error("setAlwaysOnTop(false) failed:", err); }
      try { await appWindow.setDecorations(true); } catch (err) { console.error("setDecorations(true) failed:", err); }
    };
    restoreWindowState();
  }, [openReq]);

  // The preview hook keeps the previous previewUrl until it regenerates for
  // the new image; any change after an open means the fresh one landed.
  useEffect(() => {
    if (previewUrl) setAwaitingPreview(false);
  }, [previewUrl]);

  // Load main screenshot image
  useEffect(() => {
    const imagePath = openReq.path;
    setLoadError(null);
    setImageLoaded(false);
    setScreenshotImage(null);

    // No image yet — pre-warmed window (or between sessions). Idle quietly in
    // the loading state until an open delivers a path.
    if (!imagePath) return;

    let cancelled = false;
    let objectUrl: string | null = null;
    let trimmedUrl: string | null = null;
    const img = new Image();
    img.decoding = "async";
    img.onload = async () => {
      if (cancelled) return;

      // macOS WINDOW captures bake a wide fully-transparent margin (the
      // drop-shadow area) around the opaque window. The editor renders on a
      // black background, so that margin shows as black padding. Auto-trim it
      // on open. Region/full-screen captures have no such margin (bbox == full
      // image) and fall through unchanged. Done here so the trimmed image is
      // the base everything downstream (preview, canvas, save/copy/crop/OCR)
      // is relative to — no annotation math elsewhere needs to change.
      let baseImg: HTMLImageElement = img;
      try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        // A four-pixel probe makes the common opaque screenshot path O(1).
        // Only native window captures have transparent outer corners and need
        // the full RGBA bounding-box pass below.
        if (hasTransparentOuterCorner(img)) {
        const trimCanvas = document.createElement("canvas");
        trimCanvas.width = w;
        trimCanvas.height = h;
        const tctx = trimCanvas.getContext("2d");
        if (tctx) {
          tctx.drawImage(img, 0, 0);
          // Throws (taints) only on the convertFileSrc crossOrigin fallback;
          // the primary blob: path is same-origin and untainted.
          const { data } = tctx.getImageData(0, 0, w, h);
          // Bounding box of "content" (alpha >= 250 ~= opaque) pixels.
          let top = -1, bottom = -1, left = w, right = -1;
          for (let y = 0; y < h; y++) {
            const rowStart = y * w * 4;
            let rowHasContent = false;
            for (let x = 0; x < w; x++) {
              if (data[rowStart + x * 4 + 3] >= 250) {
                rowHasContent = true;
                if (x < left) left = x;
                if (x > right) right = x;
              }
            }
            if (rowHasContent) {
              if (top === -1) top = y;
              bottom = y;
            }
          }
          const hasContent = top !== -1 && right !== -1;
          const bx = left;
          const by = top;
          const bw = right - left + 1;
          const bh = bottom - top + 1;
          // Skip when fully transparent (no content) or when the bbox spans
          // the whole image (no margin — the common region/full-screen case).
          if (hasContent && !(bx === 0 && by === 0 && bw === w && bh === h)) {
            const cropCanvas = document.createElement("canvas");
            cropCanvas.width = bw;
            cropCanvas.height = bh;
            const cctx = cropCanvas.getContext("2d");
            if (cctx) {
              cctx.drawImage(img, bx, by, bw, bh, 0, 0, bw, bh);
              // Square the rounded window corners. After trimming to the opaque
              // bbox, the four corner regions inside the rectangle but outside
              // the window's rounded corner are still transparent, showing the
              // editor's black background as notches. By construction every row
              // in the cropped bbox has at least one opaque pixel, so extend the
              // window's edge color horizontally into the transparent leading /
              // trailing run of each row. This fills the corner notches (and any
              // anti-aliased fringe) making all four corners square. No-op for
              // rows with no transparent leading/trailing run.
              const cropData = cctx.getImageData(0, 0, bw, bh);
              const cd = cropData.data;
              for (let y = 0; y < bh; y++) {
                const rowStart = y * bw * 4;
                // Extend from the LEFT: find the first opaque pixel and fill the
                // transparent run before it with that pixel's RGB, alpha 255.
                let firstOpaque = -1;
                for (let x = 0; x < bw; x++) {
                  if (cd[rowStart + x * 4 + 3] >= 250) {
                    firstOpaque = x;
                    break;
                  }
                }
                // firstOpaque is always found (row has content), but guard anyway.
                if (firstOpaque > 0) {
                  const src = rowStart + firstOpaque * 4;
                  const r = cd[src], g = cd[src + 1], b = cd[src + 2];
                  for (let x = 0; x < firstOpaque; x++) {
                    const p = rowStart + x * 4;
                    cd[p] = r;
                    cd[p + 1] = g;
                    cd[p + 2] = b;
                    cd[p + 3] = 255;
                  }
                }
                // Extend from the RIGHT: find the last opaque pixel and fill the
                // trailing transparent run after it.
                let lastOpaque = -1;
                for (let x = bw - 1; x >= 0; x--) {
                  if (cd[rowStart + x * 4 + 3] >= 250) {
                    lastOpaque = x;
                    break;
                  }
                }
                if (lastOpaque !== -1 && lastOpaque < bw - 1) {
                  const src = rowStart + lastOpaque * 4;
                  const r = cd[src], g = cd[src + 1], b = cd[src + 2];
                  for (let x = lastOpaque + 1; x < bw; x++) {
                    const p = rowStart + x * 4;
                    cd[p] = r;
                    cd[p + 1] = g;
                    cd[p + 2] = b;
                    cd[p + 3] = 255;
                  }
                }
              }
              cctx.putImageData(cropData, 0, 0);
              const blob = await new Promise<Blob | null>((resolve) =>
                cropCanvas.toBlob(resolve, "image/png"),
              );
              if (cancelled) return;
              if (blob) {
                trimmedUrl = URL.createObjectURL(blob);
                const cropped = new Image();
                cropped.decoding = "async";
                await new Promise<void>((resolve, reject) => {
                  cropped.onload = () => resolve();
                  cropped.onerror = () => reject(new Error("cropped image load failed"));
                  cropped.src = trimmedUrl as string;
                });
                if (cancelled) return;
                baseImg = cropped;
              }
            }
          }
        }
        }
      } catch {
        // getImageData tainted (crossOrigin fallback) or any trim failure —
        // use the original image unchanged.
        baseImg = img;
      }

      try {
        // Size the window to the SCREENSHOT's own aspect ratio so the canvas
        // fills it edge-to-edge with no dark letterbox, scaled up to ~85% of
        // the current display (whichever dimension binds). The fixed toolbar
        // row sits above the canvas, so it's excluded from the image's height
        // budget and added back to the window height.
        const monitors = await availableMonitors();
        const m = monitors[0];
        const scale = m?.scaleFactor || 1;
        const monLogW = (m?.size.width || 1440) / scale;
        const monLogH = (m?.size.height || 900) / scale;
        // Screenshot pixels are physical (a Retina capture is stored at the
        // display's device resolution); divide by the scale factor for the
        // logical size the window is measured in. Use the TRIMMED image's
        // dimensions so the window fits the visible content, not the margin.
        const imgLogW = baseImg.naturalWidth / scale;
        const imgLogH = baseImg.naturalHeight / scale;
        // Measure the real toolbar row instead of hardcoding — h-11 + a 1px
        // bottom border is 45px, but reading offsetHeight tracks any change.
        const toolbarH = toolbarRef.current?.offsetHeight || 45;
        const imgAspect = imgLogW / imgLogH;
        const availW = monLogW * 0.85;
        const availH = monLogH * 0.85 - toolbarH;
        // Do NOT clamp to <=1 — smaller screenshots scale UP to a large window.
        const fit = Math.min(availW / imgLogW, availH / imgLogH);
        // Derive the height from the ROUNDED width so a single rounding step
        // governs the content aspect (avoids two independent roundings drifting
        // apart and reintroducing a hairline bar).
        const finalW = Math.round(imgLogW * fit);
        const contentH = Math.round(finalW / imgAspect);
        const finalH = contentH + toolbarH;

        const win = getCurrentWindow();
        // Defense in depth: a maximized/fullscreen window won't shrink on
        // setSize, so ensure it isn't before sizing (restoreWindowState also
        // does this, but ordering across the two async effects isn't
        // guaranteed).
        try { await win.setFullscreen(false); } catch {}
        try {
          if (await win.isMaximized()) await win.unmaximize();
        } catch {
          try { await win.unmaximize(); } catch {}
        }
        await win.setSize(new LogicalSize(finalW, finalH));
        await win.center();
      } catch (e) {
        console.error("Failed to size editor window:", e);
      }

      if (cancelled) return;
      // Mount the annotation canvas only after the hidden native window already
      // has its final aspect-ratio-correct size. AnnotationCanvas reveals the
      // window after its first full-resolution draw.
      setScreenshotImage(baseImg);
      setImageLoaded(true);
    };
    img.onerror = () => {
      if (cancelled) return;
      setLoadError(`Failed to load image from: ${imagePath}`);
      void (async () => {
        const win = getCurrentWindow();
        try { await win.setSize(new LogicalSize(600, 320)); } catch {}
        try { await win.center(); } catch {}
        try { await win.show(); } catch {}
        try { await win.setFocus(); } catch {}
      })();
    };

    // PRIMARY: read the file's bytes over IPC and load a same-origin `blob:`
    // URL. The old `convertFileSrc` + crossOrigin="anonymous" load needs a
    // CORS-approved `asset://` response, which the RELEASE webview's
    // `http://localhost:38217` origin never gets — the editor's image load was
    // slow/broken in release builds (same root cause as the sync layer's old
    // fetch(convertFileSrc), fixed with read_image_bytes). A blob URL decodes
    // origin-independently AND leaves the canvas untainted (same-origin), so
    // save/copy/crop/OCR all keep working. Asset URL kept as a dev fallback.
    (async () => {
      try {
        const buf = openReq.url
          ? await invoke<ArrayBuffer>("read_remote_image_bytes", { url: openReq.url })
          : await invoke<ArrayBuffer>("read_image_bytes", { path: imagePath });
        if (cancelled) return;
        objectUrl = URL.createObjectURL(new Blob([buf]));
        img.src = objectUrl;
        // The read above populated Rust's short-lived memory cache. Auto-copy
        // from that cache now, so opening a cloud image performs one Firebase
        // download instead of two concurrent full-resolution downloads.
        if (openReq.url && autoCopiedNonceRef.current !== openReq.nonce) {
          autoCopiedNonceRef.current = openReq.nonce;
          void invoke("copy_remote_image_to_clipboard", { url: openReq.url })
            .then(() => toast.success("Copied to clipboard", { duration: 1500 }))
            .catch((e) => console.error("copy on open failed:", e));
        }
      } catch {
        if (cancelled) return;
        if (openReq.url) {
          setLoadError("Failed to download screenshot from Firebase");
          const win = getCurrentWindow();
          try { await win.setSize(new LogicalSize(600, 320)); } catch {}
          try { await win.center(); } catch {}
          try { await win.show(); } catch {}
          try { await win.setFocus(); } catch {}
          return;
        }
        img.crossOrigin = "anonymous";
        img.src = convertFileSrc(imagePath);
      }
    })();

    return () => {
      cancelled = true;
      img.onload = null;
      img.onerror = null;
      // The decoded HTMLImageElement keeps its bitmap after revoke; only a
      // fresh load of the dead URL would fail, which never happens here.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (trimmedUrl) URL.revokeObjectURL(trimmedUrl);
    };
  }, [openReq]);

  const revealReadyEditor = useCallback(async () => {
    if (!openReq.path || revealedNonceRef.current === openReq.nonce) return;
    revealedNonceRef.current = openReq.nonce;
    const win = getCurrentWindow();
    try {
      // Canvas layout is authoritative. Correct any sub-pixel contain rounding
      // while hidden, then reveal one complete frame—never resize after show.
      const canvas = document.querySelector<HTMLCanvasElement>("canvas[data-editor-canvas]");
      const rect = canvas?.getBoundingClientRect();
      if (rect && rect.width >= 1 && rect.height >= 1) {
        const toolbarH = toolbarRef.current?.offsetHeight || 45;
        const targetW = Math.round(rect.width);
        const targetH = Math.round(rect.height) + toolbarH;
        if (window.innerWidth - targetW > 1 || window.innerHeight - targetH > 1) {
          await win.setSize(new LogicalSize(targetW, targetH));
          await win.center();
        }
      }
    } catch (error) {
      console.error("Editor final geometry failed:", error);
    }
    try { await win.show(); } catch {}
    try { await win.setFocus(); } catch {}
  }, [openReq.nonce, openReq.path]);

  // Serialize crop/save writes inside the editor too. A crop export and a fast
  // Save click can otherwise both read the same previous path, producing two
  // sibling replacements before the main window has a chance to process them.
  const persistEditedImage = useCallback((dataUrl: string, previewDataUrl = ""): Promise<string> => {
    let resolvePath!: (path: string) => void;
    let rejectPath!: (reason: unknown) => void;
    const result = new Promise<string>((resolve, reject) => {
      resolvePath = resolve;
      rejectPath = reject;
    });

    editorPersistQueueRef.current = editorPersistQueueRef.current
      .catch(() => {})
      .then(async () => {
        try {
          const saveDir = await loadSaveDir();
          if (!saveDir) throw new Error("Save directory not set");
          const previousPath = lastCropPathRef.current ?? openReq.path;
          const newPath = await invoke<string>("save_edited_image", {
            imageData: dataUrl,
            saveDir,
            copyToClip: true,
          });
          lastCropPathRef.current = newPath;
          try {
            await emit("editor-saved", { originalPath: previousPath, newPath, previewDataUrl });
          } catch {}
          resolvePath(newPath);
        } catch (error) {
          rejectPath(error);
        }
      });

    return result;
  }, [openReq.path]);

  // Save handler — persists to the save dir + clipboard, notifies the main
  // window, then hides this one (was EditorOnlyApp's onSave + destroy).
  const handleSave = useCallback(async () => {
    if (!screenshotImage || isSaving || isCopying) return;

    setIsSaving(true);
    try {
      const highQualityCanvas = await renderHighQualityCanvas(annotations);
      if (!highQualityCanvas) return;

      const blob = await new Promise<Blob | null>((resolve) =>
        highQualityCanvas.toBlob(resolve, "image/png", 1.0),
      );
      if (!blob) return;
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error("Failed to read image data"));
        reader.readAsDataURL(blob);
      });

      await persistEditedImage(dataUrl, makeOptimisticThumbnail(highQualityCanvas));
      await closeEditor();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLoadError(`Failed to save: ${msg}`);
      toast.error("Failed to save image", { description: msg, duration: 5000 });
    } finally {
      setIsSaving(false);
    }
  }, [screenshotImage, annotations, renderHighQualityCanvas, isSaving, isCopying, persistEditedImage, closeEditor]);

  // Copy commits the full rendered editor result too. This keeps the rail and
  // Firebase on the exact image placed on the clipboard, including every
  // annotation/effect—not only crops or explicit Save clicks.
  const handleCopy = useCallback(async () => {
    if (!screenshotImage || isSaving || isCopying) return;
    
    setIsCopying(true);
    try {
      const highQualityCanvas = await renderHighQualityCanvas(annotations);
      
      if (!highQualityCanvas) {
        setIsCopying(false);
        return;
      }

      const dataUrl = highQualityCanvas.toDataURL("image/png");
      await persistEditedImage(dataUrl, makeOptimisticThumbnail(highQualityCanvas));
      
      toast.success("Screenshot copied to clipboard!", {
        duration: 2000,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setLoadError(`Failed to copy: ${errorMessage}`);
      toast.error("Failed to copy", {
        description: errorMessage,
        duration: 3000,
      });
    } finally {
      setIsCopying(false);
    }
  }, [screenshotImage, annotations, renderHighQualityCanvas, isSaving, isCopying, persistEditedImage]);

  const handleOCRFullImage = useCallback(async () => {
    if (!screenshotImage || isOCRProcessing) return;
    setIsOCRProcessing(true);
    try {
      const hq = await renderHighQualityCanvas(annotations);
      if (!hq) {
        setIsOCRProcessing(false);
        return;
      }
      const text = await recognizeTextFromCanvas(hq);
      setOcrResults(text);
      setShowOCRDialog(true);
    } catch (err) {
      toast.error("OCR failed", {
        description: err instanceof Error ? err.message : String(err),
        duration: 5000,
      });
    } finally {
      setIsOCRProcessing(false);
    }
  }, [screenshotImage, annotations, renderHighQualityCanvas, isOCRProcessing]);

  // Annotation handlers
  const handleAnnotationAdd = useCallback((annotation: Annotation) => {
    actions.addAnnotation(annotation);
    setSelectedAnnotation(annotation);
    setSelectedTool("select");
  }, [actions]);

  const handleAnnotationUpdateTransient = useCallback((annotation: Annotation) => {
    actions.updateAnnotationTransient(annotation);
    setSelectedAnnotation(annotation);
  }, [actions]);

  const handleAnnotationUpdate = useCallback((annotation: Annotation) => {
    actions.updateAnnotation(annotation);
    setSelectedAnnotation(annotation);
  }, [actions]);

  const handleAnnotationDelete = useCallback((id: string) => {
    actions.deleteAnnotation(id);
    setSelectedAnnotation((prev) => prev?.id === id ? null : prev);
  }, [actions]);

  const handleDeleteSelected = useCallback(() => {
    if (selectedAnnotation) {
      handleAnnotationDelete(selectedAnnotation.id);
    }
  }, [selectedAnnotation, handleAnnotationDelete]);

  // Color picker — sets the color for new shapes and recolors the selected one.
  const handleColorChange = useCallback((hex: string) => {
    setActiveColor(hex);
    if (selectedAnnotation) {
      const updated = {
        ...selectedAnnotation,
        fill: { ...selectedAnnotation.fill, hex },
        border: { ...selectedAnnotation.border, color: { ...selectedAnnotation.border.color, hex } },
      } as Annotation;
      actions.updateAnnotation(updated);
      setSelectedAnnotation(updated);
    }
  }, [selectedAnnotation, actions]);

  // Persist a crop without closing. The main window receives an explicit
  // replacement event immediately; it swaps the live tile, removes the prior
  // local/cloud object, and publishes only this cropped result.
  const exportCrop = useCallback(async (dataUrl: string, previewDataUrl: string) => {
    try {
      await persistEditedImage(dataUrl, previewDataUrl);
      toast.success("Cropped screenshot saved & copied", { duration: 2000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error("Failed to save crop", { description: msg, duration: 5000 });
    }
  }, [persistEditedImage]);

  // Crop — rect is in preview-pixel coordinates. Two outputs from the same rect:
  //   1. EXPORT: composite WITH annotations baked → saved to folder + clipboard.
  //   2. BASE:   composite WITHOUT annotations → the new editing image, with the
  //      annotation objects offset so they stay editable over the cropped base.
  // Both canvases share the preview's dimensions, so the rect maps 1:1.
  const handleCrop = useCallback(async (rect: { x: number; y: number; width: number; height: number }) => {
    if (!previewUrl || !screenshotImage) return;

    // 1. Baked composite (annotations included) for the saved file + clipboard.
    const baked = await renderHighQualityCanvas(annotations);
    if (!baked) return;

    const sx = Math.max(0, Math.round(rect.x));
    const sy = Math.max(0, Math.round(rect.y));
    const sw = Math.min(baked.width - sx, Math.round(rect.width));
    const sh = Math.min(baked.height - sy, Math.round(rect.height));
    if (sw < 1 || sh < 1) return;

    const cropTo = (src: CanvasImageSource) => {
      const c = document.createElement("canvas");
      c.width = sw;
      c.height = sh;
      c.getContext("2d")!.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
      return {
        dataUrl: c.toDataURL("image/png"),
        previewDataUrl: makeOptimisticThumbnail(c),
      };
    };

    const exported = cropTo(baked);

    // 2. Annotation-free composite (the preview) becomes the editable base image.
    const baseSrc = new Image();
    baseSrc.onload = () => {
      const baseDataUrl = cropTo(baseSrc).dataUrl;
      const newBase = new Image();
      newBase.onload = () => {
        cropUndoRef.current.push({
          image: screenshotImage,
          annotations: annotations.map((a) => ({ ...a })),
          settings: { ...settings },
        });
        setScreenshotImage(newBase);
        // Background/padding are baked into the cropped base — flatten the rest.
        useEditorStore.getState().updateSettingsTransient({
          padding: 0,
          borderRadius: 0,
          backgroundType: "transparent",
          noiseAmount: 0,
        });
        // Keep annotations editable, shifted to the new origin.
        actions.setAnnotations(annotations.map((a) => offsetAnnotation(a, -sx, -sy)));
        setSelectedAnnotation(null);
        setSelectedTool("select");
        // Save to the screenshots folder + clipboard, like a normal capture.
        void exportCrop(exported.dataUrl, exported.previewDataUrl);
      };
      newBase.src = baseDataUrl;
    };
    baseSrc.src = previewUrl;
  }, [previewUrl, screenshotImage, annotations, settings, actions, renderHighQualityCanvas, exportCrop]);

  const handleCropUndo = useCallback((): boolean => {
    const snap = cropUndoRef.current.pop();
    if (!snap) return false;
    setScreenshotImage(snap.image);
    useEditorStore.getState().updateSettingsTransient(snap.settings);
    actions.setAnnotations(snap.annotations);
    setSelectedAnnotation(null);
    return true;
  }, [actions]);

  const requestClose = useCallback(() => {
    if (annotations.length > 0) {
      setShowCloseConfirm(true);
    } else {
      void closeEditor();
    }
  }, [annotations.length, closeEditor]);

  const handleDiscardAndClose = useCallback(() => {
    setShowCloseConfirm(false);
    void closeEditor();
  }, [closeEditor]);

  const handleSaveAndClose = useCallback(() => {
    setShowCloseConfirm(false);
    handleSave();
  }, [handleSave]);

  // Undo/Redo handlers — a crop undoes before annotation history.
  const handleUndo = useCallback(() => {
    if (handleCropUndo()) return;
    actions.undo();
    setSelectedAnnotation(null);
  }, [actions, handleCropUndo]);

  const handleRedo = useCallback(() => {
    actions.redo();
    setSelectedAnnotation(null);
  }, [actions]);

  // Delete annotation with keyboard
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedAnnotation) {
          e.preventDefault();
          handleAnnotationDelete(selectedAnnotation.id);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedAnnotation, handleAnnotationDelete]);

  // Keyboard shortcuts for save/copy/undo/redo
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if typing in input fields
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      // Save: Cmd+S
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (imageLoaded && !isSaving && !isCopying) {
          handleSave();
        }
      }
      // Copy: Cmd+Shift+C
      if ((e.metaKey || e.ctrlKey) && e.key === "c" && e.shiftKey) {
        e.preventDefault();
        if (imageLoaded && !isSaving && !isCopying) {
          handleCopy();
        }
      }
      // Undo: Cmd+Z
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      }
      // Redo: Cmd+Shift+Z or Cmd+Y
      if ((e.metaKey || e.ctrlKey) && ((e.key === "z" && e.shiftKey) || e.key === "y")) {
        e.preventDefault();
        handleRedo();
      }
      // Cancel: Escape
      if (e.key === "Escape") {
        requestClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [imageLoaded, isSaving, isCopying, handleSave, handleCopy, handleUndo, handleRedo, requestClose]);


  return (
    <div className="flex flex-col h-dvh w-dvw bg-black text-foreground overflow-hidden">
      <div ref={toolbarRef} className="shrink-0">
        <AnnotationToolbar
          selectedTool={selectedTool}
          onToolSelect={setSelectedTool}
          onDelete={selectedAnnotation ? handleDeleteSelected : undefined}
          onExtractText={handleOCRFullImage}
          isExtracting={isOCRProcessing}
          onSave={handleSave}
          isSaving={isSaving}
          hasChanges={annotations.length > 0}
          color={activeColor}
          onColorChange={handleColorChange}
        />
      </div>

      <div className="flex-1 flex items-center justify-center min-w-0 min-h-0 overflow-hidden">
        {previewUrl && !awaitingPreview ? (
          <AnnotationCanvas
            key={openReq.nonce}
            annotations={annotations}
            selectedAnnotation={selectedAnnotation}
            selectedTool={selectedTool}
            previewUrl={previewUrl}
            showTransparencyGrid={false}
            activeColor={activeColor}
            onAnnotationAdd={handleAnnotationAdd}
            onAnnotationUpdateTransient={handleAnnotationUpdateTransient}
            onAnnotationUpdate={handleAnnotationUpdate}
            onAnnotationSelect={setSelectedAnnotation}
            onAnnotationDelete={handleAnnotationDelete}
            onCrop={handleCrop}
            onReady={revealReadyEditor}
          />
        ) : error ? (
          <div className="text-center text-red-400 p-5">
            <p className="mb-2 text-base font-medium text-balance">Could not load image</p>
            <small className="text-foreground0 text-xs text-pretty">{error}</small>
          </div>
        ) : imageLoaded ? (
          <div className="text-muted-foreground text-base text-pretty">Generating preview...</div>
        ) : (
          <div className="text-muted-foreground text-base text-pretty">Loading image...</div>
        )}
        <canvas ref={canvasRef} style={{ display: "none" }} />
      </div>
      <OCRResultsDialog
        open={showOCRDialog}
        onOpenChange={setShowOCRDialog}
        text={ocrResults}
      />
      <Dialog open={showCloseConfirm} onOpenChange={setShowCloseConfirm}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Unsaved changes</DialogTitle>
            <DialogDescription>
              You have unsaved annotations. Save your changes before closing?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setShowCloseConfirm(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDiscardAndClose}>
              Discard
            </Button>
            <Button onClick={handleSaveAndClose} disabled={isSaving}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

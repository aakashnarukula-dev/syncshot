import { useState, useRef, useEffect, useCallback } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize, availableMonitors } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import { Store } from "@tauri-apps/plugin-store";
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

/** URL sentinel the singleton window boots with before any image is chosen. */
const PENDING_SENTINEL = "__pending__";

/** Where saves land — read fresh on every save so pref changes apply to a reused window. */
async function loadSaveDir(): Promise<string> {
  try {
    const store = await Store.load("settings.json");
    const sd = await store.get<string>("saveDir");
    if (sd) return sd;
  } catch {}
  try {
    return await invoke<string>("get_desktop_directory");
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
  const [tempDir, setTempDir] = useState<string>("/private/tmp");
  
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

  // Crop exports overwrite the same file within ONE editing session; reset
  // per open so a reused window never clobbers a previous session's crop.
  const lastCropPathRef = useRef<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);

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

  const openImage = useCallback((path: string) => {
    resetEditorSession();
    editorActions.initialize();
    setAwaitingPreview(true);
    setOpenReq((prev) => ({ path, nonce: prev.nonce + 1 }));
  }, [resetEditorSession]);

  // Close = reset + HIDE (never destroy) so the webview stays warm for the
  // next open. "editor-closed" must go out before the hide so the main
  // window's open-editor counter and auto-hide resume reliably.
  const closeEditor = useCallback(async () => {
    resetEditorSession();
    setOpenReq((prev) => ({ path: "", nonce: prev.nonce + 1 }));
    try { await emit("editor-closed"); } catch {}
    try { await getCurrentWindow().hide(); } catch {}
  }, [resetEditorSession]);

  // Image delivery: opens park the path in a Rust slot and ping "editor-open".
  // Pulling (take semantics) instead of reading event payloads makes delivery
  // race-free across webview boot — a ping that fired mid-boot is covered by
  // the take on mount, and each request is consumed exactly once.
  const consumePendingOpen = useCallback(async () => {
    try {
      const pending = await invoke<string | null>("take_editor_pending_path");
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
  // fullscreen by the previous session).
  useEffect(() => {
    if (!openReq.path) return;
    const restoreWindowState = async () => {
      try {
        const appWindow = getCurrentWindow();
        await Promise.all([
          appWindow.setFullscreen(false),
          appWindow.setAlwaysOnTop(false),
        ]);
        await appWindow.setDecorations(true);
      } catch (err) {
        console.error("Failed to restore window decorations:", err);
      }
    };
    restoreWindowState();
  }, [openReq]);

  // Get the system temp directory (once — it never changes)
  useEffect(() => {
    invoke<string>("get_temp_directory")
      .then((dir) => setTempDir(dir))
      .catch((err) => console.error("Failed to get temp directory:", err));
  }, []);

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
    const img = new Image();
    img.decoding = "async";
    img.onload = async () => {
      if (cancelled) return;
      setScreenshotImage(img);
      setImageLoaded(true);

      try {
        // Size the window to the SCREENSHOT's own aspect ratio so the canvas
        // fills it edge-to-edge with no dark letterbox, scaled up to ~85% of
        // the current display (whichever dimension binds). The fixed toolbar
        // row (h-11 = 44px logical) sits above the canvas, so it's excluded
        // from the image's height budget and added back to the window height.
        const monitors = await availableMonitors();
        const m = monitors[0];
        const scale = m?.scaleFactor || 1;
        const monLogW = (m?.size.width || 1440) / scale;
        const monLogH = (m?.size.height || 900) / scale;
        // Screenshot pixels are physical (a Retina capture is stored at the
        // display's device resolution); divide by the scale factor for the
        // logical size the window is measured in.
        const imgLogW = img.naturalWidth / scale;
        const imgLogH = img.naturalHeight / scale;
        const TOOLBAR_H = 44; // h-11
        const availW = monLogW * 0.85;
        const availH = monLogH * 0.85 - TOOLBAR_H;
        // Do NOT clamp to <=1 — smaller screenshots scale UP to a large window.
        const fit = Math.min(availW / imgLogW, availH / imgLogH);
        const finalW = Math.round(imgLogW * fit);
        const finalH = Math.round(imgLogH * fit) + TOOLBAR_H;
        const win = getCurrentWindow();
        await win.setSize(new LogicalSize(finalW, finalH));
        await win.center();
      } catch (e) {
        console.error("Failed to size editor window:", e);
      }
    };
    img.onerror = () => {
      if (cancelled) return;
      setLoadError(`Failed to load image from: ${imagePath}`);
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
        const buf = await invoke<ArrayBuffer>("read_image_bytes", { path: imagePath });
        if (cancelled) return;
        objectUrl = URL.createObjectURL(new Blob([buf]));
        img.src = objectUrl;
      } catch {
        if (cancelled) return;
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
    };
  }, [openReq]);

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

      const saveDir = await loadSaveDir();
      if (!saveDir) {
        toast.error("Save directory not set");
        return;
      }
      const newPath = await invoke<string>("save_edited_image", {
        imageData: dataUrl,
        saveDir,
        copyToClip: true,
      });
      try { await emit("editor-saved", { originalPath: openReq.path, newPath }); } catch {}
      await closeEditor();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLoadError(`Failed to save: ${msg}`);
      toast.error("Failed to save image", { description: msg, duration: 5000 });
    } finally {
      setIsSaving(false);
    }
  }, [screenshotImage, annotations, renderHighQualityCanvas, isSaving, isCopying, openReq.path, closeEditor]);

  // Copy handler
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
      
      await invoke<string>("save_edited_image", {
        imageData: dataUrl,
        saveDir: tempDir,
        copyToClip: true,
      });
      
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
  }, [screenshotImage, annotations, renderHighQualityCanvas, isSaving, isCopying, tempDir]);

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

  // Persist a crop without closing — overwrites the same file across crops in
  // one session (was EditorOnlyApp's onExport; internal now that the window
  // is reused and the shell's callbacks would destroy it).
  const exportCrop = useCallback(async (dataUrl: string) => {
    const saveDir = await loadSaveDir();
    if (!saveDir) {
      toast.error("Save directory not set");
      return;
    }
    try {
      const path = await invoke<string>("save_edited_image", {
        imageData: dataUrl,
        saveDir,
        copyToClip: true,
        overwritePath: lastCropPathRef.current,
      });
      lastCropPathRef.current = path;
      toast.success("Cropped screenshot saved & copied", { duration: 2000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error("Failed to save crop", { description: msg, duration: 5000 });
    }
  }, []);

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

    const cropTo = (src: CanvasImageSource): string => {
      const c = document.createElement("canvas");
      c.width = sw;
      c.height = sh;
      c.getContext("2d")!.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
      return c.toDataURL("image/png");
    };

    const exportDataUrl = cropTo(baked);

    // 2. Annotation-free composite (the preview) becomes the editable base image.
    const baseSrc = new Image();
    baseSrc.onload = () => {
      const baseDataUrl = cropTo(baseSrc);
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
        void exportCrop(exportDataUrl);
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
      <div className="shrink-0">
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
          />
        ) : imageLoaded ? (
          <div className="text-muted-foreground text-base text-pretty">Generating preview...</div>
        ) : error ? (
          <div className="text-center text-red-400 p-5">
            <p className="mb-2 text-base font-medium text-balance">Could not load image</p>
            <small className="text-foreground0 text-xs text-pretty">{error}</small>
          </div>
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

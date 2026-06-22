import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { Store } from "@tauri-apps/plugin-store";
import type { KeyboardShortcut } from "./components/preferences/KeyboardShortcutManager";
import { toast } from "sonner";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { editorActions } from "@/stores/editorStore";
import { loadLicenseStatus, type LicenseStatus } from "@/lib/license";
import { Paywall } from "@/components/Paywall";
// Light module (zustand + types only — no Firebase): safe in the entry chunk.
import { registerRenameCapturePath, useScreenshots, useSyncStore } from "@/stores/syncStore";
// Firebase-FREE column ordering (own module so the heavy Firebase SDK stays off
// this startup-critical path): order the edge column by each screenshot's true
// creation time, not file mtime.
import { orderScreenshotsByCreatedAt } from "@/lib/sync/order";
// Startup-critical: static import so it ships in the entry chunk and never
// needs a runtime protocol fetch that can stall behind the launch IPC burst.
import { ScreenshotThumbnail } from "./components/ScreenshotThumbnail";

// Lazy load heavy components
const ImageEditor = lazy(() => import("./components/ImageEditor").then(m => ({ default: m.ImageEditor })));
const PreferencesPage = lazy(() => import("./components/preferences/PreferencesPage").then(m => ({ default: m.PreferencesPage })));
const SignInView = lazy(() => import("./components/Pairing/SignInView").then(m => ({ default: m.SignInView })));

type AppMode = "main" | "preferences" | "thumbnail" | "pairing";
export type ColumnView = "screenshots" | "clipboard";

const THUMB_WIDTH = 240;
const COLLAPSED_WIDTH = 18;
const COLLAPSED_HEIGHT = 90;
const THUMB_INNER_PAD_X = 24; // px-3 each side
const THUMB_ITEM_HEIGHT = Math.round((THUMB_WIDTH - THUMB_INNER_PAD_X) * 3 / 4); // 4:3 aspect
const THUMB_GAP = 20; // gap-5
const THUMB_VERT_PAD = 32; // py-4
const THUMB_VISIBLE_COUNT = 4; // start scrolling after 4
const THUMB_MAX_HEIGHT =
  THUMB_VISIBLE_COUNT * THUMB_ITEM_HEIGHT +
  (THUMB_VISIBLE_COUNT - 1) * THUMB_GAP +
  THUMB_VERT_PAD;
const THUMB_MIN_HEIGHT = THUMB_ITEM_HEIGHT + THUMB_VERT_PAD;
const THUMB_MARGIN = 24;
// Segmented Screenshots/Text toggle pinned at the top of the expanded column
// (pt-3 + control + pb-1.5) — added on top of each view's content height.
const COL_TOGGLE_HEIGHT = 46;
// Compact copied-text card estimate (4 clamped text lines + meta + padding).
const CLIP_ITEM_HEIGHT = 96;
const CLIP_GAP = 8; // gap-2

function computeThumbWindowHeight(count: number): number {
  if (count <= 0) return THUMB_MIN_HEIGHT + COL_TOGGLE_HEIGHT;
  const raw = count * THUMB_ITEM_HEIGHT + Math.max(0, count - 1) * THUMB_GAP + THUMB_VERT_PAD;
  return Math.max(THUMB_MIN_HEIGHT, Math.min(raw, THUMB_MAX_HEIGHT)) + COL_TOGGLE_HEIGHT;
}

// Clipboard view height: fit the card count, clamped to the same max as the
// screenshot list (internal scroll past that). Empty state gets one-card height.
function computeClipWindowHeight(count: number): number {
  if (count <= 0) return THUMB_MIN_HEIGHT + COL_TOGGLE_HEIGHT;
  const raw = count * CLIP_ITEM_HEIGHT + Math.max(0, count - 1) * CLIP_GAP + THUMB_VERT_PAD;
  return Math.max(THUMB_MIN_HEIGHT, Math.min(raw, THUMB_MAX_HEIGHT)) + COL_TOGGLE_HEIGHT;
}

function columnWindowHeight(view: ColumnView, thumbCount: number): number {
  return view === "clipboard"
    ? computeClipWindowHeight(useSyncStore.getState().clipboard.length)
    : computeThumbWindowHeight(thumbCount);
}
type CaptureMode = "region" | "fullscreen" | "window";

// Cosmetic window flags (decorations/title/alwaysOnTop/contentProtected) can
// throw on the borderless transparent macOS window. Run each one in isolation so
// a single failure can't abort the caller and skip the geometry calls that
// follow — that bug stranded the Library window in the thin edge "column"
// geometry (setSize/center never ran). geometry-from-cosmetic separation.
async function tweak(fn: () => Promise<void>) {
  try { await fn(); } catch (e) { console.error("window flag failed:", e); }
}

// Turn the (possibly column-geometry) main window into a normal decorated,
// centered window of the given size. Cosmetic flags are best-effort; the
// geometry (size → center → show → focus) ALWAYS runs.
async function showNormalWindow(
  w: ReturnType<typeof getCurrentWindow>,
  width: number,
  height: number,
  opts: { title?: string; resizable?: boolean; alwaysOnTop?: boolean; decorations?: boolean } = {},
) {
  if (opts.alwaysOnTop !== undefined) await tweak(() => w.setAlwaysOnTop(opts.alwaysOnTop!));
  await tweak(() => w.setContentProtected(false));
  if (opts.resizable !== undefined) await tweak(() => w.setResizable(opts.resizable!));
  await tweak(() => w.setDecorations(opts.decorations ?? true));
  if (opts.title !== undefined) await tweak(() => w.setTitle(opts.title!));
  try { await w.setSize(new LogicalSize(width, height)); } catch (e) { console.error("setSize failed:", e); }
  try { await w.center(); } catch (e) { console.error("center failed:", e); }
  try { await w.show(); } catch (e) { console.error("show failed:", e); }
  try { await w.setFocus(); } catch (e) { console.error("setFocus failed:", e); }
}

// Loading fallback for lazy loaded components
function LoadingFallback() {
  return (
    <div className="min-h-dvh flex items-center justify-center bg-background">
      <div className="flex items-center gap-2 text-muted-foreground">
        <svg className="animate-spin size-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        <span>Loading...</span>
      </div>
    </div>
  );
}

const DEFAULT_SHORTCUTS: KeyboardShortcut[] = [
  { id: "region", action: "Capture Region", shortcut: "CommandOrControl+Shift+2", enabled: true },
  { id: "fullscreen", action: "Capture Screen", shortcut: "CommandOrControl+Shift+F", enabled: false },
  { id: "window", action: "Capture Window", shortcut: "CommandOrControl+Shift+D", enabled: false },
];

// Cache the active display's logical geometry so expanding from the pill needs
// zero IPC. Refreshed on every placement. Fields are GLOBAL top-left-origin
// POINTS (the LogicalPosition space) — never divide by scaleFactor here.
let cachedMon: { left: number; top: number; height: number } | null = null;
function cacheRect(rect: { left: number; top: number; height: number }) {
  cachedMon = { left: rect.left, top: rect.top, height: rect.height };
}

// Resolve the rect of the physical display under a point (or the cursor when no
// point is given) via CoreGraphics (CGGetDisplaysWithPoint + CGDisplayBounds).
// winit's availableMonitors() reports positions in a single global PHYSICAL
// space, so dividing each monitor by its OWN scaleFactor mismatched the cursor's
// display across mixed-DPI setups (retina built-in + scale-1 externals). The CG
// rect is already in global top-left-origin POINTS = the LogicalPosition space.
async function cursorDisplayRect(
  mouseX?: number,
  mouseY?: number,
): Promise<{ left: number; top: number; width: number; height: number } | null> {
  try {
    const r = await invoke<[number, number, number, number] | null>("cursor_display_bounds", {
      x: mouseX,
      y: mouseY,
    });
    return r ? { left: r[0], top: r[1], width: r[2], height: r[3] } : null;
  } catch {
    return null;
  }
}

async function showThumbnailWindow(count: number, mouseX?: number, mouseY?: number) {
  const appWindow = getCurrentWindow();
  const height = computeThumbWindowHeight(count);

  // Kick off the display query immediately and run the geometry-independent
  // window flags concurrently, instead of awaiting ~6 IPC calls one-by-one.
  // Passing undefined coords lets Rust fall back to the current cursor.
  const rectPromise = cursorDisplayRect(mouseX, mouseY);
  const flags = Promise.all([
    appWindow.setDecorations(false).catch(() => {}),
    appWindow.setResizable(false).catch(() => {}),
    appWindow.setAlwaysOnTop(true).catch(() => {}),
    appWindow.setContentProtected(false).catch(() => {}),
  ]);

  let placed = false;
  try {
    const rect = await rectPromise;
    if (rect) {
      cacheRect(rect);
      const x = rect.left; // flush to the left screen edge (pill touches edge)
      const y = rect.top + Math.max(THUMB_MARGIN, (rect.height - height) / 2);
      await Promise.all([
        appWindow.setSize(new LogicalSize(THUMB_WIDTH, height)),
        appWindow.setPosition(new LogicalPosition(x, y)),
      ]);
      placed = true;
    }
  } catch {}

  if (!placed) {
    await appWindow.setSize(new LogicalSize(THUMB_WIDTH, height));
    await appWindow.center();
  }

  await flags;
  await appWindow.show();
}

// WebKit's :hover can go stale when the shared window is hidden and re-shown
// (e.g. right after the pairing window closes): no mouse event ever clears it,
// so the auto-hide poll would re-arm forever. Verify against the real cursor;
// on any failure err toward "hovering" (the pre-existing behavior).
async function cursorInsideWindow(): Promise<boolean> {
  try {
    const w = getCurrentWindow();
    const [pos, size, sf, [mx, my]] = await Promise.all([
      w.outerPosition(),
      w.outerSize(),
      w.scaleFactor(),
      invoke<[number, number]>("get_mouse_position"),
    ]);
    const x = pos.x / sf;
    const y = pos.y / sf;
    return mx >= x && mx < x + size.width / sf && my >= y && my < y + size.height / sf;
  } catch {
    return true;
  }
}

async function showCollapsedThumbnail() {
  const appWindow = getCurrentWindow();
  try { await appWindow.setDecorations(false); } catch {}
  try { await appWindow.setResizable(false); } catch {}
  await appWindow.setSize(new LogicalSize(COLLAPSED_WIDTH, COLLAPSED_HEIGHT));
  try {
    const rect = await cursorDisplayRect();
    if (rect) {
      cacheRect(rect);
      const x = rect.left;
      const y = rect.top + Math.max(THUMB_MARGIN, (rect.height - COLLAPSED_HEIGHT) / 2);
      await appWindow.setPosition(new LogicalPosition(x, y));
    }
  } catch {}
  try { await appWindow.setAlwaysOnTop(true); } catch {}
  try { await appWindow.setContentProtected(false); } catch {}
  await appWindow.show();
}

// Expand from the collapsed pill. The window is ALREADY visible with its flags
// set, so we skip the decoration/alwaysOnTop/show IPC (pure latency on expand)
// and only change geometry. Caller resizes while the column is still transparent
// (opacity 0, pre-reveal) so the grow/move is invisible — no jump.
async function expandThumbWindow(height: number) {
  const appWindow = getCurrentWindow();
  let mon = cachedMon;
  if (!mon) {
    const rect = await cursorDisplayRect();
    if (rect) cacheRect(rect);
    mon = cachedMon;
  }
  try {
    if (mon) {
      const x = mon.left;
      const y = mon.top + Math.max(THUMB_MARGIN, (mon.height - height) / 2);
      await Promise.all([
        appWindow.setPosition(new LogicalPosition(x, y)),
        appWindow.setSize(new LogicalSize(THUMB_WIDTH, height)),
      ]);
    } else {
      await appWindow.setSize(new LogicalSize(THUMB_WIDTH, height));
    }
  } catch {}
}

async function resizeThumbWindowKeepingBottom(count: number) {
  const appWindow = getCurrentWindow();
  try {
    let mon = cachedMon;
    if (!mon) {
      const rect = await cursorDisplayRect();
      if (rect) cacheRect(rect);
      mon = cachedMon;
    }
    const newH = computeThumbWindowHeight(count);
    let placed = false;
    if (mon) {
      const x = mon.left; // flush to the left screen edge (pill touches edge)
      const y = mon.top + Math.max(THUMB_MARGIN, (mon.height - newH) / 2);
      await appWindow.setSize(new LogicalSize(THUMB_WIDTH, newH));
      await appWindow.setPosition(new LogicalPosition(x, y));
      placed = true;
    }
    if (!placed) {
      await appWindow.setSize(new LogicalSize(THUMB_WIDTH, newH));
    }
  } catch (e) {
    console.error("resize thumb window failed:", e);
  }
}

function getEditorPathFromHash(): string | null {
  const params = new URLSearchParams(window.location.search);
  const editorPath = params.get("editor");
  if (editorPath) return editorPath;
  const h = window.location.hash || "";
  const m = h.match(/^#editor=(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

function EditorOnlyApp({ imagePath }: { imagePath: string }) {
  const [saveDir, setSaveDir] = useState<string>("");
  const lastCropPathRef = useRef<string | null>(null);

  useEffect(() => {
    (async () => {
      const w = getCurrentWindow();
      try { await w.setTitle(""); } catch {}
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const store = await Store.load("settings.json");
        const sd = await store.get<string>("saveDir");
        if (sd) setSaveDir(sd);
        else {
          try { setSaveDir(await invoke<string>("get_desktop_directory")); } catch {}
        }
      } catch (e) {
        try { setSaveDir(await invoke<string>("get_desktop_directory")); } catch {}
      }
    })();
  }, []);

  const onSave = async (editedImageData: string) => {
    try {
      if (!saveDir) {
        toast.error("Save directory not set");
        return;
      }
      const newPath = await invoke<string>("save_edited_image", {
        imageData: editedImageData,
        saveDir,
        copyToClip: true,
      });
      await emit("editor-saved", { originalPath: imagePath, newPath });
      editorActions.reset();
      try { await emit("editor-closed"); } catch {}
      // Let the event reach the main window before tearing this one down —
      // destroy() right after emit() can drop it (the auto-hide guard also
      // reconciles against real windows, this just avoids the 5s wait).
      await new Promise((r) => setTimeout(r, 60));
      try { await getCurrentWindow().destroy(); } catch (e) { console.error("destroy failed:", e); }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error("Failed to save image", { description: msg, duration: 5000 });
    }
  };

  const onCancel = async () => {
    editorActions.reset();
    try { await emit("editor-closed"); } catch {}
    await new Promise((r) => setTimeout(r, 60));
    try { await getCurrentWindow().destroy(); } catch (e) { console.error("destroy failed:", e); }
  };

  // Persist without closing — used by crop. Main window's folder poll picks it up.
  // Reuse the same file across crops in this editor session (overwrite, no pile-up).
  const onExport = async (dataUrl: string) => {
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
  };

  return (
    <Suspense fallback={<LoadingFallback />}>
      <ImageEditor imagePath={imagePath} onSave={onSave} onCancel={onCancel} onExport={onExport} />
    </Suspense>
  );
}

function App() {
  const editorPath = getEditorPathFromHash();
  if (editorPath) {
    return <EditorOnlyApp imagePath={editorPath} />;
  }
  return <MainApp />;
}

function MainApp() {
  const [mode, setMode] = useState<AppMode>("main");
  // Mirror `mode` into a ref so background pollers (folder watch) can tell when a
  // normal decorated window (library/preferences) is open and NOT yank it back
  // into the thin thumbnail-column geometry on a new screenshot.
  const modeRef = useRef<AppMode>("main");
  useEffect(() => { modeRef.current = mode; }, [mode]);
  const [saveDir, setSaveDir] = useState<string>("");
  const [copyToClipboard, setCopyToClipboard] = useState(true);
  const reportError = useCallback((msg: string) => {
    toast.error(msg, { duration: 5000 });
  }, []);
  const [isCapturing, setIsCapturing] = useState(false);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const thumbsRef = useRef<string[]>([]);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const isCollapsedRef = useRef(false);
  // Which list the edge column shows: local screenshot thumbnails or the
  // synced copied-text history. Ref mirrors state for stale-closure-free reads.
  const [columnView, setColumnView] = useState<ColumnView>("screenshots");
  const columnViewRef = useRef<ColumnView>("screenshots");
  const setColumnViewBoth = useCallback((view: ColumnView) => {
    columnViewRef.current = view;
    setColumnView(view);
  }, []);
  // Bumped to ask the thumbnail column to animate its collapse (auto-hide).
  const [collapseSignal, setCollapseSignal] = useState(0);
  // Bumped after the window is shown so the column replays its open animation
  // while actually visible (otherwise it animates behind a hidden window).
  const [openSignal, setOpenSignal] = useState(0);
  const autoHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openEditorsRef = useRef(0);
  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus | null>(null);
  const licenseStatusRef = useRef<LicenseStatus | null>(null);
  const [showPaywall, setShowPaywall] = useState(false);

  useEffect(() => {
    (async () => {
      const status = await loadLicenseStatus();
      setLicenseStatus(status);
      licenseStatusRef.current = status;
    })();
    const interval = setInterval(async () => {
      const status = await loadLicenseStatus();
      setLicenseStatus(status);
      licenseStatusRef.current = status;
    }, 60_000);
    return () => clearInterval(interval);
  }, []);

  // Follow the cursor across displays: while the edge pill / thumbnail column is
  // the visible surface, relocate it to whichever physical display the cursor is
  // currently on (flush-left, vertically centered) — live, not only at reveal.
  // Repositions only (never resizes), so it preserves collapsed-pill vs expanded-
  // column geometry and won't fight the genie animations or the auto-hide poll.
  useEffect(() => {
    const POLL_MS = 400;
    let busy = false;
    const id = setInterval(async () => {
      if (busy) return;
      // Only while the column/pill is the visible surface and not mid-use.
      if (modeRef.current === "pairing" || modeRef.current === "preferences") return;
      if (thumbsRef.current.length === 0) return;
      if (openEditorsRef.current > 0) return;
      busy = true;
      try {
        const w = getCurrentWindow();
        if (!(await w.isVisible())) return; // hidden → nothing to move
        const rect = await cursorDisplayRect(); // cursor's current display
        if (!rect) return;
        // Already on this display? (origins are integer CGDisplayBounds points.)
        if (cachedMon && rect.left === cachedMon.left && rect.top === cachedMon.top) return;
        // Don't yank the window out from under an active hover/interaction.
        if (await cursorInsideWindow()) return;
        // Relocate, preserving current size (collapsed pill vs expanded column).
        const sf = await w.scaleFactor();
        const size = await w.outerSize();
        const hLogical = size.height / sf;
        const x = rect.left;
        const y = rect.top + Math.max(THUMB_MARGIN, (rect.height - hLogical) / 2);
        await w.setPosition(new LogicalPosition(x, y));
        cacheRect(rect);
      } catch {
        // ignore transient IPC errors
      } finally {
        busy = false;
      }
    }, POLL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleActivated = useCallback(async (_key: string) => {
    const status = await loadLicenseStatus();
    setLicenseStatus(status);
    licenseStatusRef.current = status;
    setShowPaywall(false);
  }, []);

  // Boot the Firebase realtime sync engine once. It runs for the life of this
  // (always-alive, usually hidden) main webview — independent of which mode is
  // showing — so screenshot/clipboard sync keeps working in the background.
  // Defer + code-split Firebase off the critical path. The sync engine
  // transitively pulls in the whole Firebase SDK (~715KB); loading it before
  // first paint stalls the column. Dynamic-import it after the column paints.
  useEffect(() => {
    let cancelled = false;
    const start = () => {
      if (cancelled) return;
      import("@/lib/sync/engine")
        .then((m) => m.startSyncEngine())
        .catch((e) => console.error("sync engine start failed:", e));
    };
    if ("requestIdleCallback" in window) {
      (window as Window & { requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => void }).requestIdleCallback(start, { timeout: 1500 });
    } else {
      setTimeout(start, 200);
    }
    return () => {
      cancelled = true;
    };
  }, []);

  // Open a small, pairing-only decorated window (reuses the main window, like
  // Preferences). Just the QR + 6-digit code + enter-code field — no Library.
  // `autoStart` (tray "Sign in & Sync") makes SignInView open the browser
  // immediately instead of showing the "Sign in with phone" button. Launch
  // auto-present and post-logout reopen leave it off (normal CTA).
  const [pairingAutoStart, setPairingAutoStart] = useState(false);
  const openPairing = useCallback(async (autoStart = false) => {
    setPairingAutoStart(autoStart);
    await showNormalWindow(getCurrentWindow(), 420, 300, {
      title: "Sign in",
      resizable: false,
      alwaysOnTop: false,
    });
    setMode("pairing");
  }, []);

  // Closing a modal-style reuse of the shared window (pairing/preferences)
  // must hand it back to the column: restore the collapsed edge pill when
  // there are screenshots, otherwise hide entirely (the old behavior).
  const restoreColumnAfterModal = useCallback(async () => {
    setMode("main");
    const w = getCurrentWindow();
    await tweak(() => w.setDecorations(false));
    await tweak(() => w.setTitle(""));
    if (thumbsRef.current.length > 0) {
      isCollapsedRef.current = true;
      await showCollapsedThumbnail();
      setIsCollapsed(true);
      setMode("thumbnail");
    } else {
      try { await w.hide(); } catch (e) { console.error("hide failed:", e); }
    }
  }, []);

  const closePairing = restoreColumnAfterModal;

  // The sign-in window has no in-page Done button — the titlebar close button
  // hands the shared window back to the column instead of closing the app.
  useEffect(() => {
    if (mode !== "pairing") return;
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        unlisten = await getCurrentWindow().onCloseRequested((event) => {
          event.preventDefault();
          void closePairing();
        });
      } catch {}
    })();
    return () => { unlisten?.(); };
  }, [mode, closePairing]);

  const updateThumbs = useCallback((updater: (prev: string[]) => string[]) => {
    const next = updater(thumbsRef.current);
    thumbsRef.current = next;
    setThumbs(next);
    return next;
  }, []);

  // The capture publisher renames an own-capture cache file to carry its doc id
  // (`shot_{ts}.png` → `{docId}.png`) so the tile resolves its cloud doc by
  // filename. Swap the column's path in place when that happens — the save-dir
  // poll is the authoritative source of `thumbs`, so doing this keeps the
  // visible tile pointing at the renamed file and stops the poll from treating
  // the rename as a brand-new shot (which would re-surface the window + re-copy
  // the clipboard).
  useEffect(() => {
    registerRenameCapturePath((from, to) =>
      updateThumbs((prev) => prev.map((p) => (p === from ? to : p))),
    );
    return () => registerRenameCapturePath(null);
  }, [updateThumbs]);

  // Show the column, then trigger its open animation (now that it's visible).
  // Fresh reveals (capture / synced-in shot / dock click) always land on the
  // screenshots view so the new shot is what the user sees.
  const openThumbnailWindow = useCallback(async (count: number, mouseX?: number, mouseY?: number) => {
    setColumnViewBoth("screenshots");
    await showThumbnailWindow(count, mouseX, mouseY);
    // Wait for the freshly-shown window (already at final geometry, content
    // opacity:0) to paint before running the genie-in — a single rAF can fire
    // before the compositor shows it, which reads as a flash.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    setOpenSignal((n) => n + 1);
  }, [setColumnViewBoth]);

  // Idle-based auto-hide: restarts a 10s countdown on every pointer signal. There
  // is NO sticky "hovering" flag — a flag wedges open forever if a mouseleave is
  // missed (e.g. the window moves out from under a stationary cursor on open).
  // Instead, any activity re-arms the timer, and 5s of no activity collapses it.
  const startAutoHide = useCallback(() => {
    if (autoHideTimerRef.current) clearTimeout(autoHideTimerRef.current);
    autoHideTimerRef.current = null;
    if (isCollapsedRef.current || thumbsRef.current.length === 0) return;
    autoHideTimerRef.current = setTimeout(async () => {
      autoHideTimerRef.current = null;
      if (isCollapsedRef.current || thumbsRef.current.length === 0) return;
      // An open editor suspends auto-hide — but the editor destroys itself
      // right after emitting "editor-closed", so that event can be dropped
      // and the counter wedged > 0 forever. Reconcile against the actual
      // windows: only keep suspending if an editor-* window really exists.
      if (openEditorsRef.current > 0) {
        const countBefore = openEditorsRef.current;
        let anyEditor = true;
        try {
          anyEditor = (await getAllWebviewWindows()).some((w) =>
            w.label.startsWith("editor-"),
          );
        } catch {}
        // A new editor may have opened mid-await (its window might not be
        // listed yet) — trust the bumped counter over the stale snapshot.
        if (anyEditor || openEditorsRef.current > countBefore) {
          startAutoHide();
          return;
        }
        openEditorsRef.current = 0;
        // Re-check state that may have changed during the await; if a fresh
        // timer was armed meanwhile, defer to it instead of collapsing now.
        if (isCollapsedRef.current || thumbsRef.current.length === 0 || autoHideTimerRef.current) return;
      }
      // Pointer parked over the column (window) = still browsing — re-arm.
      // Checked live at fire time (no sticky hover flag, so a missed
      // mouseleave can't wedge it open: cursor off the window → next poll
      // collapses). Covers stationary hover and momentum scrolling, which
      // generate no mousemove to reset the timer.
      if (document.documentElement.matches(":hover") && (await cursorInsideWindow())) {
        startAutoHide();
        return;
      }
      // Play the slide-out animation (same as the manual collapse button)
      // rather than snapping straight to the collapsed pill.
      setCollapseSignal((n) => n + 1);
    }, 5_000);
  }, []);

  const pauseAutoHide = useCallback(() => {
    if (autoHideTimerRef.current) {
      clearTimeout(autoHideTimerRef.current);
      autoHideTimerRef.current = null;
    }
  }, []);

  const handleHoverChange = useCallback((_active: boolean) => {
    // Enter / move / leave all just re-arm the idle countdown.
    startAutoHide();
  }, [startAutoHide]);

  // Toggle Screenshots/Text while expanded: swap the view instantly (both
  // lists stay mounted), let the new content paint at the current size, then
  // resize the window to fit the active view. Content-stable-then-resize —
  // same anti-flash ordering as expand — so there's no jump.
  const handleColumnViewChange = useCallback(async (view: ColumnView) => {
    if (columnViewRef.current === view) return;
    setColumnViewBoth(view);
    startAutoHide();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    await expandThumbWindow(columnWindowHeight(view, thumbsRef.current.length));
  }, [setColumnViewBoth, startAutoHide]);
  const [shortcuts, setShortcuts] = useState<KeyboardShortcut[]>(DEFAULT_SHORTCUTS);
  const [settingsVersion, setSettingsVersion] = useState(0);
  const [tempDir, setTempDir] = useState<string>("/tmp");

  // Refs to hold current values for use in callbacks that may have stale closures
  const settingsRef = useRef({ saveDir, copyToClipboard, tempDir });
  const registeredShortcutsRef = useRef<Set<string>>(new Set());

  // Keep ref in sync with state
  useEffect(() => {
    settingsRef.current = { saveDir, copyToClipboard, tempDir };
  }, [saveDir, copyToClipboard, tempDir]);

  // Sign-out wipes the local screenshot history: delete the save folder's
  // screenshots and empty the column. Transition-gated (signedIn -> signedOut)
  // so a normal signed-out launch never touches local files.
  const prevAuthStateRef = useRef<string | null>(null);
  const syncAuthState = useSyncStore((s) => s.authState);
  useEffect(() => {
    const prev = prevAuthStateRef.current;
    prevAuthStateRef.current = syncAuthState;
    if (prev !== "signedIn" || syncAuthState !== "signedOut") return;
    (async () => {
      try {
        const dir = settingsRef.current.saveDir;
        if (dir) {
          const files = await invoke<string[]>("list_screenshots", { dir });
          await Promise.all(
            files.map((p) => invoke("delete_file", { path: p }).catch(() => {})),
          );
        }
      } catch (e) {
        console.error("clear local screenshots on sign-out failed:", e);
      }
      updateThumbs(() => []);
    })();
  }, [syncAuthState, updateThumbs]);

  // Auto-present the sign-in screen on launch when signed out. SyncShot is a
  // local-first tool and sync is additive, so this gate is DISMISSIBLE: the
  // pairing window's titlebar close (onCloseRequested -> closePairing) hands the
  // shared window back to the column / hides it, dropping the user into the
  // normal app. Re-openable any time via the tray "Sign in" entry (open-library).
  //
  // Fires once, on the first auth resolution after launch (loading -> resolved),
  // and only for signedOut — signedIn launches into the normal hidden column as
  // before. Gated by a ref so a later in-session sign-out doesn't yank the
  // pairing window back open. "error" is left alone (auto-presenting a login
  // that can't reach Firebase would just trap the user behind an error card).
  const didInitialAuthRouteRef = useRef(false);
  useEffect(() => {
    if (didInitialAuthRouteRef.current) return;
    if (syncAuthState === "loading") return; // wait for auth to resolve
    didInitialAuthRouteRef.current = true;
    if (syncAuthState === "signedOut") {
      void openPairing();
    }
  }, [syncAuthState, openPairing]);

  // Sign-in completed while the sign-in window is up (auto-presented on launch
  // or opened from the tray) — dismiss it and hand the shared window back to the
  // screenshots column instead of stranding the user on an account screen. The
  // signed-in folder watcher then hydrates and surfaces the column.
  useEffect(() => {
    if (mode === "pairing" && syncAuthState === "signedIn") {
      void closePairing();
    }
  }, [mode, syncAuthState, closePairing]);

  // Keep the tray menu in sync with auth: signed in → Preferences/Log Out/Quit,
  // signed out → Sign in & Sync/Preferences/Quit. Skip the transient
  // loading/error states (no menu flip until auth actually resolves).
  useEffect(() => {
    if (syncAuthState !== "signedIn" && syncAuthState !== "signedOut") return;
    invoke("update_tray_menu", { signedIn: syncAuthState === "signedIn" }).catch((e) =>
      console.error("update_tray_menu failed:", e),
    );
  }, [syncAuthState]);

  // Load settings function
  const loadSettings = useCallback(async () => {
    try {
      const store = await Store.load("settings.json", {
        defaults: { copyToClipboard: true },
        autoSave: true,
      });

      const savedCopyToClip = await store.get<boolean>("copyToClipboard");
      if (savedCopyToClip !== null && savedCopyToClip !== undefined) {
        setCopyToClipboard(savedCopyToClip);
      }

      const savedSaveDir = await store.get<string>("saveDir");
      if (savedSaveDir) {
        setSaveDir(savedSaveDir);
      }

      const savedShortcuts = await store.get<KeyboardShortcut[]>("keyboardShortcuts");
      if (savedShortcuts && savedShortcuts.length > 0) {
        // Merge saved shortcuts with defaults, preserving all saved values
        // Only add missing default shortcuts that don't exist in saved
        const savedIds = new Set(savedShortcuts.map((s) => s.id));
        const missingDefaults = DEFAULT_SHORTCUTS.filter((d) => !savedIds.has(d.id));
        const finalShortcuts = [...savedShortcuts, ...missingDefaults];
        setShortcuts(finalShortcuts);
      } else {
        setShortcuts(DEFAULT_SHORTCUTS);
      }
    } catch (err) {
      console.error("Failed to load settings:", err);
    }
  }, []);

  // Initial app setup
  useEffect(() => {
    const initializeApp = async () => {
      // These three are independent — fetch them concurrently instead of three
      // serial IPC round-trips on the critical path to showing the window.
      // defaultDir = hidden app-data screenshot cache (Firebase Storage is the
      // source of truth — captures sync to the cloud, this dir just backs fast
      // local display/edit/paste, never a Desktop folder). desktopRoot = legacy
      // plain Desktop, used to migrate old prefs; temp = canonicalized.
      const [desktopRes, rootRes, tempRes] = await Promise.allSettled([
        invoke<string>("get_desktop_directory"),
        invoke<string>("get_desktop_root"),
        invoke<string>("get_temp_directory"),
      ]);

      let defaultDir = "";
      if (desktopRes.status === "fulfilled") {
        defaultDir = desktopRes.value;
      } else {
        console.error("Failed to get Desktop directory:", desktopRes.reason);
        const reason = desktopRes.reason;
        reportError(`Failed to get Desktop directory: ${reason instanceof Error ? reason.message : String(reason)}`);
      }

      let desktopRoot = "";
      if (rootRes.status === "fulfilled") desktopRoot = rootRes.value;

      if (tempRes.status === "fulfilled") {
        setTempDir(tempRes.value);
      } else {
        console.error("Failed to get temp directory, using fallback:", tempRes.reason);
      }

      let effectiveSaveDir = defaultDir;

      // Load settings from store
      try {
        const store = await Store.load("settings.json", {
          defaults: { copyToClipboard: true },
          autoSave: true,
        });

        const savedCopyToClip = await store.get<boolean>("copyToClipboard");
        if (savedCopyToClip !== null && savedCopyToClip !== undefined) {
          setCopyToClipboard(savedCopyToClip);
        }

        const savedSaveDir = await store.get<string>("saveDir");
        const trimmed = savedSaveDir?.trim() ?? "";
        // Migrate users off any legacy Desktop save location — the plain
        // Desktop root AND the old ~/Desktop/ScreenshotX folder — onto the
        // hidden app-data cache default. Screenshots live in Firebase now.
        const legacyShotsDir = desktopRoot ? `${desktopRoot}/ScreenshotX` : "";
        const isLegacyDesktop =
          !!desktopRoot &&
          (trimmed === desktopRoot ||
            trimmed === `${desktopRoot}/` ||
            trimmed === legacyShotsDir ||
            trimmed === `${legacyShotsDir}/`);
        if (trimmed !== "" && !isLegacyDesktop) {
          effectiveSaveDir = trimmed;
        } else if (defaultDir) {
          effectiveSaveDir = defaultDir;
          await store.set("saveDir", defaultDir);
          await store.save();
        }
        setSaveDir(effectiveSaveDir);

        const savedShortcuts = await store.get<KeyboardShortcut[]>("keyboardShortcuts");
        if (savedShortcuts && savedShortcuts.length > 0) {
          setShortcuts(savedShortcuts);
        }
      } catch (err) {
        console.error("Failed to load settings:", err);
        if (defaultDir) {
          setSaveDir(defaultDir);
          effectiveSaveDir = defaultDir;
        }
      }

      // Column hydration from the save dir happens in the signed-in folder
      // watcher below — signed out, the column starts (and stays) empty.
    };

    initializeApp();

    // DEV ONLY: Uncomment to test editor with any image file
    // setMode("editing");
  }, []);

  // Hydrate + watch the save dir — only while signed in. The first pass after
  // sign-in loads existing files silently (no clipboard copy); later passes
  // catch files added/removed outside this app (e.g. synced from the phone).
  // Signed out, this never mounts: the column shows only session captures.
  useEffect(() => {
    if (!saveDir || syncAuthState !== "signedIn") return;
    let cancelled = false;
    let firstPass = true;

    const poll = async () => {
      try {
        const disk = await invoke<string[]>("list_screenshots", { dir: saveDir });
        if (cancelled) return;

        const isHydration = firstPass;
        firstPass = false;

        // BACKFILL: on the first pass after sign-in, publish the Mac's existing
        // local screenshot library to Firebase. Captures are otherwise only
        // uploaded by the live `new-screenshot` publisher, so anything taken
        // before sign-in (or before this device ever published) would never
        // reach users/{uid}/screenshots and the Mac would show empty on other
        // devices. publishScreenshot dedupes by sha256 so this never double-
        // uploads; skipped while sync is paused.
        if (isHydration && disk.length > 0) {
          const { uid, paused } = useSyncStore.getState();
          if (uid && !paused) {
            void Promise.all([
              import("@/lib/sync/screenshots"),
              import("@/lib/sync/engine"),
            ]).then(([{ backfillScreenshots }, { getDevice }]) => {
              const device = getDevice();
              if (device) {
                return backfillScreenshots(uid, device, disk).catch((e) =>
                  console.error("screenshot backfill failed:", e),
                );
              }
            });
          }
        }

        // Detect file add/remove by SET membership, not positional equality:
        // the column is ordered by creation time (below), which differs from the
        // mtime order `disk` arrives in, so a positional diff would fire every
        // poll. Re-ordering on doc/createdAt updates is handled by its own effect.
        const current = thumbsRef.current;
        const currentSet = new Set(current);
        const diskSet = new Set(disk);
        const newOnes = disk.filter((p) => !currentSet.has(p));
        const removed = current.some((p) => !diskSet.has(p));
        const hasNew = newOnes.length > 0;
        if (!hasNew && !removed) return;

        // Order newest-first by true creation time (doc createdAt → shot_{ts} →
        // mtime), NOT the raw mtime order `disk` comes in — see the bug where a
        // re-downloaded phone shot's fresh mtime floated it above an older Mac
        // capture on reopen.
        const next = updateThumbs(() => orderScreenshotsByCreatedAt(disk));

        // A normal decorated window (Library/Preferences) is showing — keep the
        // thumb list current but don't switch mode or re-apply column geometry,
        // or the open window collapses to the thin edge strip.
        if (modeRef.current === "pairing" || modeRef.current === "preferences") {
          return;
        }

        if (next.length > 0) {
          setMode("thumbnail");
          // New file arrived (or first hydration) — surface the window.
          if (hasNew) {
            // Copy the newest synced-in screenshot to this Mac's clipboard,
            // mirroring local-capture behavior and the user's auto-copy
            // setting — but not for pre-existing files on hydration.
            if (!isHydration && settingsRef.current.copyToClipboard) {
              invoke("copy_to_clipboard", { path: newOnes[0] })
                .then(() => {
                  toast.success("Screenshot copied to clipboard", { duration: 2000 });
                })
                .catch((err) => console.error("Failed to copy synced screenshot:", err));
            }
            isCollapsedRef.current = false;
            setIsCollapsed(false);
            await openThumbnailWindow(next.length);
            startAutoHide();
          }
        }
      } catch {
        // Dir may not exist yet / transient sync state — ignore.
      }
    };

    poll(); // hydrate immediately on sign-in rather than waiting an interval
    const interval = setInterval(poll, 2500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [saveDir, syncAuthState, updateThumbs, startAutoHide]);

  // Re-order the column whenever the synced doc set changes. On quit/reopen the
  // poll hydrates from disk BEFORE the Firebase subscription has loaded (it's
  // deferred off the critical path), so a received `{docId}.png` shot can't yet
  // resolve its createdAt and lands in mtime order. Once `screenshots` arrives,
  // re-sort in place so the newest shot — Mac or phone — settles on top and the
  // order is stable. Own `shot_{ts}` captures already sort right from the start
  // (their epoch is in the filename); this fixes the doc-id-named ones.
  const screenshotDocs = useScreenshots();
  useEffect(() => {
    const cur = thumbsRef.current;
    if (cur.length === 0) return;
    const ordered = orderScreenshotsByCreatedAt(cur);
    const same =
      ordered.length === cur.length && ordered.every((p, i) => p === cur[i]);
    if (!same) updateThumbs(() => ordered);
  }, [screenshotDocs, updateThumbs]);


  const handleCapture = useCallback(async (captureMode: CaptureMode = "region") => {
    if (isCapturing) return;

    if (licenseStatusRef.current?.state === "expired") {
      setShowPaywall(true);
      await showNormalWindow(getCurrentWindow(), 520, 640, {
        title: "Activate SyncShot",
      });
      setMode("main");
      return;
    }

    setIsCapturing(true);

    const appWindow = getCurrentWindow();
    
    // Read current settings from ref to avoid stale closure issues
    const { saveDir: currentSaveDir, copyToClipboard: shouldCopyToClipboard, tempDir: currentTempDir } = settingsRef.current;

    try {
      const hadThumbs = thumbsRef.current.length > 0;
      // Was the column already on screen (expanded) before this capture? If so we
      // prepend in place via geometry-only expand — no hide/reposition/re-show.
      const wasVisible = hadThumbs && !isCollapsedRef.current;
      if (hadThumbs) {
        try { await appWindow.setContentProtected(true); } catch {}
      } else {
        await appWindow.hide();
        await new Promise((resolve) => setTimeout(resolve, 400));
      }

      const commandMap: Record<CaptureMode, string> = {
        region: "native_capture_interactive",
        fullscreen: "native_capture_fullscreen",
        window: "native_capture_window",
      };

      const screenshotPath = await invoke<string>(commandMap[captureMode], {
        saveDir: currentTempDir,
      });

      // Get mouse position IMMEDIATELY after screenshot completes
      // This captures where the user finished their selection
      let mouseX: number | undefined;
      let mouseY: number | undefined;
      try {
        const [x, y] = await invoke<[number, number]>("get_mouse_position");
        mouseX = x;
        mouseY = y;
      } catch {
        // Silently fail - will fall back to centering
      }

      invoke("play_screenshot_sound").catch(console.error);

      let finalPath = screenshotPath;
      try {
        finalPath = await invoke<string>("save_native_screenshot", {
          sourcePath: screenshotPath,
          saveDir: currentSaveDir,
          copyToClip: shouldCopyToClipboard,
        });
        invoke("delete_file", { path: screenshotPath }).catch(() => {});
      } catch (err) {
        console.error("Failed to auto-save screenshot:", err);
        toast.error("Failed to save screenshot", {
          description: err instanceof Error ? err.message : String(err),
          duration: 4000,
        });
      }

      // Prepend the just-captured shot, then re-apply the creation-time order so
      // the session order matches what a quit/reopen will render. Its name is
      // `shot_{now}.png`, so its capture epoch ranks it on top — and it stays on
      // top after reopen (its createdAt/shot_{ts} outranks every existing shot).
      const next = updateThumbs((prev) =>
        orderScreenshotsByCreatedAt([finalPath, ...prev]),
      );
      setMode("thumbnail");
      isCollapsedRef.current = false;
      setIsCollapsed(false);
      if (wasVisible) {
        // Column was already visible: instantly prepend the new shot. Reset
        // content protection in place (no hide) and only adjust geometry —
        // skip show/reposition-to-cursor/openSignal so there's no flash or
        // open-animation replay.
        // In clipboard view the geometry already fits that list — keep it; the
        // shot is saved + prepended and shows when the user switches back.
        try { await appWindow.setContentProtected(false); } catch {}
        await expandThumbWindow(columnWindowHeight(columnViewRef.current, next.length));
      } else {
        // Was hidden/collapsed / first screenshot: full reveal at the cursor.
        await openThumbnailWindow(next.length, mouseX, mouseY);
      }
      startAutoHide();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (thumbsRef.current.length > 0) {
        // Restore the column to its prior collapsed/expanded state (and turn off
        // content protection). Re-expanding unconditionally here left the window
        // at full size while still rendering the collapsed dark handle — the big
        // dark overlay bug on cancel/error from the collapsed pill.
        if (isCollapsedRef.current) {
          await showCollapsedThumbnail();
        } else {
          await openThumbnailWindow(thumbsRef.current.length);
        }
      } else {
        try { await appWindow.hide(); } catch {}
      }
      if (errorMessage.includes("cancelled") || errorMessage.includes("was cancelled")) {
        // user cancelled — silent
      } else if (errorMessage.includes("already in progress")) {
        toast.error("Please wait for the current screenshot to complete", { duration: 4000 });
      } else if (
        errorMessage.toLowerCase().includes("permission") ||
        errorMessage.toLowerCase().includes("access") ||
        errorMessage.toLowerCase().includes("denied")
      ) {
        toast.error("Screen Recording permission required", {
          description:
            "System Settings → Privacy & Security → Screen Recording → enable SyncShot, then restart.",
          duration: 8000,
        });
      } else {
        reportError(errorMessage);
      }
    } finally {
      setIsCapturing(false);
    }
  }, [isCapturing, updateThumbs, reportError]);

  // Setup hotkeys whenever settings change
  useEffect(() => {
    const setupHotkeys = async () => {
      try {
        const shortcutsToUnregister = Array.from(registeredShortcutsRef.current);
        if (shortcutsToUnregister.length > 0) {
          try {
            await unregister(shortcutsToUnregister);
          } catch (err) {
            console.error("Failed to unregister shortcuts:", err);
          }
        }
        registeredShortcutsRef.current.clear();
        
        const actionMap: Record<string, CaptureMode> = {
          "Capture Region": "region",
          "Capture Screen": "fullscreen",
          "Capture Window": "window",
        };

        for (const shortcut of shortcuts) {
          if (!shortcut.enabled) continue;
          
          const action = actionMap[shortcut.action];
          if (action) {
            try {
              await register(shortcut.shortcut, () => handleCapture(action));
              registeredShortcutsRef.current.add(shortcut.shortcut);
            } catch (err) {
              console.error(`Failed to register shortcut ${shortcut.shortcut}:`, err);
            }
          }
        }
      } catch (err) {
        console.error("Failed to setup hotkeys:", err);
        reportError(`Hotkey registration failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    setupHotkeys();

    return () => {
      const shortcutsToUnregister = Array.from(registeredShortcutsRef.current);
      if (shortcutsToUnregister.length > 0) {
        unregister(shortcutsToUnregister).catch(console.error);
      }
      registeredShortcutsRef.current.clear();
    };
  }, [shortcuts, settingsVersion, handleCapture]);

  // Setup tray menu event listeners - only once on mount
  useEffect(() => {
    let unlisten1: (() => void) | null = null;
    let unlisten2: (() => void) | null = null;
    let unlisten3: (() => void) | null = null;
    let unlisten4: (() => void) | null = null;
    let unlisten5: (() => void) | null = null;
    let unlisten6: (() => void) | null = null;

    const setupListeners = async () => {
      unlisten1 = await listen("capture-triggered", () => handleCapture("region"));
      unlisten2 = await listen("capture-fullscreen", () => handleCapture("fullscreen"));
      unlisten3 = await listen("capture-window", () => handleCapture("window"));
      unlisten4 = await listen("open-preferences", async () => {
        await showNormalWindow(getCurrentWindow(), 640, 620, {
          title: "Preferences",
          resizable: true,
          alwaysOnTop: false,
        });
        setMode("preferences");
      });
      unlisten5 = await listen<{ originalPath: string; newPath: string }>(
        "editor-saved",
        async (event) => {
          const { originalPath, newPath } = event.payload;
          if (!newPath) return;
          updateThumbs((prev) => prev.map((p) => (p === originalPath ? newPath : p)));
          if (originalPath && originalPath !== newPath) {
            invoke("delete_file", { path: originalPath }).catch(() => {});
          }
          toast.success("Screenshot copied to clipboard", { duration: 2000 });
        }
      );
      unlisten6 = await listen("editor-closed", () => {
        openEditorsRef.current = Math.max(0, openEditorsRef.current - 1);
        if (openEditorsRef.current === 0) {
          startAutoHide();
        }
      });
      const unlisten7 = await listen("open-license", async () => {
        await showNormalWindow(getCurrentWindow(), 520, 640, {
          title: "Activate SyncShot",
        });
        setMode("main");
        setShowPaywall(true);
      });
      // Dock-icon click / second launch (emitted from Rust). If the column is
      // hidden, resurface it: expanded if there are screenshots, otherwise the
      // collapsed edge pill. If a window is already visible, just focus it.
      const unlisten8 = await listen("surface-column", async () => {
        try {
          const w = getCurrentWindow();
          if (await w.isVisible()) { await w.setFocus(); return; }
        } catch {}
        // Resurface under the cursor's display, not wherever the pill last sat.
        let mx: number | undefined;
        let my: number | undefined;
        try {
          [mx, my] = await invoke<[number, number]>("get_mouse_position");
        } catch {}
        cachedMon = null;
        if (thumbsRef.current.length > 0) {
          isCollapsedRef.current = false;
          setIsCollapsed(false);
          await openThumbnailWindow(thumbsRef.current.length, mx, my);
        } else {
          await showCollapsedThumbnail();
          isCollapsedRef.current = true;
          setIsCollapsed(true);
        }
      });
      // Tray "Sign in & Sync" opens the small sign-in window AND immediately
      // launches the browser sign-in (autoStart) — no intermediate button click.
      const unlisten9 = await listen("open-library", () => { openPairing(true); });
      // Tray "Log Out" signs this device out (engine is code-split off the
      // critical path, so pull it in lazily). authState → signedOut then flips
      // the tray menu back via the bridge effect above.
      const unlisten10 = await listen("tray-logout", () => {
        import("@/lib/sync/engine")
          .then((m) => m.signOutDevice())
          .catch((e) => console.error("tray logout failed:", e));
      });
      const prevCleanup = unlisten6;
      unlisten6 = () => { prevCleanup(); unlisten7(); unlisten8(); unlisten9(); unlisten10(); };
    };

    setupListeners();

    return () => {
      unlisten1?.();
      unlisten2?.();
      unlisten3?.();
      unlisten4?.();
      unlisten5?.();
      unlisten6?.();
    };
  }, [handleCapture, updateThumbs, startAutoHide]);

  // Reload settings when coming back from preferences
  const handleSettingsChange = useCallback(async () => {
    await loadSettings();
    setSettingsVersion(v => v + 1);
  }, [loadSettings]);

  const handleBackFromPreferences = useCallback(async () => {
    await loadSettings();
    setSettingsVersion(v => v + 1);
    await restoreColumnAfterModal();
  }, [loadSettings, restoreColumnAfterModal]);

  const handleThumbnailItemEdit = useCallback(async (path: string) => {
    if (licenseStatusRef.current?.state === "expired") {
      setShowPaywall(true);
      await showNormalWindow(getCurrentWindow(), 520, 640, {
        title: "Activate SyncShot",
      });
      setMode("main");
      return;
    }
    const label = `editor-${Date.now()}`;
    try {
      openEditorsRef.current += 1;
      pauseAutoHide();
      // Make sure a local file is actually present before opening. Own-device
      // captures normally have their local capture file, but if it's been
      // evicted (the same gap that strands the tile on "Unavailable") this
      // re-downloads the cloud copy so the editor always has bytes to open.
      let openPath = path;
      try {
        const { ensureLocalScreenshot } = await import("@/lib/sync/screenshots");
        openPath = await ensureLocalScreenshot(path);
      } catch (e) {
        console.error("ensure local screenshot failed:", e);
      }
      // Copy the screenshot to the clipboard on open (fire-and-forget so it
      // never delays the editor window).
      invoke("copy_to_clipboard", { path: openPath })
        .then(() => toast.success("Copied to clipboard", { duration: 1500 }))
        .catch((e) => console.error("copy on open failed:", e));
      await invoke("open_editor_window", {
        label,
        imagePath: openPath,
      });
    } catch (err) {
      openEditorsRef.current = Math.max(0, openEditorsRef.current - 1);
      startAutoHide();
      console.error("open_editor_window failed:", err);
      toast.error("Failed to open editor");
    }
  }, [pauseAutoHide, startAutoHide]);

  const handleThumbnailItemRemove = useCallback(async (path: string) => {
    const remaining = updateThumbs((prev) => prev.filter((p) => p !== path));
    // Propagate the delete to Firebase so the doc + Storage blobs are removed
    // and the subscription doesn't resync the shot back onto this (or any
    // other) device. deleteScreenshotByPath reads the file for its content
    // hash, deletes the cloud doc/blobs, THEN deletes the local file — so we
    // must NOT delete the local file first or the hash lookup races it. Signed
    // out (no uid), there's no cloud doc; just drop the local file.
    const { uid } = useSyncStore.getState();
    if (uid) {
      void import("@/lib/sync/screenshots").then(({ deleteScreenshotByPath }) =>
        deleteScreenshotByPath(uid, path).catch((e) => {
          console.error("cloud delete failed:", e);
          invoke("delete_file", { path }).catch(() => {});
        }),
      );
    } else {
      invoke("delete_file", { path }).catch(() => {});
    }
    if (remaining.length === 0) {
      try { await getCurrentWindow().hide(); } catch {}
      if (autoHideTimerRef.current) {
        clearTimeout(autoHideTimerRef.current);
        autoHideTimerRef.current = null;
      }
      setMode("main");
      setIsCollapsed(false);
      isCollapsedRef.current = false;
    } else if (!isCollapsedRef.current) {
      await resizeThumbWindowKeepingBottom(remaining.length);
    }
  }, [updateThumbs]);

  const handleToggleCollapsed = useCallback(async () => {
    const next = !isCollapsedRef.current;
    if (autoHideTimerRef.current) {
      clearTimeout(autoHideTimerRef.current);
      autoHideTimerRef.current = null;
    }
    if (next) {
      // COLLAPSE. triggerCollapse already played the genie-out so the column is
      // fully invisible (opacity:0, curled into the pill). Resize the native
      // window DOWN to the pill while the (invisible) column is still the rendered
      // element, and ONLY THEN swap to the pill render. Doing it the other way —
      // setIsCollapsed(true) before the resize — paints the full-screen pill box
      // inside the still-column-sized window for a frame: that was the close flash.
      isCollapsedRef.current = true;
      await showCollapsedThumbnail();
      setIsCollapsed(true);
    } else {
      // EXPAND. Sequence: render column invisible -> resize window to final
      // geometry -> wait for that resize to actually PAINT -> run the genie-in.
      isCollapsedRef.current = false;
      setIsCollapsed(false);
      // Double rAF so React doesn't just COMMIT the swap but the pill-removed /
      // opacity:0 column state is actually COMPOSITED to screen before we touch
      // native geometry. A single rAF fires after the commit but before paint, so
      // the old collapsed pill was still on screen during the resize and rode the
      // window's top edge upward (the "pill jumps up, vanishes, returns"). Two
      // frames guarantee the pill is painted away first → the centered grow is
      // invisible and the genie unfurls in place.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      await expandThumbWindow(columnWindowHeight(columnViewRef.current, thumbsRef.current.length));
      // Double rAF: a single rAF fires BEFORE the native resize is composited to
      // screen, so the genie would start inside a pill-sized window (the "jump up").
      // Two frames guarantee the new window geometry has painted before we reveal.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      setOpenSignal((n) => n + 1);
      startAutoHide();
    }
  }, [startAutoHide]);

  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    if (mode === "thumbnail") {
      root.classList.add("bs-transparent");
      body.classList.add("bs-transparent");
    } else {
      root.classList.remove("bs-transparent");
      body.classList.remove("bs-transparent");
    }
  }, [mode]);

  if (mode === "thumbnail" && thumbs.length > 0) {
    return (
      <ScreenshotThumbnail
        paths={thumbs}
        isCollapsed={isCollapsed}
        collapseSignal={collapseSignal}
        openSignal={openSignal}
        columnView={columnView}
        onColumnViewChange={handleColumnViewChange}
        onEdit={handleThumbnailItemEdit}
        onRemove={handleThumbnailItemRemove}
        onToggleCollapsed={handleToggleCollapsed}
        onHoverChange={handleHoverChange}
      />
    );
  }

  if (mode === "pairing") {
    // The shared native window is transparent (for the column overlay) — the
    // pairing UI needs its own opaque backdrop or the desktop shows through.
    return (
      <div className="h-dvh w-full overflow-hidden bg-background text-foreground">
        <Suspense fallback={<LoadingFallback />}>
          <SignInView autoStart={pairingAutoStart} />
        </Suspense>
      </div>
    );
  }

  if (mode === "preferences") {
    return (
      <Suspense fallback={<LoadingFallback />}>
        <PreferencesPage
          onBack={handleBackFromPreferences}
          onSettingsChange={handleSettingsChange}
          onLoggedOut={openPairing}
        />
      </Suspense>
    );
  }

  if (showPaywall || licenseStatus?.state === "expired") {
    return (
      <Paywall
        reason={licenseStatus?.state === "expired" ? "expired" : "manual"}
        onActivated={handleActivated}
        onClose={() => setShowPaywall(false)}
      />
    );
  }

  return null;
}

export default App;

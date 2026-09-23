import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Effect,
  EffectState,
  getCurrentWindow,
  LogicalPosition,
  LogicalSize,
} from "@tauri-apps/api/window";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { Store } from "@tauri-apps/plugin-store";
import type { KeyboardShortcut } from "./components/preferences/KeyboardShortcutManager";
import { toast } from "sonner";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { loadLicenseStatus, type LicenseStatus } from "@/lib/license";
import { Paywall } from "@/components/Paywall";
// Light module (zustand + types only — no Firebase): safe in the entry chunk.
import {
  loadMoreScreenshots,
  registerIncomingScreenshotPreview,
  registerIncomingScreenshotSaved,
  registerRenameCapturePath,
  useSyncStore,
} from "@/stores/syncStore";
import { cacheThumbBlob, cacheThumbDataUrl, clearThumbs, cloneThumb, dropThumb } from "@/lib/thumbCache";
// Firebase-FREE column ordering (own module so the heavy Firebase SDK stays off
// this startup-critical path): order the edge column by each screenshot's true
// creation time, not file mtime.
import {
  cloudScreenshotPath,
  cloudScreenshotId,
  importScreenshotPath,
  isCloudScreenshotPath,
  isImportScreenshotPath,
  isSyncedCacheFile,
  orderScreenshotsByCreatedAt,
} from "@/lib/sync/order";
import { omitPendingPaths, replaceRailPath } from "@/lib/railPaths";
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
// The collapsed launcher has to be wide enough to be discoverable at the
// display edge. The former 18px handle was technically clickable but was
// practically invisible against a dark desktop, which made the pill appear to
// be missing. Keep the expanded rail at a compact 240px and size its items
// from the remaining content width.
const COLLAPSED_WIDTH = 24;
const COLLAPSED_HEIGHT = 72;
const RAIL_RADIUS = 20;
const THUMB_INNER_PAD_X = COLLAPSED_WIDTH + 16; // launcher + list px-1/pr-3
const THUMB_ITEM_HEIGHT = Math.round((THUMB_WIDTH - THUMB_INNER_PAD_X) * 3 / 4); // 4:3 aspect
const THUMB_GAP = 20; // gap-5
const THUMB_VERT_PAD = 32; // py-4
const THUMB_VISIBLE_COUNT = 5; // start scrolling after five screenshots
const SCREENSHOT_COLUMN_AUTO_HIDE_MS = 5_000;
const THUMB_MAX_HEIGHT =
  THUMB_VISIBLE_COUNT * THUMB_ITEM_HEIGHT +
  (THUMB_VISIBLE_COUNT - 1) * THUMB_GAP +
  THUMB_VERT_PAD;
const THUMB_MIN_HEIGHT = THUMB_ITEM_HEIGHT + THUMB_VERT_PAD;
// Segmented Screenshots/Text toggle pinned at the top of the expanded column
// (pt-3 + control + pb-1.5) — added on top of each view's content height.
const COL_TOGGLE_HEIGHT = 46;
// Compact copied-text card estimate (4 clamped text lines + meta + padding).
const CLIP_ITEM_HEIGHT = 96;
const CLIP_GAP = 8; // gap-2
// The rail visibly holds five screenshots. Fetch a small buffer, then page
// older cache entries only when the user reaches the end of that list.

/** True only for files owned by SyncShot's current write/cache directory.
 * Legacy Desktop screenshots are deliberately display-only: viewing them in
 * the pill must never upload, copy, rename, or delete the user's originals. */
function isManagedScreenshotPath(path: string, dir: string): boolean {
  if (isCloudScreenshotPath(path) || isImportScreenshotPath(path)) return true;
  if (
    path.startsWith("/tmp/") ||
    path.startsWith("/private/tmp/") ||
    path.startsWith("/var/folders/") ||
    path.startsWith("/private/var/folders/")
  ) return true;
  if (!dir) return false;
  const root = dir.endsWith("/") ? dir : `${dir}/`;
  return path.startsWith(root);
}

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
  // The edge rail is intentionally an all-Spaces/fullscreen overlay. The same
  // native window becomes Library/Preferences/Paywall, where that behavior is
  // wrong: restore normal macOS Space management before showing the decorated
  // view. The native command is a no-op on other platforms.
  try { await invoke("set_pill_all_spaces", { enable: false }); } catch (e) { console.error("restore normal Space behavior failed:", e); }
  // Native vibrancy belongs only to the edge pill/rail. Normal app surfaces
  // provide their own opaque backgrounds.
  await tweak(() => w.clearEffects());
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

type DisplayRect = { left: number; top: number; width: number; height: number };

// Cache the display's true AppKit visibleFrame. It is already the usable work
// area (menu bar and Dock excluded) in Tauri's logical-position coordinate
// space, so the compact launcher and full-height rail can share one centre.
let cachedMon: DisplayRect | null = null;
let cachedWorkArea: DisplayRect | null = null;
function cacheRect(rect: DisplayRect, workArea: DisplayRect = rect) {
  cachedMon = rect;
  cachedWorkArea = workArea;
}

function centeredPillY(workArea: DisplayRect): number {
  return Math.round(
    workArea.top + Math.max(0, (workArea.height - COLLAPSED_HEIGHT) / 2),
  );
}

// Resolve the usable rect of the physical display under a point (or the cursor
// when no point is given) via CoreGraphics hit-testing + NSScreen.visibleFrame.
// winit's availableMonitors() reports positions in a single global PHYSICAL
// space, so dividing each monitor by its OWN scaleFactor mismatched the cursor's
// display across mixed-DPI setups (retina built-in + scale-1 externals). The
// rect is already in global top-left-origin POINTS = LogicalPosition space.
async function cursorDisplayRect(
  mouseX?: number,
  mouseY?: number,
): Promise<DisplayRect | null> {
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

function expandedColumnGeometry(
  view: ColumnView,
  workArea: DisplayRect,
): { height: number; y: number } {
  if (view === "screenshots") {
    return { height: workArea.height, y: workArea.top };
  }
  const height = Math.min(
    computeClipWindowHeight(useSyncStore.getState().clipboard.length),
    workArea.height,
  );
  return {
    height,
    y: workArea.top + Math.max(0, (workArea.height - height) / 2),
  };
}

async function showThumbnailWindow(count: number, mouseX?: number, mouseY?: number) {
  const appWindow = getCurrentWindow();
  const fallbackHeight = computeThumbWindowHeight(count);

  // Restore overlay behavior whenever this shared window returns to the pill.
  // Without this, opening Preferences once left future rails confined to the
  // current Space instead of following the user across desktops/fullscreen apps.
  try { await invoke("set_pill_all_spaces", { enable: true }); } catch (e) { console.error("set pill Space behavior failed:", e); }

  // Kick off the display query immediately and run the geometry-independent
  // window flags concurrently, instead of awaiting ~6 IPC calls one-by-one.
  // Passing undefined coords lets Rust fall back to the current cursor.
  const rectPromise = cursorDisplayRect(mouseX, mouseY);
  const flags = Promise.all([
    appWindow.setDecorations(false).catch(() => {}),
    appWindow.setResizable(false).catch(() => {}),
    appWindow.setAlwaysOnTop(true).catch(() => {}),
    appWindow.setContentProtected(false).catch(() => {}),
    appWindow.setEffects({
      effects: [Effect.Sidebar],
      state: EffectState.Active,
      radius: RAIL_RADIUS,
    }).catch(() => {}),
  ]);

  let placed = false;
  try {
    const rect = await rectPromise;
    if (rect) {
      const x = rect.left; // flush to the left screen edge (pill touches edge)
      cacheRect(rect, rect);
      await Promise.all([
        appWindow.setSize(new LogicalSize(THUMB_WIDTH, rect.height)),
        appWindow.setPosition(new LogicalPosition(x, rect.top)),
      ]);
      placed = true;
    }
  } catch {}

  if (!placed) {
    await appWindow.setSize(new LogicalSize(THUMB_WIDTH, fallbackHeight));
    await appWindow.center();
  }

  await flags;
  await appWindow.show();
}

// WebKit's :hover can go stale when the shared window is hidden and re-shown
// (e.g. right after the pairing window closes). Verify against the real cursor
// before the display-follow poll moves the window; on failure err toward
// "hovering" so an active control surface is never yanked away.
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
  try { await invoke("set_pill_all_spaces", { enable: true }); } catch (e) { console.error("set pill Space behavior failed:", e); }
  try { await appWindow.setDecorations(false); } catch {}
  try { await appWindow.setResizable(false); } catch {}
  // Native NSVisualEffectView always owns the window's full rectangular layer.
  // Even with a corner radius it left a faint glass square visible outside the
  // CSS capsule. The small launcher uses its own clipped translucent surface;
  // native Sidebar vibrancy is restored only when the full rail expands.
  try { await appWindow.clearEffects(); } catch {}
  await appWindow.setSize(new LogicalSize(COLLAPSED_WIDTH, COLLAPSED_HEIGHT));
  try {
    const rect = await cursorDisplayRect();
    if (rect) {
      const x = rect.left;
      cacheRect(rect, rect);
      const y = centeredPillY(rect);
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
async function expandThumbWindow(view: ColumnView, thumbCount: number) {
  const appWindow = getCurrentWindow();
  let display = cachedMon;
  let workArea = cachedWorkArea;
  if (!display || !workArea) {
    const rect = await cursorDisplayRect();
    if (rect) {
      cacheRect(rect, rect);
    }
    display = cachedMon;
    workArea = cachedWorkArea;
  }
  try {
    await appWindow.setEffects({
      effects: [Effect.Sidebar],
      state: EffectState.Active,
      radius: RAIL_RADIUS,
    }).catch(() => {});
    if (display && workArea) {
      const x = display.left;
      const { height, y } = expandedColumnGeometry(view, workArea);
      await Promise.all([
        appWindow.setPosition(new LogicalPosition(x, y)),
        appWindow.setSize(new LogicalSize(THUMB_WIDTH, height)),
      ]);
    } else {
      const height = view === "screenshots"
        ? computeThumbWindowHeight(thumbCount)
        : computeClipWindowHeight(useSyncStore.getState().clipboard.length);
      await appWindow.setSize(new LogicalSize(THUMB_WIDTH, height));
    }
  } catch {}
}

async function resizeThumbWindowKeepingBottom(count: number) {
  const appWindow = getCurrentWindow();
  try {
    let display = cachedMon;
    let workArea = cachedWorkArea;
    if (!display || !workArea) {
      const rect = await cursorDisplayRect();
      if (rect) {
        cacheRect(rect, rect);
      }
      display = cachedMon;
      workArea = cachedWorkArea;
    }
    let placed = false;
    if (display && workArea) {
      const x = display.left; // flush to the left screen edge (pill touches edge)
      const newH = workArea.height;
      const y = workArea.top;
      await appWindow.setSize(new LogicalSize(THUMB_WIDTH, newH));
      await appWindow.setPosition(new LogicalPosition(x, y));
      placed = true;
    }
    if (!placed) {
      await appWindow.setSize(new LogicalSize(THUMB_WIDTH, computeThumbWindowHeight(count)));
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

// ImageEditor handles save/close/export internally now that the editor window
// is a reused singleton — this shell only titles the window and mounts it.
function EditorOnlyApp({ imagePath }: { imagePath: string }) {
  useEffect(() => {
    (async () => {
      const w = getCurrentWindow();
      try { await w.setTitle(""); } catch {}
    })();
  }, []);

  return (
    <Suspense fallback={<LoadingFallback />}>
      <ImageEditor imagePath={imagePath} />
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
  // The edge pill is the app's persistent launcher, not a by-product of having
  // screenshots in memory. Starting in its collapsed state means opening
  // SyncShot always gives the user a visible, tappable surface while the local
  // cache and Firebase hydrate in the background.
  const [mode, setMode] = useState<AppMode>("thumbnail");
  // Mirror `mode` into a ref so background pollers (folder watch) can tell when a
  // normal decorated window (library/preferences) is open and NOT yank it back
  // into the thin thumbnail-column geometry on a new screenshot.
  const modeRef = useRef<AppMode>("thumbnail");
  useEffect(() => { modeRef.current = mode; }, [mode]);
  const [saveDir, setSaveDir] = useState<string>("");
  const [legacyCacheDir, setLegacyCacheDir] = useState<string>("");
  const [copyToClipboard, setCopyToClipboard] = useState(true);
  const reportError = useCallback((msg: string) => {
    toast.error(msg, { duration: 5000 });
  }, []);
  // Global-shortcut handlers receive both Pressed and Released events. Keep the
  // capture lock in a ref so it flips synchronously before a second event can
  // enter; React state is intentionally too late for this kind of IPC callback.
  const isCapturingRef = useRef(false);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const thumbsRef = useRef<string[]>([]);
  const pillPageLoadingRef = useRef(false);
  // A local scan or Firestore callback can observe a file while deletion is
  // still running. Suppress those paths until the operation settles so an
  // optimistic delete/replace cannot visually resurrect the old screenshot.
  const pendingRemovalPathsRef = useRef<Set<string>>(new Set());
  // Editor crops can arrive faster than Storage/Firestore round-trips. Process
  // replacements in order: publish crop N before crop N+1 removes its file.
  const editorReplacementQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [isCollapsed, setIsCollapsed] = useState(true);
  const isCollapsedRef = useRef(true);
  // Which list the edge column shows: local screenshot thumbnails or the
  // synced copied-text history. Ref mirrors state for stale-closure-free reads.
  const [columnView, setColumnView] = useState<ColumnView>("screenshots");
  const columnViewRef = useRef<ColumnView>("screenshots");
  const setColumnViewBoth = useCallback((view: ColumnView) => {
    columnViewRef.current = view;
    setColumnView(view);
  }, []);
  // Bumped after the window is shown so the column replays its open animation
  // while actually visible (otherwise it animates behind a hidden window).
  const [openSignal, setOpenSignal] = useState(0);
  const [autoCollapseSignal, setAutoCollapseSignal] = useState(0);
  const autoHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openEditorsRef = useRef(0);
  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus | null>(null);
  const licenseStatusRef = useRef<LicenseStatus | null>(null);
  const [showPaywall, setShowPaywall] = useState(false);
  const didShowInitialPillRef = useRef(false);

  // A macOS resize is asynchronous to React. If a delayed collapse resize lands
  // after another render, the native surface can be pill-width while the webview
  // still tries to paint the full screenshot column (the vertical strip of
  // thumbnail fragments reported in the UI). Treat native pill geometry as the
  // authoritative safety signal and immediately select the pill renderer.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void getCurrentWindow().onResized(({ payload: size }) => {
      // `onResized` reports physical pixels. A 18 logical-px pill is 36 px on a
      // Retina display; 96 leaves room for scale factors without ever matching
      // the 240 logical-px expanded rail.
      if (modeRef.current !== "thumbnail" || size.width > 96 || isCollapsedRef.current) return;
      isCollapsedRef.current = true;
      setIsCollapsed(true);
    }).then((stop) => { unlisten = stop; }).catch(() => {});
    return () => { unlisten?.(); };
  }, []);

  // The native window starts hidden. Once settings resolve, surface a compact
  // launcher even if the cache is empty (or still downloading). Without this,
  // opening SyncShot during hydration showed an invisible/blank tiny window
  // because the old code rendered the pill only after the first image arrived.
  useEffect(() => {
    if (didShowInitialPillRef.current || !saveDir) return;
    didShowInitialPillRef.current = true;
    isCollapsedRef.current = true;
    setIsCollapsed(true);
    setMode("thumbnail");
    void showCollapsedThumbnail().catch((error) =>
      console.error("show initial pill failed:", error),
    );
  }, [saveDir]);

  useEffect(() => {
    // Only setState on a REAL change: the poll used to store a fresh object
    // every 60s, which re-rendered MainApp (and everything non-memoized under
    // it) once a minute for no reason.
    const applyStatus = (status: LicenseStatus) => {
      const prev = licenseStatusRef.current;
      licenseStatusRef.current = status;
      if (!prev || JSON.stringify(prev) !== JSON.stringify(status)) {
        setLicenseStatus(status);
      }
    };
    (async () => {
      applyStatus(await loadLicenseStatus());
    })();
    const interval = setInterval(async () => {
      applyStatus(await loadLicenseStatus());
    }, 60_000);
    return () => clearInterval(interval);
  }, []);

  // Cursor parked on/inside the column (per its enter/leave/move handlers) —
  // used to pause the display-follow poll: relocating only matters when the
  // cursor is AWAY from the window, so polling IPC while the user is hovering
  // or focused on it is pure churn.
  const columnHoveredRef = useRef(false);

  // Follow the cursor across displays: while the edge pill / thumbnail column is
  // the visible surface, relocate it to whichever physical display the cursor is
  // currently on (flush-left, vertically centered) — live, not only at reveal.
  // Repositions only (never resizes), so it preserves collapsed-pill vs expanded-
  // column geometry and won't fight the genie animations.
  useEffect(() => {
    const POLL_MS = 400;
    let busy = false;
    const id = setInterval(async () => {
      if (busy) return;
      // Only while the column/pill is the visible surface and not mid-use.
      if (modeRef.current === "pairing" || modeRef.current === "preferences") return;
      if (openEditorsRef.current > 0) return;
      // Paused while the window is focused or the cursor is inside it (both
      // sync checks — no IPC). :hover cross-checks the hover ref because
      // either alone can go stale when the window moves/hides under a
      // stationary cursor.
      if (document.hasFocus()) return;
      if (columnHoveredRef.current && document.documentElement.matches(":hover")) return;
      busy = true;
      try {
        const w = getCurrentWindow();
        if (!(await w.isVisible())) return; // hidden → nothing to move
        const rect = await cursorDisplayRect(); // cursor's current display
        if (!rect) return;
        // `rect` is the true usable work area, so both states share its centre.
        // Re-check geometry even on the same display. macOS can reposition a
        // borderless window after Space/Dock changes; the old display-only
        // early return permanently preserved that vertical drift.
        const x = rect.left;
        const workArea = rect;
        cacheRect(rect, workArea);
        const [position, size, scaleFactor] = await Promise.all([
          w.outerPosition(),
          w.outerSize(),
          w.scaleFactor(),
        ]);
        const currentX = position.x / scaleFactor;
        const currentY = position.y / scaleFactor;
        const currentWidth = size.width / scaleFactor;
        const currentHeight = size.height / scaleFactor;
        if (isCollapsedRef.current) {
          const y = centeredPillY(workArea);
          const alreadyPlaced =
            Math.abs(currentX - x) < 1 &&
            Math.abs(currentY - y) < 1 &&
            Math.abs(currentWidth - COLLAPSED_WIDTH) < 1 &&
            Math.abs(currentHeight - COLLAPSED_HEIGHT) < 1;
          if (alreadyPlaced || await cursorInsideWindow()) return;
          await Promise.all([
            w.setSize(new LogicalSize(COLLAPSED_WIDTH, COLLAPSED_HEIGHT)),
            w.setPosition(new LogicalPosition(x, y)),
          ]);
        } else {
          const { height, y } = expandedColumnGeometry(
            columnViewRef.current,
            workArea,
          );
          const alreadyPlaced =
            Math.abs(currentX - x) < 1 &&
            Math.abs(currentY - y) < 1 &&
            Math.abs(currentWidth - THUMB_WIDTH) < 1 &&
            Math.abs(currentHeight - height) < 1;
          if (alreadyPlaced || await cursorInsideWindow()) return;
          await Promise.all([
            w.setSize(new LogicalSize(THUMB_WIDTH, height)),
            w.setPosition(new LogicalPosition(x, y)),
          ]);
        }
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

  // Single-window sign-in. The hosted phone-auth window (a real https origin —
  // required for reCAPTCHA) is the ONLY sign-in surface: number → OTP → done all
  // happen in that one window. There is NO separate in-app launcher. Dynamic
  // import keeps the Firebase SDK off the startup-critical entry chunk. If the
  // window is dismissed or times out without a token we stay signed out — the
  // tray "Sign in & Sync" (and relaunch) re-open it. (Kept the openPairing name
  // for its existing call sites: launch, tray, capture-gate, post-logout.)
  const [pairingAutoStart] = useState(false);
  const openPairing = useCallback(async () => {
    try {
      const { startBrowserSignIn } = await import("@/lib/sync/firebase");
      await startBrowserSignIn(true);
    } catch {
      /* dismissed / timed out — stay signed out; tray re-triggers sign-in */
    }
  }, []);

  // Closing a modal-style reuse of the shared window (pairing/preferences)
  // always hands it back to the collapsed edge pill. The launcher remains
  // useful even while the screenshot cache is empty or still hydrating.
  const restoreColumnAfterModal = useCallback(async () => {
    const w = getCurrentWindow();
    await tweak(() => w.setDecorations(false));
    await tweak(() => w.setTitle(""));
    isCollapsedRef.current = true;
    setIsCollapsed(true);
    setMode("thumbnail");
    // The React surface changes first, so a delayed native IPC call can never
    // squeeze Preferences or the screenshot column into pill-sized geometry.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    try {
      await showCollapsedThumbnail();
    } catch (error) {
      console.error("restore collapsed pill failed:", error);
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

  // Keep the pill's source list bounded. The native command returns one page
  // already sorted newest-first; orderScreenshotsByCreatedAt refines that with
  // Firestore timestamps once they are available.
  const mergeThumbPages = useCallback((incoming: string[]) => {
    return updateThumbs((current) => {
      const seen = new Set<string>();
      const visibleIncoming = omitPendingPaths(incoming, pendingRemovalPathsRef.current);
      const visibleCurrent = omitPendingPaths(current, pendingRemovalPathsRef.current);
      const merged = [...visibleIncoming, ...visibleCurrent].filter((path) => {
        if (seen.has(path)) return false;
        seen.add(path);
        return true;
      });
      return orderScreenshotsByCreatedAt(merged);
    });
  }, [updateThumbs]);

  const loadOlderPillPage = useCallback(async () => {
    if (pillPageLoadingRef.current) return;
    pillPageLoadingRef.current = true;
    try {
      if (useSyncStore.getState().screenshotsHasMore) loadMoreScreenshots();
    } finally {
      pillPageLoadingRef.current = false;
    }
  }, []);

  // The capture publisher renames an own-capture cache file to carry its doc id
  // (`shot_{ts}.png` → `{docId}.png`) so the tile resolves its cloud doc by
  // filename. Swap the column's path in place when that happens — the save-dir
  // poll is the authoritative source of `thumbs`, so doing this keeps the
  // visible tile pointing at the renamed file and stops the poll from treating
  // the rename as a brand-new shot (which would re-surface the window + re-copy
  // the clipboard).
  useEffect(() => {
    registerRenameCapturePath((from, to) => {
      void cloneThumb(from, to)
        .catch(() => {})
        .finally(() => {
          updateThumbs((prev) =>
            prev.includes(from) ? replaceRailPath(prev, from, to) : prev,
          );
          dropThumb(from);
        });
    });
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

  // Keep outside clicks inert, but collapse an expanded screenshot column five
  // seconds after capture/reveal. Signal the child so its existing genie-out
  // animation runs before native window geometry shrinks back to the pill.
  const startAutoHide = useCallback(() => {
    if (autoHideTimerRef.current) clearTimeout(autoHideTimerRef.current);
    autoHideTimerRef.current = setTimeout(() => {
      autoHideTimerRef.current = null;
      if (
        modeRef.current !== "thumbnail" ||
        isCollapsedRef.current ||
        openEditorsRef.current > 0
      ) return;
      setAutoCollapseSignal((signal) => signal + 1);
    }, SCREENSHOT_COLUMN_AUTO_HIDE_MS);
  }, []);

  const pauseAutoHide = useCallback(() => {
    if (autoHideTimerRef.current) {
      clearTimeout(autoHideTimerRef.current);
      autoHideTimerRef.current = null;
    }
  }, []);

  useEffect(() => pauseAutoHide, [pauseAutoHide]);

  const handleHoverChange = useCallback((active: boolean) => {
    columnHoveredRef.current = active;
    if (active) {
      pauseAutoHide();
    } else if (!isCollapsedRef.current) {
      // Full grace period begins only after pointer leaves rail. Scroll/wheel
      // activity reports active too, so timer cannot expire mid-interaction.
      startAutoHide();
    }
  }, [pauseAutoHide, startAutoHide]);

  const handleColumnActivity = useCallback(() => {
    // Hover already pauses timer. Keyboard/inertial scrolling after pointer
    // leaves instead restarts full grace period without creating stuck hover.
    if (!columnHoveredRef.current && !isCollapsedRef.current) startAutoHide();
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
    await expandThumbWindow(view, thumbsRef.current.length);
  }, [setColumnViewBoth, startAutoHide]);
  const [shortcuts, setShortcuts] = useState<KeyboardShortcut[]>(DEFAULT_SHORTCUTS);
  const [settingsVersion, setSettingsVersion] = useState(0);
  const [tempDir, setTempDir] = useState<string>("/tmp");

  // Refs to hold current values for use in callbacks that may have stale closures
  const settingsRef = useRef({ saveDir, copyToClipboard, tempDir });
  const registeredShortcutsRef = useRef<Set<string>>(new Set());
  // One physical key press may be delivered to more than one surviving plugin
  // callback during a settings/StrictMode re-registration, and key repeat can
  // emit additional Pressed events. This shared latch admits exactly one
  // capture until that shortcut's Released event arrives.
  const shortcutKeysDownRef = useRef<Set<string>>(new Set());
  // A burst of remote docs may arrive in one Firestore snapshot. Their paths
  // should all merge immediately, but only one native show/genie sequence may
  // run at a time (otherwise the column visibly opens twice).
  const incomingRevealRef = useRef<Promise<void> | null>(null);

  // Keep ref in sync with state
  useEffect(() => {
    settingsRef.current = { saveDir, copyToClipboard, tempDir };
  }, [saveDir, copyToClipboard, tempDir]);

  // Remote fast path: Firestore publishes a small WebP before the full image.
  // Insert the future cache path immediately, so ThumbnailItem falls back to
  // that Firebase thumbnail and the pill paints while the full upload/download
  // continues. When the full bytes land at the same path, the second callback
  // enables local copy/edit without waiting for the 2.5s folder poll.
  useEffect(() => {
    registerIncomingScreenshotPreview((_item, cloudPath) => {
      if (pendingRemovalPathsRef.current.has(cloudPath)) return;
      const next = mergeThumbPages([cloudPath]);

      if (modeRef.current === "pairing" || modeRef.current === "preferences") return;
      setMode("thumbnail");
      setColumnViewBoth("screenshots");

      void (async () => {
        try {
          const visible = await getCurrentWindow().isVisible();
          if (!isCollapsedRef.current && visible) {
            await resizeThumbWindowKeepingBottom(next.length);
            startAutoHide();
            return;
          }
        } catch {}

        if (incomingRevealRef.current) return;
        isCollapsedRef.current = false;
        setIsCollapsed(false);
        const reveal = openThumbnailWindow(next.length)
          .then(() => startAutoHide())
          .finally(() => {
            if (incomingRevealRef.current === reveal) incomingRevealRef.current = null;
          });
        incomingRevealRef.current = reveal;
        await reveal;
      })();
    });

    registerIncomingScreenshotSaved((item, cloudPath) => {
      if (pendingRemovalPathsRef.current.has(cloudPath)) return;
      if (settingsRef.current.copyToClipboard) {
        import("@/lib/sync/screenshots")
          .then(({ copyScreenshotToClipboard }) =>
            copyScreenshotToClipboard(cloudScreenshotPath(item.id, item.sha256)),
          )
          .then(() => toast.success("Screenshot copied to clipboard", { duration: 2000 }))
          .catch((err) => console.error("Failed to copy synced screenshot:", err));
      }
    });

    return () => {
      registerIncomingScreenshotPreview(null);
      registerIncomingScreenshotSaved(null);
    };
  }, [mergeThumbPages, openThumbnailWindow, setColumnViewBoth, startAutoHide, updateThumbs]);

  // Sign-out clears only in-memory rail state. Firebase remains authoritative;
  // no persistent screenshot library exists on this Mac.
  const prevAuthStateRef = useRef<string | null>(null);
  const syncAuthState = useSyncStore((s) => s.authState);
  useEffect(() => {
    const prev = prevAuthStateRef.current;
    prevAuthStateRef.current = syncAuthState;
    if (prev !== "signedIn" || syncAuthState !== "signedOut") return;
    updateThumbs(() => []);
    clearThumbs();
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
        setLegacyCacheDir(defaultDir);
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

  // One-time migration: upload any old unsynced private-cache files, then
  // remove every confirmed cloud-backed file. Never scans or deletes Desktop
  // or a user-selected directory.
  const didMigrateCacheRef = useRef(false);
  useEffect(() => {
    if (
      didMigrateCacheRef.current ||
      syncAuthState !== "signedIn" ||
      !legacyCacheDir
    ) return;
    didMigrateCacheRef.current = true;
    void (async () => {
      try {
        const files = await invoke<string[]>("list_screenshots", {
          dir: legacyCacheDir,
        });
        const confirmedCloud = files.filter(isSyncedCacheFile);
        const unpublished = files.filter((path) => !isSyncedCacheFile(path));
        await Promise.all(
          confirmedCloud.map((path) =>
            invoke("delete_file", { path }).catch(() => {}),
          ),
        );
        if (unpublished.length > 0) {
          const [{ backfillScreenshots }, { getDevice }] = await Promise.all([
            import("@/lib/sync/screenshots"),
            import("@/lib/sync/engine"),
          ]);
          const device = getDevice();
          const uid = useSyncStore.getState().uid;
          if (device && uid) {
            await backfillScreenshots(uid, device, unpublished);
          }
        }
        await invoke("remove_legacy_screenshot_directory");
      } catch (error) {
        console.error("private screenshot cache migration failed:", error);
      }
    })();
  }, [legacyCacheDir, syncAuthState]);

  // Cloud-only rail. Firestore already delivers newest-first and grows only
  // when the user scrolls. Keep short-lived capture/editor staging files until
  // their upload maps them to a stable cloud id; never hydrate from disk.
  useEffect(() => {
    const syncCloudRail = () => {
      const state = useSyncStore.getState();
      if (state.authState !== "signedIn") return;
      const cloudIds = new Set(state.screenshots.map((item) => item.id));
      // Keep an edited screenshot's old cloud identity suppressed until the
      // realtime snapshot confirms deletion. Clearing it when deleteDoc merely
      // returns can expose old + edited tiles for one listener round-trip.
      for (const path of pendingRemovalPathsRef.current) {
        const id = cloudScreenshotId(path) ?? state.localCaptureDocIds[path];
        if (id && !cloudIds.has(id)) pendingRemovalPathsRef.current.delete(path);
      }
      updateThumbs((current) => {
        const staged = current.filter((path) => {
          if (isCloudScreenshotPath(path)) return false;
          const mapped = state.localCaptureDocIds[path];
          // Publisher owns staged→cloud swap after it has cloned the already-
          // decoded optimistic thumb. Keep staging visible until that callback.
          return !mapped || !cloudIds.has(mapped) ||
            !current.some((candidate) => cloudScreenshotId(candidate) === mapped);
        });
        const stagedCloudIds = new Set(
          staged
            .map((path) => state.localCaptureDocIds[path])
            .filter((id): id is string => !!id),
        );
        const cloud = state.screenshots
          .filter((item) => !stagedCloudIds.has(item.id))
          .map((item) => cloudScreenshotPath(item.id, item.sha256));
        const next = omitPendingPaths([...staged, ...cloud], pendingRemovalPathsRef.current);
        const seen = new Set<string>();
        return next.filter((path) => !seen.has(path) && !!seen.add(path));
      });
    };
    syncCloudRail();
    return useSyncStore.subscribe((state, prevState) => {
      if (
        state.screenshots !== prevState.screenshots ||
        state.localCaptureDocIds !== prevState.localCaptureDocIds ||
        state.authState !== prevState.authState
      ) syncCloudRail();
    });
  }, [updateThumbs]);


  const handleCapture = useCallback(async (captureMode: CaptureMode = "region") => {
    if (isCapturingRef.current) return;

    // Sign-in gate: SyncShot is sync-first, so capturing is blocked until the user
    // has an account. Read the live store (not a closure) so stale auth can't slip
    // a shot through; bounce to the sign-in window instead of capturing.
    if (useSyncStore.getState().authState !== "signedIn") {
      toast.error("Sign in to SyncShot to capture");
      void openPairing();
      return;
    }

    if (licenseStatusRef.current?.state === "expired") {
      setShowPaywall(true);
      await showNormalWindow(getCurrentWindow(), 520, 640, {
        title: "Activate SyncShot",
      });
      setMode("main");
      return;
    }

    isCapturingRef.current = true;

    const appWindow = getCurrentWindow();
    // Keep the pre-capture surface so an Escape/capture/save failure always
    // restores the pill instead of leaving the whole Tauri window hidden.
    const wasCollapsedBeforeCapture = isCollapsedRef.current;
    const hadThumbsBeforeCapture = thumbsRef.current.length > 0;

    // Read current settings from ref to avoid stale closure issues
    const { copyToClipboard: shouldCopyToClipboard, tempDir: currentTempDir } = settingsRef.current;

    try {
      // Hide every form of the pill while the native capture picker is active,
      // so it can never end up in the captured image. The failure path below is
      // deliberately independent of the thumbnail count: an empty pill is still
      // the app's control surface and must be restored too.
      try { await appWindow.hide(); } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));

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

      const finalPath = screenshotPath;
      // Keep the staging file alive until NSPasteboard has copied its bytes.
      // The upload publisher deletes this file, so starting both operations
      // independently created a race on fast connections.
      const clipboardReady = shouldCopyToClipboard
        ? invoke("copy_to_clipboard", { path: finalPath }).catch((error) => {
            console.error("capture clipboard copy failed:", error);
            toast.error("Could not copy screenshot", { duration: 4000 });
          })
        : Promise.resolve();

      // Prepend the just-captured shot, then re-apply the creation-time order so
      // the session order matches what a quit/reopen will render. Its name is
      // `shot_{now}.png`, so its capture epoch ranks it on top — and it stays on
      // top after reopen (its createdAt/shot_{ts} outranks every existing shot).
      const next = updateThumbs((prev) => [
        finalPath,
        ...prev.filter((path) => path !== finalPath),
      ]);

      // Upload starts immediately from the staging file. publishScreenshot
      // switches the rail to cloud identity after the tiny thumb/doc lands,
      // continues the full upload, then deletes this temp file.
      void clipboardReady.then(() => Promise.all([
        import("@/lib/sync/screenshots"),
        import("@/lib/sync/engine"),
      ])).then(([{ publishScreenshot }, { getDevice }]) => {
        const { uid } = useSyncStore.getState();
        const device = getDevice();
        if (!uid || !device) throw new Error("Sync device unavailable");
        return publishScreenshot(uid, device, finalPath);
      }).catch((error) => {
        console.error("capture cloud upload failed:", error);
        toast.error("Screenshot upload failed", { duration: 5000 });
      });
      // The native window is hidden at this point, so requestAnimationFrame may
      // be suspended indefinitely by WebKit. Commit the expanded React surface
      // synchronously, then let openThumbnailWindow show it immediately.
      flushSync(() => {
        setMode("thumbnail");
        isCollapsedRef.current = false;
        setIsCollapsed(false);
      });
      await openThumbnailWindow(next.length, mouseX, mouseY);
      startAutoHide();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      // The native picker is allowed to fail/cancel, but it is never allowed to
      // close the pill. Restore the exact prior form (or the collapsed control
      // if the rail did not yet have content).
      if (wasCollapsedBeforeCapture || !hadThumbsBeforeCapture) {
        // Same hidden-window rule as the success path: never wait for an
        // animation frame before calling show(). A hidden WebKit view may not
        // produce one until the user manually reopens the app from the Dock.
        flushSync(() => {
          setMode("thumbnail");
          isCollapsedRef.current = true;
          setIsCollapsed(true);
        });
        await showCollapsedThumbnail();
      } else {
        flushSync(() => {
          setMode("thumbnail");
          isCollapsedRef.current = false;
          setIsCollapsed(false);
        });
        await openThumbnailWindow(thumbsRef.current.length);
        startAutoHide();
      }

      const normalizedError = errorMessage.toLowerCase();
      if (normalizedError.includes("cancelled")) {
        // user cancelled — silent
      } else if (normalizedError.includes("already in progress")) {
        toast.error("Please wait for the current screenshot to complete", { duration: 4000 });
      } else if (
        normalizedError.includes("permission") ||
        normalizedError.includes("access") ||
        normalizedError.includes("denied")
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
      isCapturingRef.current = false;
    }
  }, [updateThumbs, reportError, openPairing, openThumbnailWindow, startAutoHide]);

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
              await register(shortcut.shortcut, (event) => {
                if (event.state === "Released") {
                  shortcutKeysDownRef.current.delete(event.shortcut);
                  return;
                }
                if (shortcutKeysDownRef.current.has(event.shortcut)) return;
                shortcutKeysDownRef.current.add(event.shortcut);
                void handleCapture(action);
              });
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
      shortcutKeysDownRef.current.clear();
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
      unlisten5 = await listen<{ originalPath: string; newPath: string; previewDataUrl?: string }>(
        "editor-saved",
        (event) => {
          const { originalPath, newPath, previewDataUrl } = event.payload;
          if (!newPath) return;

          // Editor sends a compact preview with the save event. Seed and swap
          // synchronously: one edited tile replaces the original in one render,
          // without local thumbnail generation or Firebase round-trips.
          if (previewDataUrl) cacheThumbDataUrl(newPath, previewDataUrl);
          if (originalPath && originalPath !== newPath) {
            pendingRemovalPathsRef.current.add(originalPath);
          }
          updateThumbs((prev) => replaceRailPath(prev, originalPath, newPath));
          dropThumb(originalPath);

          const replacement = editorReplacementQueueRef.current
            .catch(() => {})
            .then(async () => {
              const { uid } = useSyncStore.getState();
              if (uid) {
                const [{ deleteScreenshotByPath, findDocForCachePath, publishScreenshotReplacement }, { getDevice }] = await Promise.all([
                  import("@/lib/sync/screenshots"),
                  import("@/lib/sync/engine"),
                ]);
                const device = getDevice();
                if (!device) throw new Error("Sync device unavailable");
                // Upload replacement first. Old cloud image stays valid until
                // the new thumb/full are safely stored.
                const originalDocId = originalPath
                  ? findDocForCachePath(originalPath)?.id ?? cloudScreenshotId(originalPath)
                  : null;
                const result = await publishScreenshotReplacement(uid, device, newPath);
                // An unchanged export can dedupe to the original document.
                // Never delete the document that now backs the replacement.
                if (
                  originalPath &&
                  originalPath !== newPath &&
                  result?.docId !== originalDocId
                ) {
                  await deleteScreenshotByPath(uid, originalPath);
                }
              } else if (originalPath && originalPath !== newPath) {
                await invoke("delete_file", { path: originalPath });
              }
            });

          editorReplacementQueueRef.current = replacement
            .catch((error) => {
              console.error("edited screenshot replacement failed:", error);
              toast.error("Could not sync edited screenshot", { duration: 5000 });
            })
            .finally(() => {
              if (originalPath && originalPath !== newPath) {
                const state = useSyncStore.getState();
                const id = cloudScreenshotId(originalPath) ?? state.localCaptureDocIds[originalPath];
                if (!id) pendingRemovalPathsRef.current.delete(originalPath);
              }
            });
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
        cachedWorkArea = null;
        if (thumbsRef.current.length > 0) {
          isCollapsedRef.current = false;
          setIsCollapsed(false);
          await openThumbnailWindow(thumbsRef.current.length, mx, my);
        } else {
          isCollapsedRef.current = true;
          setIsCollapsed(true);
          setMode("thumbnail");
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          await showCollapsedThumbnail();
        }
      });
      // Tray "Sign in & Sync" → straight into the single hosted auth window
      // (same one-window flow as launch); no intermediate launcher card.
      const unlisten9 = await listen("open-library", () => { void openPairing(); });
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

  const handleAddImage = useCallback((file: File) => {
    const state = useSyncStore.getState();
    if (state.authState !== "signedIn" || !state.uid) {
      toast.error("Sign in to SyncShot to add an image");
      void openPairing();
      return;
    }
    const supported = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
    if (!supported.has(file.type.toLowerCase())) {
      toast.error("Choose a PNG, JPEG, GIF, or WebP image");
      return;
    }
    if (file.size === 0 || file.size > 64 * 1024 * 1024) {
      toast.error(file.size === 0 ? "That image is empty" : "Image must be smaller than 64 MB");
      return;
    }

    // Show the user's chosen bytes immediately from memory. No Application
    // Support cache file is created; this temporary identity lives only until
    // Firebase has the full image and the publisher swaps in its cloud id.
    const stagingPath = importScreenshotPath();
    cacheThumbBlob(stagingPath, file);
    updateThumbs((prev) => [stagingPath, ...prev.filter((path) => path !== stagingPath)]);
    startAutoHide();

    void Promise.all([
      import("@/lib/sync/screenshots"),
      import("@/lib/sync/engine"),
    ]).then(([{ publishImportedImage }, { getDevice }]) => {
      const liveUid = useSyncStore.getState().uid;
      const device = getDevice();
      if (!liveUid || !device) throw new Error("Sync device unavailable");
      return publishImportedImage(liveUid, device, stagingPath, file);
    }).then(() => {
      toast.success("Image added", { duration: 1800 });
    }).catch(async (error) => {
      const mappedId = useSyncStore.getState().localCaptureDocIds[stagingPath];
      updateThumbs((prev) => prev.filter((path) =>
        path !== stagingPath && (!mappedId || cloudScreenshotId(path) !== mappedId),
      ));
      dropThumb(stagingPath);
      if (mappedId) {
        const { deleteScreenshotByPath } = await import("@/lib/sync/screenshots");
        await deleteScreenshotByPath(state.uid!, cloudScreenshotPath(mappedId)).catch(() => {});
      }
      console.error("manual image upload failed:", error);
      toast.error("Could not add image", {
        description: error instanceof Error ? error.message : "Upload failed — check your connection",
        duration: 5000,
      });
    });
  }, [openPairing, startAutoHide, updateThumbs]);

  const handleThumbnailItemEdit = useCallback(async (path: string) => {
    if (!isManagedScreenshotPath(path, saveDir)) {
      toast.info("Desktop screenshots are shown read-only");
      return;
    }
    if (licenseStatusRef.current?.state === "expired") {
      setShowPaywall(true);
      await showNormalWindow(getCurrentWindow(), 520, 640, {
        title: "Activate SyncShot",
      });
      setMode("main");
      return;
    }
    // The editor is a reused singleton window (pre-warmed hidden at startup),
    // so at most ONE editor is ever open — set the counter, don't increment,
    // or open→open→close would wedge it above zero and pause display-follow.
    const label = "editor-main";
    try {
      openEditorsRef.current = 1;
      pauseAutoHide();
      let imageUrl: string | undefined;
      let previewUrl: string | undefined;
      if (isCloudScreenshotPath(path)) {
        const {
          findDocForCachePath,
          resolveScreenshotFullImageUrl,
          resolveScreenshotThumbnailUrl,
        } = await import("@/lib/sync/screenshots");
        const item = findDocForCachePath(path);
        if (!item?.fullPath) throw new Error("Screenshot is still uploading");
        // Use the SAME versioned URLs as the viewport preloader. Rust's RAM
        // cache is URL-keyed; passing Firestore's raw unversioned URLs here
        // caused every click to miss preloaded bytes and redownload for 2-3s.
        const [resolvedImageUrl, resolvedPreviewUrl] = await Promise.all([
          resolveScreenshotFullImageUrl(item),
          resolveScreenshotThumbnailUrl(item),
        ]);
        if (!resolvedImageUrl) throw new Error("Screenshot is still uploading");
        imageUrl = resolvedImageUrl;
        previewUrl = resolvedPreviewUrl ?? undefined;
      } else {
        void invoke("copy_to_clipboard", { path })
          .then(() => toast.success("Copied to clipboard", { duration: 1500 }))
          .catch((e) => console.error("copy on open failed:", e));
      }
      await invoke("open_editor_window", {
        label,
        imagePath: path,
        imageUrl,
        previewUrl,
      });
    } catch (err) {
      openEditorsRef.current = 0;
      startAutoHide();
      console.error("open_editor_window failed:", err);
      toast.error("Failed to open editor");
    }
  }, [pauseAutoHide, saveDir, startAutoHide]);

  const handleThumbnailItemRemove = useCallback(async (path: string) => {
    if (!isManagedScreenshotPath(path, saveDir)) {
      toast.info("Desktop screenshots are shown read-only");
      return;
    }
    pendingRemovalPathsRef.current.add(path);
    const remaining = updateThumbs((prev) => prev.filter((p) => p !== path));
    // Free (and revoke) the deleted shot's cached thumbnail blob URL.
    dropThumb(path);
    // Propagate the delete to Firebase so the doc + Storage blobs are removed
    // and the subscription doesn't resync the shot back onto this (or any
    // other) device. deleteScreenshotByPath reads the file for its content
    // hash, deletes the cloud doc/blobs, THEN deletes the local file — so we
    // must NOT delete the local file first or the hash lookup races it. Signed
    // out (no uid), there's no cloud doc; just drop the local file.
    const remove = async () => {
      try {
        const { uid } = useSyncStore.getState();
        if (uid) {
          const { deleteScreenshotByPath } = await import("@/lib/sync/screenshots");
          await deleteScreenshotByPath(uid, path);
        } else {
          await invoke("delete_file", { path });
        }
      } catch (error) {
        // Deletion did not complete. Restore the tile instead of pretending it
        // succeeded only for it to return after relaunch.
        console.error("screenshot delete failed:", error);
        pendingRemovalPathsRef.current.delete(path);
        mergeThumbPages([path]);
        toast.error("Could not delete screenshot", { duration: 5000 });
        return;
      }
      pendingRemovalPathsRef.current.delete(path);
      dropThumb(path);
    };
    void remove();
    if (remaining.length === 0) {
      if (autoHideTimerRef.current) {
        clearTimeout(autoHideTimerRef.current);
        autoHideTimerRef.current = null;
      }
      // Keep the launcher available after the last item is deleted rather than
      // leaving the user with an invisible app surface.
      isCollapsedRef.current = true;
      setIsCollapsed(true);
      setMode("thumbnail");
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      try { await showCollapsedThumbnail(); } catch {}
    } else if (!isCollapsedRef.current) {
      await resizeThumbWindowKeepingBottom(remaining.length);
    }
  }, [mergeThumbPages, saveDir, updateThumbs]);

  const isReadOnlyScreenshot = useCallback(
    (path: string) => !isManagedScreenshotPath(path, saveDir),
    [saveDir],
  );

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
      // element. Switch React to the fixed-size pill before native IPC: a slow
      // macOS resize must never leave the full screenshot column rendered in a
      // narrow pill window.
      isCollapsedRef.current = true;
      setIsCollapsed(true);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      try {
        await showCollapsedThumbnail();
      } catch (error) {
        // The render state must still change if the native window happens to
        // reject a geometry update during an app/Space transition. Otherwise
        // the user sees a rail that its close button cannot dismiss; the next
        // pill interaction retries native placement.
        console.error("collapse thumbnail window failed:", error);
      }
    } else {
      // EXPAND. The column stayed MOUNTED through the collapse (display-hidden,
      // thumbs cached), so this swap is a pure CSS flip — no remount, no IPC, no
      // decode. Sequence: unhide column (still opacity:0) -> resize window to
      // final geometry -> one painted frame -> genie-in.
      isCollapsedRef.current = false;
      setIsCollapsed(false);
      // Double rAF so React doesn't just COMMIT the swap but the pill-removed /
      // opacity:0 column state is actually COMPOSITED to screen before we touch
      // native geometry — otherwise the old collapsed pill rides the window's
      // top edge upward during the resize (the "pill jumps up" flash).
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      await expandThumbWindow(columnViewRef.current, thumbsRef.current.length);
      // One more frame so the resized geometry is composited before the reveal
      // starts (the genie must not unfurl inside a still-pill-sized window).
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
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

  if (mode === "thumbnail") {
    return (
      <ScreenshotThumbnail
        paths={thumbs}
        isCollapsed={isCollapsed}
        openSignal={openSignal}
        autoCollapseSignal={autoCollapseSignal}
        columnView={columnView}
        onColumnViewChange={handleColumnViewChange}
        onAddImage={handleAddImage}
        onEdit={handleThumbnailItemEdit}
        onRemove={handleThumbnailItemRemove}
        isReadOnly={isReadOnlyScreenshot}
        onToggleCollapsed={handleToggleCollapsed}
        onHoverChange={handleHoverChange}
        onActivity={handleColumnActivity}
        onLoadMore={loadOlderPillPage}
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

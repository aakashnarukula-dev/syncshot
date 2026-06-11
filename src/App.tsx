import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { availableMonitors } from "@tauri-apps/api/window";
import { getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { Store } from "@tauri-apps/plugin-store";
import type { KeyboardShortcut } from "./components/preferences/KeyboardShortcutManager";
import { toast } from "sonner";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { editorActions } from "@/stores/editorStore";
import { startSyncEngine } from "@/lib/sync/engine";
import { loadLicenseStatus, type LicenseStatus } from "@/lib/license";
import { Paywall } from "@/components/Paywall";
// Startup-critical: static import so it ships in the entry chunk and never
// needs a runtime protocol fetch that can stall behind the launch IPC burst.
import { ScreenshotThumbnail } from "./components/ScreenshotThumbnail";

// Lazy load heavy components
const ImageEditor = lazy(() => import("./components/ImageEditor").then(m => ({ default: m.ImageEditor })));
const PreferencesPage = lazy(() => import("./components/preferences/PreferencesPage").then(m => ({ default: m.PreferencesPage })));
const LibraryView = lazy(() => import("./components/Library/LibraryView").then(m => ({ default: m.LibraryView })));

type AppMode = "main" | "preferences" | "thumbnail" | "library";

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

function computeThumbWindowHeight(count: number): number {
  if (count <= 0) return THUMB_MIN_HEIGHT;
  const raw = count * THUMB_ITEM_HEIGHT + Math.max(0, count - 1) * THUMB_GAP + THUMB_VERT_PAD;
  return Math.max(THUMB_MIN_HEIGHT, Math.min(raw, THUMB_MAX_HEIGHT));
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

// Cache the active monitor's logical geometry so expanding from the pill needs
// zero IPC (availableMonitors() round-trips to Rust). Refreshed on every query.
let cachedMon: { left: number; top: number; height: number } | null = null;
function cacheMonitor(m: { position: { x: number; y: number }; size: { height: number }; scaleFactor: number }) {
  const sf = m.scaleFactor || 1;
  cachedMon = { left: m.position.x / sf, top: m.position.y / sf, height: m.size.height / sf };
}

async function showThumbnailWindow(count: number, mouseX?: number, mouseY?: number) {
  const appWindow = getCurrentWindow();
  const height = computeThumbWindowHeight(count);

  // Kick off the monitor query immediately and run the geometry-independent
  // window flags concurrently, instead of awaiting ~6 IPC calls one-by-one.
  const monitorsPromise = availableMonitors();
  const flags = Promise.all([
    appWindow.setDecorations(false).catch(() => {}),
    appWindow.setResizable(false).catch(() => {}),
    appWindow.setAlwaysOnTop(true).catch(() => {}),
    appWindow.setContentProtected(false).catch(() => {}),
  ]);

  let placed = false;
  try {
    const monitors = await monitorsPromise;
    // availableMonitors() reports position/size in PHYSICAL px; setPosition uses
    // LOGICAL px and the AppleScript mouse coords are LOGICAL too. Convert every
    // monitor metric to logical via scaleFactor before comparing/placing,
    // otherwise the column lands ~scaleFactor× too low on Retina screens.
    const target =
      (mouseX !== undefined && mouseY !== undefined
        ? monitors.find((m) => {
            const sf = m.scaleFactor || 1;
            const px = m.position.x / sf;
            const py = m.position.y / sf;
            const sw = m.size.width / sf;
            const sh = m.size.height / sf;
            return mouseX >= px && mouseX < px + sw && mouseY >= py && mouseY < py + sh;
          })
        : null) || monitors[0];

    if (target) {
      cacheMonitor(target);
      const sf = target.scaleFactor || 1;
      const monLeft = target.position.x / sf;
      const monTop = target.position.y / sf;
      const monHeight = target.size.height / sf;
      const x = monLeft; // flush to the left screen edge (pill touches edge)
      const y = monTop + Math.max(THUMB_MARGIN, (monHeight - height) / 2);
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

async function showCollapsedThumbnail() {
  const appWindow = getCurrentWindow();
  try { await appWindow.setDecorations(false); } catch {}
  try { await appWindow.setResizable(false); } catch {}
  await appWindow.setSize(new LogicalSize(COLLAPSED_WIDTH, COLLAPSED_HEIGHT));
  try {
    const monitors = await availableMonitors();
    const m = monitors[0];
    if (m) {
      cacheMonitor(m);
      const sf = m.scaleFactor || 1; // physical → logical (see showThumbnailWindow)
      const x = m.position.x / sf;
      const y = m.position.y / sf + Math.max(THUMB_MARGIN, (m.size.height / sf - COLLAPSED_HEIGHT) / 2);
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
async function expandThumbWindow(count: number) {
  const appWindow = getCurrentWindow();
  const height = computeThumbWindowHeight(count);
  let mon = cachedMon;
  if (!mon) {
    try {
      const monitors = await availableMonitors();
      if (monitors[0]) cacheMonitor(monitors[0]);
      mon = cachedMon;
    } catch {}
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
    const monitors = await availableMonitors();
    const m = monitors[0];
    const newH = computeThumbWindowHeight(count);
    let placed = false;
    if (m) {
      const sf = m.scaleFactor || 1; // physical → logical (see showThumbnailWindow)
      const x = m.position.x / sf; // flush to the left screen edge (pill touches edge)
      const y = m.position.y / sf + Math.max(THUMB_MARGIN, (m.size.height / sf - newH) / 2);
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
      try { await getCurrentWindow().destroy(); } catch (e) { console.error("destroy failed:", e); }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error("Failed to save image", { description: msg, duration: 5000 });
    }
  };

  const onCancel = async () => {
    editorActions.reset();
    try { await emit("editor-closed"); } catch {}
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

  const handleActivated = useCallback(async (_key: string) => {
    const status = await loadLicenseStatus();
    setLicenseStatus(status);
    licenseStatusRef.current = status;
    setShowPaywall(false);
  }, []);

  // Boot the Firebase realtime sync engine once. It runs for the life of this
  // (always-alive, usually hidden) main webview — independent of which mode is
  // showing — so screenshot/clipboard sync keeps working in the background.
  useEffect(() => {
    startSyncEngine().catch((e) => console.error("sync engine start failed:", e));
  }, []);

  // Open the ScreenshotX/ClipboardX library as a normal decorated window
  // (reuses the main window, like Preferences).
  const openLibrary = useCallback(async () => {
    await showNormalWindow(getCurrentWindow(), 1100, 720, {
      title: "ScreenshotX",
      resizable: true,
      alwaysOnTop: false,
    });
    setMode("library");
  }, []);

  const closeLibrary = useCallback(async () => {
    setMode("main");
    const w = getCurrentWindow();
    await tweak(() => w.setDecorations(false));
    await tweak(() => w.setTitle(""));
    try { await w.hide(); } catch (e) { console.error("hide failed:", e); }
  }, []);

  const updateThumbs = useCallback((updater: (prev: string[]) => string[]) => {
    const next = updater(thumbsRef.current);
    thumbsRef.current = next;
    setThumbs(next);
    return next;
  }, []);

  // Show the column, then trigger its open animation (now that it's visible).
  const openThumbnailWindow = useCallback(async (count: number, mouseX?: number, mouseY?: number) => {
    await showThumbnailWindow(count, mouseX, mouseY);
    setOpenSignal((n) => n + 1);
  }, []);

  // Idle-based auto-hide: restarts a 5s countdown on every pointer signal. There
  // is NO sticky "hovering" flag — a flag wedges open forever if a mouseleave is
  // missed (e.g. the window moves out from under a stationary cursor on open).
  // Instead, any activity re-arms the timer, and 5s of no activity collapses it.
  const startAutoHide = useCallback(() => {
    if (autoHideTimerRef.current) clearTimeout(autoHideTimerRef.current);
    autoHideTimerRef.current = null;
    if (isCollapsedRef.current || thumbsRef.current.length === 0) return;
    autoHideTimerRef.current = setTimeout(() => {
      autoHideTimerRef.current = null;
      if (isCollapsedRef.current || thumbsRef.current.length === 0) return;
      // An open editor suspends auto-hide, but keep polling so a missed
      // "editor-closed" event can't wedge the column open forever.
      if (openEditorsRef.current > 0) {
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
      // defaultDir = ~/Desktop/ScreenshotX (created if missing); desktopRoot =
      // legacy plain Desktop, used to migrate old prefs; temp = canonicalized.
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
        const isLegacyDesktop = !!desktopRoot && (trimmed === desktopRoot || trimmed === `${desktopRoot}/`);
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

      // Pre-populate thumbnail column with existing screenshots
      if (effectiveSaveDir) {
        try {
          const existing = await invoke<string[]>("list_screenshots", { dir: effectiveSaveDir });
          if (existing.length > 0) {
            const next = updateThumbs(() => existing);
            setMode("thumbnail");
            isCollapsedRef.current = false;
            setIsCollapsed(false);
            await openThumbnailWindow(next.length);
            startAutoHide();
          }
        } catch (err) {
          console.error("Failed to list existing screenshots:", err);
        }
      }
    };

    initializeApp();

    // DEV ONLY: Uncomment to test editor with any image file
    // setMode("editing");
  }, []);

  // Watch save dir for files added/removed outside this app
  // (e.g. screenshots synced in from another Mac). Refreshes the
  // thumbnail column without needing to relaunch the app.
  useEffect(() => {
    if (!saveDir) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const disk = await invoke<string[]>("list_screenshots", { dir: saveDir });
        if (cancelled) return;

        const current = thumbsRef.current;
        const changed =
          disk.length !== current.length ||
          disk.some((p, i) => p !== current[i]);
        if (!changed) return;

        const newOnes = disk.filter((p) => !current.includes(p));
        const hasNew = newOnes.length > 0;
        const next = updateThumbs(() => disk);

        // A normal decorated window (Library/Preferences) is showing — keep the
        // thumb list current but don't switch mode or re-apply column geometry,
        // or the open window collapses to the thin edge strip.
        if (modeRef.current === "library" || modeRef.current === "preferences") {
          return;
        }

        if (next.length > 0) {
          setMode("thumbnail");
          // New file arrived (likely synced in) — surface the window.
          if (hasNew) {
            // Copy the newest synced-in screenshot to this Mac's clipboard,
            // mirroring local-capture behavior and the user's auto-copy setting.
            if (settingsRef.current.copyToClipboard) {
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

    const interval = setInterval(poll, 2500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [saveDir, updateThumbs, startAutoHide]);


  const handleCapture = useCallback(async (captureMode: CaptureMode = "region") => {
    if (isCapturing) return;

    if (licenseStatusRef.current?.state === "expired") {
      setShowPaywall(true);
      await showNormalWindow(getCurrentWindow(), 520, 640, {
        title: "Activate ScreenshotX",
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

      const next = updateThumbs((prev) => [finalPath, ...prev]);
      setMode("thumbnail");
      isCollapsedRef.current = false;
      setIsCollapsed(false);
      await openThumbnailWindow(next.length, mouseX, mouseY);
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
            "System Settings → Privacy & Security → Screen Recording → enable ScreenshotX, then restart.",
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
          title: "Activate ScreenshotX",
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
        if (thumbsRef.current.length > 0) {
          isCollapsedRef.current = false;
          setIsCollapsed(false);
          await openThumbnailWindow(thumbsRef.current.length);
        } else {
          await showCollapsedThumbnail();
          isCollapsedRef.current = true;
          setIsCollapsed(true);
        }
      });
      // Tray "Library…" (or another launch) opens the sync library window.
      const unlisten9 = await listen("open-library", () => { openLibrary(); });
      const prevCleanup = unlisten6;
      unlisten6 = () => { prevCleanup(); unlisten7(); unlisten8(); unlisten9(); };
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
    setMode("main");
    const w = getCurrentWindow();
    await tweak(() => w.setDecorations(false));
    await tweak(() => w.setTitle(""));
    try { await w.hide(); } catch (e) { console.error("hide failed:", e); }
  }, [loadSettings]);

  const handleThumbnailItemEdit = useCallback(async (path: string) => {
    if (licenseStatusRef.current?.state === "expired") {
      setShowPaywall(true);
      await showNormalWindow(getCurrentWindow(), 520, 640, {
        title: "Activate ScreenshotX",
      });
      setMode("main");
      return;
    }
    const label = `editor-${Date.now()}`;
    try {
      openEditorsRef.current += 1;
      pauseAutoHide();
      // Copy the screenshot to the clipboard on open (fire-and-forget so it
      // never delays the editor window).
      invoke("copy_to_clipboard", { path })
        .then(() => toast.success("Copied to clipboard", { duration: 1500 }))
        .catch((e) => console.error("copy on open failed:", e));
      await invoke("open_editor_window", {
        label,
        imagePath: path,
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
    invoke("delete_file", { path }).catch(() => {});
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
    isCollapsedRef.current = next;
    setIsCollapsed(next);
    if (autoHideTimerRef.current) {
      clearTimeout(autoHideTimerRef.current);
      autoHideTimerRef.current = null;
    }
    if (next) {
      await showCollapsedThumbnail();
    } else {
      // One frame so React commits the (transparent, opacity:0) expanded column —
      // the pill is unmounted before we resize, so the geometry change is invisible.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await expandThumbWindow(thumbsRef.current.length);
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
        onEdit={handleThumbnailItemEdit}
        onRemove={handleThumbnailItemRemove}
        onToggleCollapsed={handleToggleCollapsed}
        onHoverChange={handleHoverChange}
      />
    );
  }

  if (mode === "library") {
    return (
      <Suspense fallback={<LoadingFallback />}>
        <LibraryView onClose={closeLibrary} />
      </Suspense>
    );
  }

  if (mode === "preferences") {
    return (
      <Suspense fallback={<LoadingFallback />}>
        <PreferencesPage
          onBack={handleBackFromPreferences}
          onSettingsChange={handleSettingsChange}
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

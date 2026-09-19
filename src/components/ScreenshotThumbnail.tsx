import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { animate } from "motion";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { Check, ChevronLeft, ClipboardList, Copy, Download, Image as ImageIcon, ImageOff, ImagePlus, Link2, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useSyncStore } from "@/stores/syncStore";
import { ensureDragIconPath, getCachedThumbUrl, requestRemoteThumbUrl, requestThumbUrl } from "@/lib/thumbCache";
import { findDocForCachePath, isCloudScreenshotPath, isImportScreenshotPath } from "@/lib/sync/order";
import { computePreloadRange, computeWindowRange, windowItemTop, windowTotalHeight, type WindowRange } from "@/lib/railWindow";
import type { ColumnView } from "@/App";

// Lazy: the clipboard list transitively pulls Firebase (~715KB) via
// lib/sync/clipboard — keep it out of the startup-critical column chunk and
// only fetch it the first time the user switches to the Text view.
const loadClipboardColumnList = () =>
  import("./ClipboardX/ClipboardColumnList").then((m) => ({ default: m.ClipboardColumnList }));
const ClipboardColumnList = lazy(loadClipboardColumnList);

// Genie-style open/close for the column, driven by motion's imperative animate()
// on a STABLE element (no remount → thumbnails don't reload, no flash). The
// transform-origin is anchored at the left edge (the pill) so it reads as the
// column emanating from / curling back into the pill rather than the center.
// Open: eased scale + slight vertical stretch + horizontal unfurl + fade-in.
const COL_IN_KEYFRAMES = {
  opacity: [0, 1],
  x: ["-16%", "0%"],
  scaleX: [0.55, 1],
  scaleY: [0.82, 1],
};
const COL_OUT_KEYFRAMES = {
  opacity: [1, 0],
  x: ["0%", "-38%"],
  scaleX: [1, 0.3],
  scaleY: [1, 0.1],
};
const COL_IN_MS = 300;
const COL_OUT_MS = 280;

interface ScreenshotThumbnailProps {
  paths: string[];
  isCollapsed: boolean;
  /** Bumped after the window is shown so the open animation replays while visible. */
  openSignal?: number;
  /** Bumped when the parent idle timer requests the normal animated collapse. */
  autoCollapseSignal?: number;
  columnView: ColumnView;
  onColumnViewChange: (view: ColumnView) => void;
  onAddImage: (file: File) => void;
  onEdit: (path: string) => void;
  onRemove: (path: string) => void;
  onToggleCollapsed: () => void;
  /** Legacy/externally owned images can be viewed and copied, never mutated. */
  isReadOnly?: (path: string) => boolean;
  onHoverChange?: (hovered: boolean) => void;
  /** Resets idle timeout for non-hover activity such as keyboard scrolling. */
  onActivity?: () => void;
  /** Request the next newest-first source page once the rail reaches its end. */
  onLoadMore?: () => void;
}

// Memoized: the parent (MainApp) re-renders on auth/license/poll churn; the
// column's props are stable (paths array identity only changes on a real
// add/remove/reorder, handlers are useCallbacks), so none of that churn
// reconciles the column subtree anymore.
export const ScreenshotThumbnail = memo(function ScreenshotThumbnail({
  paths,
  isCollapsed,
  openSignal = 0,
  autoCollapseSignal = 0,
  columnView,
  onColumnViewChange,
  onAddImage,
  onEdit,
  onRemove,
  onToggleCollapsed,
  isReadOnly = () => false,
  onHoverChange,
  onActivity,
  onLoadMore,
}: ScreenshotThumbnailProps) {
  const [animatingOut, setAnimatingOut] = useState(false);
  // Fetch the (Firebase-heavy) clipboard chunk only after the first switch to
  // the Text view, then keep it mounted so toggling back and forth is instant.
  const [clipboardLoaded, setClipboardLoaded] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (columnView === "clipboard") setClipboardLoaded(true);
  }, [columnView]);

  // Warm the Text-view chunk during idle once the rail is up, so the FIRST
  // toggle doesn't parse 715KB of Firebase on the main thread mid-click. This
  // only fetches+parses the module (browser-cached after that); nothing mounts
  // until the user actually switches views.
  useEffect(() => {
    const warm = () => {
      loadClipboardColumnList().catch(() => {});
    };
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(warm, { timeout: 5000 });
      return () => w.cancelIdleCallback?.(id);
    }
    const t = setTimeout(warm, 2000);
    return () => clearTimeout(t);
  }, []);

  const colRef = useRef<HTMLDivElement>(null);
  const animRef = useRef<ReturnType<typeof animate> | null>(null);
  const collapsePendingRef = useRef(false);
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevOpenRef = useRef(openSignal);
  const prevAutoCollapseRef = useRef(autoCollapseSignal);

  useEffect(() => {
    setAnimatingOut(false);
    collapsePendingRef.current = false;
    if (collapseTimerRef.current) {
      clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
  }, [isCollapsed]);

  useEffect(() => () => {
    animRef.current?.stop();
    if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current);
  }, []);

  // Play the open animation only once the window is actually visible (the parent
  // bumps openSignal after showing it). Skips the initial mount, which happens
  // while the window is still hidden — that's what made open look instant/flashy.
  // The window geometry is already correct (parent resized it transparent,
  // pre-reveal) so only the GPU transform/opacity animates — no resize flicker.
  useLayoutEffect(() => {
    if (prevOpenRef.current === openSignal) return;
    prevOpenRef.current = openSignal;
    const el = colRef.current;
    if (!el) return;
    animRef.current?.stop();
    animRef.current = animate(el, COL_IN_KEYFRAMES, {
      duration: COL_IN_MS / 1000,
      ease: [0.16, 1, 0.3, 1], // ease-out genie unfurl
    });
  }, [openSignal]);

  const triggerCollapse = useCallback(() => {
    // Motion's `finished` promise rejects when WebKit interrupts an animation
    // (for example while the borderless window is being resized). Previously
    // that rejection was swallowed, leaving the rail permanently expanded.
    // Mark the request synchronously and always finish on a short fallback timer
    // so pill-control and Escape dismissals have a guaranteed close path.
    if (animatingOut || collapsePendingRef.current || isCollapsed) return;
    collapsePendingRef.current = true;
    setAnimatingOut(true);
    const complete = () => {
      if (!collapsePendingRef.current) return;
      collapsePendingRef.current = false;
      if (collapseTimerRef.current) {
        clearTimeout(collapseTimerRef.current);
        collapseTimerRef.current = null;
      }
      onToggleCollapsed();
    };
    collapseTimerRef.current = setTimeout(complete, COL_OUT_MS + 100);
    const el = colRef.current;
    if (!el) {
      return;
    }
    animRef.current?.stop();
    const anim = animate(el, COL_OUT_KEYFRAMES, {
      duration: COL_OUT_MS / 1000,
      ease: [0.5, 0, 0.75, 0], // ease-in genie curl-back
    });
    animRef.current = anim;
    void anim.finished.then(complete, complete);
  }, [animatingOut, isCollapsed, onToggleCollapsed]);

  useEffect(() => {
    if (prevAutoCollapseRef.current === autoCollapseSignal) return;
    prevAutoCollapseRef.current = autoCollapseSignal;
    triggerCollapse();
  }, [autoCollapseSignal, triggerCollapse]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isCollapsed && columnView === "screenshots" && paths.length > 0) {
        // Escape is a dismissal key, never a destructive shortcut. The old
        // handler permanently deleted the newest screenshot without a prompt.
        e.preventDefault();
        triggerCollapse();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paths.length, isCollapsed, columnView, triggerCollapse]);

  // The column stays MOUNTED while collapsed (display:none), so re-expanding is
  // pure CSS + the genie-in: no remount, no thumbnail IPC/decode replay.
  return (
    <>
      {isCollapsed ? (
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label="Show screenshots"
          className="bs-edge-pill h-[72px] w-[24px] overflow-hidden flex items-center justify-center border border-l-0 border-white/20 text-white cursor-pointer transition-[background,box-shadow] bs-pill-in"
        >
          <ImageIcon className="size-3.5" aria-hidden="true" />
        </button>
      ) : null}
      <div
        ref={colRef}
        className={`bs-glass-rail h-full w-full min-h-0 overflow-hidden select-none flex-row rounded-r-[20px] border border-l-0 border-white/[0.14] ${isCollapsed ? "hidden" : "flex"}`}
        style={{ transformOrigin: "left center", opacity: 0 }}
        onMouseEnter={() => onHoverChange?.(true)}
        onMouseMove={() => onHoverChange?.(true)}
        onMouseLeave={() => onHoverChange?.(false)}
        onWheel={onActivity}
      >
        {/* Same edge pill as the collapsed handle, vertically centered on the left,
            flipped arrow — click to close. */}
        <div className="shrink-0 flex items-center">
          <button
            type="button"
            onClick={triggerCollapse}
            aria-label="Hide screenshots"
            className="bs-edge-pill h-[72px] w-[24px] flex items-center justify-center border border-l-0 border-white/20 text-white cursor-pointer transition-[background,box-shadow]"
          >
            <ChevronLeft className="size-3.5" aria-hidden="true" />
          </button>
        </div>
        <div className="flex-1 min-w-0 flex flex-col">
          {/* Screenshots / Text segmented toggle, pinned above the active list. */}
          <div className="shrink-0 pt-3 pb-1.5 pr-3 pl-1">
            <input
              ref={imageInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="sr-only"
              aria-label="Choose image"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) onAddImage(file);
              }}
            />
            <div className="flex items-stretch gap-1.5">
              <div className="flex min-w-0 flex-1 gap-0.5 rounded-md bg-white/[0.07] p-0.5 ring-1 ring-inset ring-white/[0.08] backdrop-blur-sm">
                <button
                  type="button"
                  onClick={() => onColumnViewChange("screenshots")}
                  aria-pressed={columnView === "screenshots"}
                  className={`flex-1 flex items-center justify-center gap-1.5 rounded px-2 py-1 text-xs cursor-pointer transition-colors ${
                    columnView === "screenshots"
                      ? "bg-white/[0.16] text-white shadow-sm"
                      : "text-white/50 hover:bg-white/[0.06] hover:text-white/85"
                  }`}
                >
                  <ImageIcon className="size-3.5" aria-hidden="true" />
                  Screenshots
                </button>
                <button
                  type="button"
                  onClick={() => onColumnViewChange("clipboard")}
                  aria-pressed={columnView === "clipboard"}
                  className={`flex-1 flex items-center justify-center gap-1.5 rounded px-2 py-1 text-xs cursor-pointer transition-colors ${
                    columnView === "clipboard"
                      ? "bg-white/[0.16] text-white shadow-sm"
                      : "text-white/50 hover:bg-white/[0.06] hover:text-white/85"
                  }`}
                >
                  <ClipboardList className="size-3.5" aria-hidden="true" />
                  Text
                </button>
              </div>
              <button
                type="button"
                onClick={() => {
                  onColumnViewChange("screenshots");
                  imageInputRef.current?.click();
                }}
                aria-label="Add image"
                title="Add image"
                className="flex w-8 shrink-0 items-center justify-center rounded-md border border-white/[0.12] bg-white/[0.07] text-white/75 shadow-sm transition-colors hover:bg-white/[0.14] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 cursor-pointer"
              >
                <ImagePlus className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>

          {/* Both views stay mounted once loaded (hidden, not unmounted) so
              toggling never re-decodes thumbnails or refetches clipboard. */}
          <VirtualThumbList
            paths={paths}
            revealed={!isCollapsed && columnView === "screenshots"}
            revealSignal={openSignal}
            onEdit={onEdit}
            onRemove={onRemove}
            isReadOnly={isReadOnly}
            onActivity={onActivity}
            onLoadMore={onLoadMore}
          />

          {clipboardLoaded ? (
            <div
              onScroll={onActivity}
              className={`flex-1 min-w-0 min-h-0 flex-col ${columnView === "clipboard" ? "flex" : "hidden"}`}
            >
              <Suspense fallback={null}>
                <ClipboardColumnList />
              </Suspense>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
});

// ---------------------------------------------------------------------------
// Virtualized screenshot list. Tiles are fixed-height 4:3 slots, so the
// visible index range is pure arithmetic off scrollTop — only ~viewport +
// overscan tiles exist in the DOM (~16-30) instead of the whole library
// (~371 tiles / ~4k nodes / 742 IntersectionObservers, whose synchronous
// full-column mount+layout is what froze every pill click and ballooned the
// layer tree WindowServer choked on).
// ---------------------------------------------------------------------------

const LIST_GAP = 20; // matches the old gap-5 flex column (and App's THUMB_GAP)
const OVERSCAN = 2; // enough to avoid scroll pop-in without decoding a whole cache
// pl-1 + pr-3 horizontal padding inside the scroll container.
const LIST_PAD_X = 16;
// Fallback before first measure: 240px rail − 24px launcher − padding, 4:3.
const DEFAULT_ITEM_HEIGHT = Math.round(((240 - 24 - LIST_PAD_X) * 3) / 4);

interface VirtualThumbListProps {
  paths: string[];
  /** False while the column is collapsed or the Text view is active — the list
   * is display-hidden (zero layout) but keeps its mounted tiles + state. */
  revealed: boolean;
  /** The parent's openSignal: bumped after the native window reached its final
   * geometry, so a cold reveal (mounted while the window was still pill-sized,
   * clientWidth 0) gets a guaranteed post-resize layout pass. */
  revealSignal?: number;
  onEdit: (path: string) => void;
  onRemove: (path: string) => void;
  isReadOnly: (path: string) => boolean;
  onActivity?: () => void;
  onLoadMore?: () => void;
}

function VirtualThumbList({ paths, revealed, revealSignal = 0, onEdit, onRemove, isReadOnly, onActivity, onLoadMore }: VirtualThumbListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const preloadSignatureRef = useRef("");
  const [layout, setLayout] = useState<{
    itemHeight: number;
    visibleStart: number;
    visibleEnd: number;
  } & WindowRange>({
    itemHeight: DEFAULT_ITEM_HEIGHT,
    start: 0,
    end: 0,
    visibleStart: 0,
    visibleEnd: 0,
  });

  // Re-derive item height + visible range from the live scroll box. Skipped
  // entirely while display-hidden (clientWidth 0) so a hidden-but-mounted
  // column never recomputes to an empty range and drops its tiles.
  const sync = useCallback(() => {
    const el = scrollRef.current;
    if (!el || el.clientWidth === 0) return;
    const innerWidth = Math.max(0, el.clientWidth - LIST_PAD_X);
    const itemHeight = Math.max(1, Math.round((innerWidth * 3) / 4));
    const range = computeWindowRange(
      el.scrollTop,
      el.clientHeight,
      paths.length,
      itemHeight,
      LIST_GAP,
      OVERSCAN,
    );
    const visible = computeWindowRange(
      el.scrollTop,
      el.clientHeight,
      paths.length,
      itemHeight,
      LIST_GAP,
      0,
    );
    setLayout((prev) =>
      prev.itemHeight === itemHeight &&
      prev.start === range.start &&
      prev.end === range.end &&
      prev.visibleStart === visible.start &&
      prev.visibleEnd === visible.end
        ? prev
        : {
            itemHeight,
            ...range,
            visibleStart: visible.start,
            visibleEnd: visible.end,
          },
    );
  }, [paths.length]);

  // Sync before paint on mount, on list changes, when the list is revealed
  // again (re-expand / toggle back from Text — scroll geometry only exists
  // once it's visible), and after the native window reaches final geometry
  // (revealSignal).
  useLayoutEffect(() => {
    if (revealed) sync();
  }, [sync, revealed, revealSignal]);

  useEffect(() => {
    const onResize = () => sync();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      // Reset so handleScroll can schedule again after this cleanup runs on a
      // paths change (a stale non-zero id would block all future syncs).
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [sync]);

  // Cloud bytes follow the virtual window, not the Firestore page. The actual
  // visible paths are primed first; mounted overscan paths become a small next-
  // scroll buffer. Dynamic import keeps Firebase off the first-paint chunk.
  useEffect(() => {
    if (!revealed || layout.visibleEnd <= layout.visibleStart) return;
    const visiblePaths = paths.slice(layout.visibleStart, layout.visibleEnd);
    const preloadRange = computePreloadRange(
      layout.visibleStart,
      layout.visibleEnd,
      paths.length,
    );
    const bufferedPaths = paths.slice(preloadRange.start, preloadRange.end);
    const signature = `${visiblePaths.join("\n")}\0${bufferedPaths.join("\n")}`;
    if (preloadSignatureRef.current === signature) return;
    preloadSignatureRef.current = signature;
    void import("@/lib/sync/screenshots").then(({ preloadScreenshotPaths }) => {
      preloadScreenshotPaths(visiblePaths, bufferedPaths);
    }).catch(() => {});
  }, [layout.visibleEnd, layout.visibleStart, paths, revealed]);

  const handleScroll = () => {
    onActivity?.();
    const el = scrollRef.current;
    if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - layout.itemHeight * 2) {
      onLoadMore?.();
    }
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      sync();
    });
  };

  const { itemHeight, start, end } = layout;
  if (paths.length === 0) {
    return (
      <div className={`flex-1 min-w-0 items-center justify-center px-5 text-center ${revealed ? "flex" : "hidden"}`}>
        <div className="flex flex-col items-center gap-2 text-white/50">
          <ImageOff className="size-5" aria-hidden="true" />
          <p className="text-xs font-medium text-white/80">No screenshots yet</p>
          <p className="text-[11px] leading-4">Recent screenshots will appear here.</p>
        </div>
      </div>
    );
  }
  return (
    <div
      ref={scrollRef}
      data-thumb-scroll
      onScroll={handleScroll}
      className={`flex-1 min-w-0 overflow-y-auto pt-1 pb-4 pr-3 pl-1 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none] ${
        revealed ? "block" : "hidden"
      }`}
      style={{ background: "transparent" }}
    >
      <div
        className="relative w-full"
        style={{ height: windowTotalHeight(paths.length, itemHeight, LIST_GAP) }}
      >
        {paths.slice(start, end).map((path, offset) => {
          const index = start + offset;
          return (
            <div
              key={path}
              className="absolute inset-x-0"
              style={{ top: windowItemTop(index, itemHeight, LIST_GAP), height: itemHeight }}
            >
              <ThumbnailItem path={path} onEdit={onEdit} onRemove={onRemove} readOnly={isReadOnly(path)} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface ThumbnailItemProps {
  path: string;
  onEdit: (path: string) => void;
  onRemove: (path: string) => void;
  readOnly: boolean;
}

// A synced shot whose Storage blob never downloaded — or an orphaned/corrupted
// doc with no valid blob at all — must NOT park the tile in a perpetual shimmer.
// Bound both the Firebase URL resolve and the remote image load so the remote
// fallback ALWAYS reaches a terminal state (rendered or "unavailable"). Local
// thumbnail requests are NOT time-bounded — see thumbCache.
const REMOTE_TIMEOUT_MS = 8000;

// Test-load `url` in an off-DOM <img> and resolve true only if it actually
// decoded (false on error or after `timeoutMs`). Used for the two FALLBACK
// sources only — asset:// local file and remote Firebase URL — which can fail
// in ways the on-DOM <img> onError must not ping-pong over. Blob URLs minted
// from our own Rust thumbnail bytes skip this: they decode or they don't, and
// <img decoding="async"> already keeps that off the critical path (probing
// them doubled every decode).
//
// `cors` MUST match the displayed <img>'s crossOrigin mode for the SAME src, or
// WKWebView serves the probe's cached response in the wrong mode and paints a
// broken "?". The modes map to the source kinds:
//   • LOCAL  asset:// files → cors=true  (Tauri's asset protocol returns CORS
//     headers). Fallback only — blocked in release.
//   • REMOTE Firebase URLs  → cors=false (the Storage bucket has NO CORS config
//     — by design; synced bytes are fetched in Rust — so a crossOrigin probe
//     is rejected and the image never loads; a plain no-cors <img> loads the
//     token URL fine, just like the public share link).
function probeImage(url: string, timeoutMs?: number, cors = true): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    if (cors) img.crossOrigin = "anonymous";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(ok);
    };
    if (timeoutMs) timer = setTimeout(() => finish(false), timeoutMs);
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    img.src = url;
  });
}

// Resolve `p`, or null if it rejects or doesn't settle within `ms` — so a
// hung getDownloadURL() can't stall the fallback short of its terminal state.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

// Memoized: scroll-window shifts re-render the list container, and without
// memo every mounted tile would re-render on each shift. Props are stable
// (path string + App-level useCallback handlers).
export const ThumbnailItem = memo(function ThumbnailItem({ path, onEdit, onRemove, readOnly }: ThumbnailItemProps) {
  const isUploading = isImportScreenshotPath(path);
  // Cache-first: a tile whose thumbnail blob URL is already in the module
  // cache commits it in its INITIAL state — remounting (scroll-back, or a
  // future column remount) paints with zero IPC, zero effects-first flash.
  const [src, setSrc] = useState<string>(() =>
    getCachedThumbUrl(path) ?? findDocForCachePath(path)?.thumbUrl ?? "",
  );
  // URL availability is not pixel availability. Keep the shimmer visible until
  // WebKit actually decodes and paints the image (onLoad), including direct
  // Firebase URLs restored from Firestore.
  const [ready, setReady] = useState(false);
  // Terminal "unavailable" state: every source (thumb, local, remote) was tried
  // and none rendered. Shows a static placeholder (still deletable) instead of
  // looping back to the shimmer.
  const [failed, setFailed] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exitingRef = useRef(false);

  // Resolve a Firebase Storage token URL for this tile when its local cache
  // file is missing or won't decode — a synced (remote) shot whose Rust
  // download hasn't landed yet, an OWN-DEVICE capture whose local file was
  // evicted, or an orphaned doc. Firebase is dynamically imported so it never
  // enters the startup-critical column chunk; the import only fires once a
  // local load DEFINITELY failed (never on a slow local decode — that
  // timeout-then-network pattern fired a wave of per-tile Firebase RPCs on
  // every cold open). `findDocForCachePath` resolves the backing doc for BOTH
  // kinds of cache file — a received shot's `{docId}.png` filename AND an own
  // capture's `shot_{ts}.png` (via the publish-time path→docId map).
  const resolveFallbackUrl = async (): Promise<string | null> => {
    try {
      const { findDocForCachePath, storageDownloadUrl } = await import("@/lib/sync/screenshots");
      const match = findDocForCachePath(path);
      if (match?.thumbUrl) return match.thumbUrl;
      const storagePath = match?.thumbPath || match?.fullPath;
      if (!storagePath) return null;
      return await storageDownloadUrl(storagePath, match.sha256);
    } catch {
      return null;
    }
  };

  // Source cascade, cache-aware:
  //   1. Module-cached blob URL (handled in the state initializer above).
  //   2. Rust thumbnail bytes via the gated request queue → blob URL,
  //      committed directly (no off-DOM probe — the bytes are our own PNG).
  //   3. On DEFINITE local error only: asset:// full-res (dev origin), then
  //      the time-bounded remote Firebase URL, then terminal "unavailable".
  // Virtualization already guarantees this only runs for tiles in/near the
  // viewport, and unmount cancels a still-queued request (scrolled away).
  useEffect(() => {
    // Usually committed by the state initializer already; the setState here
    // covers a thumb that landed in the cache (via another tile's shared
    // request) between this tile's first render and this effect.
    const cached = getCachedThumbUrl(path);
    if (cached) {
      setSrc(cached);
      setFailed(false);
      return;
    }

    let cancelled = false;
    // Cloud identities fetch the tiny Firebase WebP through Rust, then render a
    // same-origin in-memory blob. This request is shared with the viewport
    // preloader, so a visible tile never starts a duplicate remote load.
    if (isCloudScreenshotPath(path)) {
      let cancelled = false;
      let request: ReturnType<typeof requestRemoteThumbUrl> | null = null;
      void (async () => {
        const remote = await resolveFallbackUrl();
        if (cancelled) return;
        if (!remote) {
          setFailed(true);
          return;
        }
        request = requestRemoteThumbUrl(path, remote);
        try {
          const url = await request.promise;
          if (cancelled) return;
          if (url) {
            setSrc(url);
            setReady(false);
            setFailed(false);
          }
        } catch {
          if (cancelled) return;
          // Native HTTP may fail transiently while WebKit can still render the
          // token URL. Keep this final no-CORS fallback instead of stranding a
          // valid cloud screenshot in an unavailable state.
          setSrc(remote);
          setReady(false);
          setFailed(false);
        }
      })();
      return () => {
        cancelled = true;
        request?.release();
      };
    }

    const request = requestThumbUrl(path);

    const commit = (url: string) => {
      if (cancelled) return;
      setSrc(url);
      setReady(false);
      setFailed(false);
    };

    (async () => {
      try {
        const url = await request.promise;
        if (cancelled) return;
        if (url) commit(url);
        // null → cancelled while queued (tile unmounted); nothing to do.
        return;
      } catch {
        // Definite local failure — fall through to the fallback cascade.
      }
      if (cancelled) return;

      // Original full-res local file (dev-origin only; release can't CORS-load it).
      const local = convertFileSrc(path);
      if (await probeImage(local)) {
        commit(local);
        return;
      }
      if (cancelled) return;

      // Remote Firebase token URL — the reliable source for a SYNCED shot whose
      // local cache file is missing/corrupt. Probed/loaded in NO-CORS mode (the
      // Storage bucket has no CORS config). Both resolve + load time-bounded.
      const remote = await withTimeout(resolveFallbackUrl(), REMOTE_TIMEOUT_MS);
      if (cancelled) return;
      if (remote && (await probeImage(remote, REMOTE_TIMEOUT_MS, false))) {
        commit(remote);
        return;
      }
      if (cancelled) return;

      // Exhausted every source — terminal state so the user can SEE + DELETE
      // an orphaned/corrupted doc.
      setSrc("");
      setReady(false);
      setFailed(true);
    })();

    return () => {
      cancelled = true;
      request.release();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Drag icon comes from the already-cached thumbnail BYTES (one temp-file
  // write, memoized per path) — not the old canvas draw + toDataURL + serial
  // temp-dir/save IPC round-trips against the full-res <img> on every drag.
  const beginDrag = () => {
    (async () => {
      let dragPath = path;
      let deleteAfterDrag = false;
      if (isCloudScreenshotPath(path)) {
        const { ensureLocalScreenshot } = await import("@/lib/sync/screenshots");
        dragPath = await ensureLocalScreenshot(path);
        deleteAfterDrag = dragPath !== path;
      }
      let icon = dragPath; // full-res file itself as the fallback icon
      try {
        const iconPath = await ensureDragIconPath(dragPath);
        if (iconPath) icon = iconPath;
      } catch {
        // fall through with the full-res path
      }
      try {
        await startDrag({ item: [dragPath], icon });
      } catch (err) {
        console.error("startDrag failed:", err);
      } finally {
        if (deleteAfterDrag) {
          setTimeout(() => {
            void import("@/lib/sync/screenshots").then(({ releaseTemporaryScreenshot }) =>
              releaseTemporaryScreenshot(path, dragPath),
            );
          }, 60_000);
        }
      }
    })();
  };

  // Copy a PUBLIC shareable link for this image. Firebase/upload code is pulled
  // in lazily here (keeps it off the launch critical path) and only on tap, so
  // the column never uploads eagerly. Reuses the sync engine's auth/device and
  // the publisher's dedup+upload path — no Firebase re-init or duplicate upload.
  const copyShareLink = async () => {
    if (isSharing) return;
    const uid = useSyncStore.getState().uid;
    if (!uid) {
      toast.error("Pair a device first to share links", { duration: 4000 });
      return;
    }
    setIsSharing(true);
    try {
      const [{ shareScreenshotLink }, { getDevice }] = await Promise.all([
        import("@/lib/sync/screenshots"),
        import("@/lib/sync/engine"),
      ]);
      const device = getDevice();
      if (!device) {
        toast.error("Pair a device first to share links", { duration: 4000 });
        return;
      }
      const url = await shareScreenshotLink(uid, device, path);
      const { setLocalClipboard } = await import("@/lib/sync/clipboard");
      await setLocalClipboard(url);
      toast.success("Link copied", { description: url, duration: 2500 });
    } catch (err) {
      console.error("share link failed:", err);
      toast.error("Couldn't create share link", {
        description: err instanceof Error ? err.message : "Upload failed — check your connection",
        duration: 5000,
      });
    } finally {
      setIsSharing(false);
    }
  };

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  // Copies the ORIGINAL full-res image (not the downscaled column thumbnail).
  // The checkmark is immediate, but success is reported only after native
  // NSPasteboard confirms the write; this avoids a false "Copied" toast.
  const copyImage = () => {
    setIsCopied(true);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    import("@/lib/sync/screenshots")
      .then(({ copyScreenshotToClipboard }) => copyScreenshotToClipboard(path))
      .then(() => {
        toast.success("Copied to clipboard", { duration: 1500 });
      })
      .catch((err) => {
        console.error("copy image failed:", err);
        setIsCopied(false);
        toast.error("Couldn't copy image", {
          description: err instanceof Error ? err.message : String(err),
          duration: 4000,
        });
      })
      .finally(() => {
        copiedTimerRef.current = setTimeout(() => setIsCopied(false), 1500);
      });
  };

  const downloadImage = () => {
    if (isDownloading) return;
    setIsDownloading(true);
    import("@/lib/sync/screenshots")
      .then(({ downloadScreenshotToDownloads }) => downloadScreenshotToDownloads(path))
      .then((savedPath) => {
        const filename = savedPath.split(/[\\/]/).pop() || "image";
        toast.success("Saved to Downloads", { description: filename, duration: 2200 });
      })
      .catch((err) => {
        console.error("download image failed:", err);
        toast.error("Couldn't download image", {
          description: err instanceof Error ? err.message : String(err),
          duration: 4000,
        });
      })
      .finally(() => setIsDownloading(false));
  };

  const slideOutAndRemove = () => {
    if (exitingRef.current) return;
    exitingRef.current = true;
    setIsExiting(true);
    setTimeout(() => onRemove(path), 220);
  };

  return (
    <div
      className={`group relative h-full w-full overflow-visible transition-all duration-200 ease-in ${
        isExiting ? "-translate-x-full opacity-0" : "translate-x-0 opacity-100"
      }`}
    >
      {/* Skeleton keeps the slot's fixed size and animates while the thumbnail
          decodes, so fast scrolling shows a shimmer instead of blank gaps.
          Hidden once the image is ready OR the tile reached its terminal
          "unavailable" state — it never loops back to the shimmer. */}
      <div
        aria-hidden="true"
        className={`absolute inset-0 rounded-md bs-thumb-shimmer transition-opacity duration-200 ${
          ready || failed ? "opacity-0 bs-thumb-shimmer-done" : "opacity-100"
        }`}
      />
      {failed ? (
        // Terminal "unavailable" tile: no valid blob anywhere (orphaned/corrupted
        // doc, or a synced shot whose bytes never downloaded). Static, not
        // clickable-to-edit — but the delete + share buttons below stay usable so
        // the user can SEE it and remove it instead of staring at an endless
        // shimmer.
        <div
          className="relative flex h-full w-full flex-col items-center justify-center gap-1.5 rounded-md border border-neutral-700/40 bg-neutral-900/80 text-neutral-500 select-none"
        >
          <ImageOff className="size-6" aria-hidden="true" />
          <span className="text-[11px] font-medium">Unavailable</span>
        </div>
      ) : src ? (
        <img
          src={src}
          alt="Screenshot preview"
          // CORS mode must match how this src was (probe-)loaded. Three source
          // kinds, two modes:
          //   • blob:/data:  (own-capture thumbnail bytes) → NO crossOrigin. A
          //     blob URL is same-origin; this is the origin-independent path
          //     that renders in the release localhost webview.
          //   • https://     (remote Firebase token URL) → NO crossOrigin. The
          //     Storage bucket has no CORS config, so a cors request is rejected
          //     and a synced shot would fall to "?"; a plain no-cors <img> loads
          //     the token URL fine, like the public share link.
          //   • asset://     (local full-res fallback) → crossOrigin="anonymous".
          //     Tauri's asset protocol supplies CORS headers.
          crossOrigin={/^(blob:|data:|https?:\/\/)/i.test(src) ? undefined : "anonymous"}
          decoding="async"
          className={`relative block h-full w-full object-cover select-none rounded-md cursor-pointer transition-opacity duration-200 ${
            ready ? "opacity-100" : "opacity-0"
          }`}
          draggable={!isUploading}
          onLoad={() => {
            setReady(true);
            setFailed(false);
          }}
          onDragStart={(e) => {
            e.preventDefault();
            if (!isUploading) beginDrag();
          }}
          onError={() => {
            // Every on-DOM src either came from our own thumbnail bytes or was
            // probed-good off-DOM, so a failure here — e.g. cache eviction
            // between commit and paint — is terminal: looping back through the
            // cascade would risk a local↔remote ping-pong.
            setReady(false);
            setFailed(true);
          }}
          onClick={() => {
            if (isUploading) {
              toast.info("Image is still uploading", { duration: 1800 });
            } else {
              onEdit(path);
            }
          }}
        />
      ) : null}

      {isUploading ? (
        <div className="pointer-events-none absolute right-1.5 bottom-1.5 flex size-6 items-center justify-center rounded-full bg-neutral-900/80 text-white shadow-md z-10">
          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
          <span className="sr-only">Uploading image</span>
        </div>
      ) : null}

      {/* Tile actions are hover/focus-gated and use a SOLID scrim, not
          backdrop-blur: four always-composited blur layers per tile on a
          transparent NSWindow is pure WindowServer tax. */}
      {!readOnly && !isUploading ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            slideOutAndRemove();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label="Delete"
          title="Delete"
          className="absolute top-1.5 left-1.5 size-6 rounded-full bg-neutral-900/80 hover:bg-red-600/90 text-white flex items-center justify-center shadow-md z-10 cursor-pointer opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
        >
          <Trash2 className="size-3" aria-hidden="true" />
        </button>
      ) : null}

      {!isUploading ? <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          copyImage();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        aria-label="Copy image"
        title="Copy image"
        className="absolute top-1.5 right-1.5 size-6 rounded-full bg-neutral-900/80 hover:bg-blue-600/90 text-white flex items-center justify-center shadow-md z-10 cursor-pointer opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
      >
        {isCopied ? (
          <Check className="size-3" aria-hidden="true" />
        ) : (
          <Copy className="size-3" aria-hidden="true" />
        )}
      </button> : null}

      {!readOnly && !isUploading ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            copyShareLink();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          disabled={isSharing}
          aria-label="Copy share link"
          title="Copy share link"
          className="absolute bottom-1.5 left-1.5 size-6 rounded-full bg-neutral-900/80 hover:bg-blue-600/90 text-white flex items-center justify-center shadow-md z-10 cursor-pointer disabled:cursor-wait opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
        >
          {isSharing ? (
            <Loader2 className="size-3 animate-spin" aria-hidden="true" />
          ) : (
            <Link2 className="size-3" aria-hidden="true" />
          )}
        </button>
      ) : null}

      {!isUploading ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            downloadImage();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          disabled={isDownloading}
          aria-label="Download image"
          title="Download image"
          className="absolute bottom-1.5 right-1.5 size-6 rounded-full bg-neutral-900/80 hover:bg-emerald-600/90 text-white flex items-center justify-center shadow-md z-10 cursor-pointer disabled:cursor-wait opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
        >
          {isDownloading ? (
            <Loader2 className="size-3 animate-spin" aria-hidden="true" />
          ) : (
            <Download className="size-3" aria-hidden="true" />
          )}
        </button>
      ) : null}
    </div>
  );
});

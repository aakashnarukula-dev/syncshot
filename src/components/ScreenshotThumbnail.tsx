import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { animate } from "motion";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { Check, ChevronLeft, ChevronRight, ClipboardList, Copy, Image as ImageIcon, ImageOff, Link2, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useSyncStore } from "@/stores/syncStore";
import { ensureDragIconPath, getCachedThumbUrl, requestThumbUrl } from "@/lib/thumbCache";
import { computeWindowRange, windowItemTop, windowTotalHeight, type WindowRange } from "@/lib/railWindow";
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
  /** Bumped by the parent (auto-hide) to request an animated collapse. */
  collapseSignal?: number;
  /** Bumped after the window is shown so the open animation replays while visible. */
  openSignal?: number;
  columnView: ColumnView;
  onColumnViewChange: (view: ColumnView) => void;
  onEdit: (path: string) => void;
  onRemove: (path: string) => void;
  onToggleCollapsed: () => void;
  onHoverChange?: (hovered: boolean) => void;
}

// Memoized: the parent (MainApp) re-renders on auth/license/poll churn; the
// column's props are stable (paths array identity only changes on a real
// add/remove/reorder, handlers are useCallbacks), so none of that churn
// reconciles the column subtree anymore.
export const ScreenshotThumbnail = memo(function ScreenshotThumbnail({
  paths,
  isCollapsed,
  collapseSignal = 0,
  openSignal = 0,
  columnView,
  onColumnViewChange,
  onEdit,
  onRemove,
  onToggleCollapsed,
  onHoverChange,
}: ScreenshotThumbnailProps) {
  const [animatingOut, setAnimatingOut] = useState(false);
  // Fetch the (Firebase-heavy) clipboard chunk only after the first switch to
  // the Text view, then keep it mounted so toggling back and forth is instant.
  const [clipboardLoaded, setClipboardLoaded] = useState(false);
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
  const prevOpenRef = useRef(openSignal);

  useEffect(() => {
    setAnimatingOut(false);
  }, [isCollapsed]);

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

  const triggerCollapse = () => {
    if (animatingOut) return;
    setAnimatingOut(true);
    const el = colRef.current;
    if (!el) {
      setTimeout(() => onToggleCollapsed(), COL_OUT_MS + 10);
      return;
    }
    animRef.current?.stop();
    const anim = animate(el, COL_OUT_KEYFRAMES, {
      duration: COL_OUT_MS / 1000,
      ease: [0.5, 0, 0.75, 0], // ease-in genie curl-back
    });
    animRef.current = anim;
    anim.finished.then(() => onToggleCollapsed()).catch(() => {});
  };

  // Auto-hide: parent bumps collapseSignal → play the same slide-out as the button.
  useEffect(() => {
    if (collapseSignal > 0 && !isCollapsed) {
      triggerCollapse();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapseSignal]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isCollapsed && columnView === "screenshots" && paths.length > 0) {
        onRemove(paths[0]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paths, onRemove, isCollapsed, columnView]);

  // The column stays MOUNTED while collapsed (display:none), so re-expanding is
  // pure CSS + the genie-in: no remount, no thumbnail IPC/decode replay. That
  // remount cycle — auto-hide collapses after 5s idle, every re-expand rebuilt
  // ~371 tiles and re-decoded everything — was the core "still laggy" loop.
  return (
    <>
      {isCollapsed ? (
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label="Show screenshots"
          className="h-dvh w-dvw flex items-center justify-center bg-neutral-900/90 text-white cursor-pointer rounded-r-md bs-pill-in"
        >
          <ChevronRight className="size-4" aria-hidden="true" />
        </button>
      ) : null}
      <div
        ref={colRef}
        className={`h-dvh w-dvw overflow-hidden select-none flex-row ${isCollapsed ? "hidden" : "flex"}`}
        style={{ background: "transparent", transformOrigin: "left center", opacity: 0 }}
        onMouseEnter={() => onHoverChange?.(true)}
        onMouseMove={() => onHoverChange?.(true)}
        onMouseLeave={() => onHoverChange?.(false)}
        onWheel={() => onHoverChange?.(true)}
      >
        {/* Same edge pill as the collapsed handle, vertically centered on the left,
            flipped arrow — click to close. */}
        <div className="shrink-0 flex items-center">
          <button
            type="button"
            onClick={triggerCollapse}
            aria-label="Hide screenshots"
            className="h-[90px] w-[18px] flex items-center justify-center bg-neutral-900/90 hover:bg-neutral-800 text-white cursor-pointer rounded-r-md"
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
          </button>
        </div>
        <div className="flex-1 min-w-0 flex flex-col">
          {/* Screenshots / Text segmented toggle, pinned above the active list. */}
          <div className="shrink-0 pt-3 pb-1.5 pr-3 pl-1">
            <div className="flex gap-0.5 rounded-md bg-neutral-900/90 p-0.5">
              <button
                type="button"
                onClick={() => onColumnViewChange("screenshots")}
                aria-pressed={columnView === "screenshots"}
                className={`flex-1 flex items-center justify-center gap-1.5 rounded px-2 py-1 text-xs cursor-pointer transition-colors ${
                  columnView === "screenshots"
                    ? "bg-neutral-700 text-white"
                    : "text-neutral-400 hover:text-white"
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
                    ? "bg-neutral-700 text-white"
                    : "text-neutral-400 hover:text-white"
                }`}
              >
                <ClipboardList className="size-3.5" aria-hidden="true" />
                Text
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
            onHoverChange={onHoverChange}
          />

          {clipboardLoaded ? (
            <div
              onScroll={() => onHoverChange?.(true)}
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
const OVERSCAN = 12; // items each side → ~30-item render window
// pl-1 + pr-3 horizontal padding inside the scroll container.
const LIST_PAD_X = 16;
// Fallback before first measure: 240 window − 18 pill − padding, 4:3.
const DEFAULT_ITEM_HEIGHT = Math.round(((240 - 18 - LIST_PAD_X) * 3) / 4);

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
  onHoverChange?: (hovered: boolean) => void;
}

function VirtualThumbList({ paths, revealed, revealSignal = 0, onEdit, onRemove, onHoverChange }: VirtualThumbListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const [layout, setLayout] = useState<{ itemHeight: number } & WindowRange>({
    itemHeight: DEFAULT_ITEM_HEIGHT,
    start: 0,
    end: 0,
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
    setLayout((prev) =>
      prev.itemHeight === itemHeight && prev.start === range.start && prev.end === range.end
        ? prev
        : { itemHeight, ...range },
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

  const handleScroll = () => {
    onHoverChange?.(true);
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      sync();
    });
  };

  const { itemHeight, start, end } = layout;
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
              <ThumbnailItem path={path} onEdit={onEdit} onRemove={onRemove} />
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
const ThumbnailItem = memo(function ThumbnailItem({ path, onEdit, onRemove }: ThumbnailItemProps) {
  // Cache-first: a tile whose thumbnail blob URL is already in the module
  // cache commits it in its INITIAL state — remounting (scroll-back, or a
  // future column remount) paints with zero IPC, zero effects-first flash.
  const [src, setSrc] = useState<string>(() => getCachedThumbUrl(path) ?? "");
  const [ready, setReady] = useState(() => src !== "");
  // Terminal "unavailable" state: every source (thumb, local, remote) was tried
  // and none rendered. Shows a static placeholder (still deletable) instead of
  // looping back to the shimmer.
  const [failed, setFailed] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
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
      const storagePath = match?.thumbPath || match?.fullPath;
      if (!storagePath) return null;
      return await storageDownloadUrl(storagePath);
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
      setReady(true);
      setFailed(false);
      return;
    }

    let cancelled = false;
    const request = requestThumbUrl(path);

    const commit = (url: string) => {
      if (cancelled) return;
      setSrc(url);
      setReady(true);
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
      let icon = path; // full-res file itself as the fallback icon
      try {
        const iconPath = await ensureDragIconPath(path);
        if (iconPath) icon = iconPath;
      } catch {
        // fall through with the full-res path
      }
      try {
        await startDrag({ item: [path], icon });
      } catch (err) {
        console.error("startDrag failed:", err);
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

  // Copies the ORIGINAL full-res image file (not the downscaled column
  // thumbnail). OPTIMISTIC: toast + checkmark immediately, revert on error —
  // the Rust copy re-encodes a multi-MB PNG and the UI must not sit silent
  // behind it.
  const copyImage = () => {
    setIsCopied(true);
    toast.success("Copied to clipboard", { duration: 1500 });
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setIsCopied(false), 1500);
    invoke("copy_to_clipboard", { path }).catch((err) => {
      console.error("copy image failed:", err);
      setIsCopied(false);
      toast.error("Couldn't copy image", {
        description: err instanceof Error ? err.message : String(err),
        duration: 4000,
      });
    });
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
          draggable
          onDragStart={(e) => {
            e.preventDefault();
            beginDrag();
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
            exitingRef.current = true;
            onEdit(path);
          }}
        />
      ) : null}

      {/* Tile actions are hover/focus-gated and use a SOLID scrim, not
          backdrop-blur: three always-composited blur layers per tile on a
          transparent NSWindow is pure WindowServer tax. */}
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

      <button
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
      </button>

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
        className="absolute bottom-1.5 right-1.5 size-6 rounded-full bg-neutral-900/80 hover:bg-blue-600/90 text-white flex items-center justify-center shadow-md z-10 cursor-pointer disabled:cursor-wait opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
      >
        {isSharing ? (
          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
        ) : (
          <Link2 className="size-3" aria-hidden="true" />
        )}
      </button>
    </div>
  );
});

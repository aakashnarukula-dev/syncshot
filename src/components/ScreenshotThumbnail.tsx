import { lazy, memo, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { animate } from "motion";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { Check, ChevronLeft, ChevronRight, ClipboardList, Copy, Image as ImageIcon, ImageOff, Link2, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useSyncStore } from "@/stores/syncStore";
import type { ColumnView } from "@/App";

// Lazy: the clipboard list transitively pulls Firebase (~715KB) via
// lib/sync/clipboard — keep it out of the startup-critical column chunk and
// only fetch it the first time the user switches to the Text view.
const ClipboardColumnList = lazy(() =>
  import("./ClipboardX/ClipboardColumnList").then((m) => ({ default: m.ClipboardColumnList })),
);

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

export function ScreenshotThumbnail({
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

  if (isCollapsed) {
    return (
      <button
        type="button"
        onClick={onToggleCollapsed}
        aria-label="Show screenshots"
        className="h-dvh w-dvw flex items-center justify-center bg-neutral-900/90 text-white cursor-pointer rounded-r-md bs-pill-in"
      >
        <ChevronRight className="size-4" aria-hidden="true" />
      </button>
    );
  }

  return (
    <div
      ref={colRef}
      className="h-dvh w-dvw overflow-hidden select-none flex flex-row"
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
        <div
          data-thumb-scroll
          onScroll={() => onHoverChange?.(true)}
          className={`flex-1 min-w-0 overflow-y-auto pt-1 pb-4 pr-3 pl-1 flex-col gap-5 items-stretch [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none] ${
            columnView === "screenshots" ? "flex" : "hidden"
          }`}
          style={{
            background: "transparent",
            maskImage:
              "linear-gradient(to bottom, transparent 0, black 4px, black calc(100% - 6px), transparent 100%)",
            WebkitMaskImage:
              "linear-gradient(to bottom, transparent 0, black 4px, black calc(100% - 6px), transparent 100%)",
          }}
        >
          {paths.map((path, i) => (
            <ThumbnailItem
              key={path}
              path={path}
              eager={i < EAGER_COUNT}
              onEdit={onEdit}
              onRemove={onRemove}
            />
          ))}
        </div>

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
  );
}

// Render the first few items (which include the newest, top-of-column shot)
// eagerly so they're instantly visible/draggable; everything below is mounted
// lazily as it scrolls near view (IntersectionObserver) so expanding the pill
// no longer decodes all ~371 images at once.
const EAGER_COUNT = 6;

interface ThumbnailItemProps {
  path: string;
  eager?: boolean;
  onEdit: (path: string) => void;
  onRemove: (path: string) => void;
}

// Longest side of the cached column thumbnail. ~2x the 240px column width so
// it stays crisp on Retina while decoding ~50-100x faster than a full shot.
const THUMB_MAX_PX = 512;

// A synced shot whose Storage blob never downloaded — or an orphaned/corrupted
// doc with no valid blob at all — must NOT park the tile in a perpetual shimmer.
// Bound both the Firebase URL resolve and the remote image load so the source
// cascade ALWAYS reaches a terminal state (rendered or "unavailable").
const REMOTE_TIMEOUT_MS = 8000;

// Test-load `url` in an off-DOM <img> and resolve true only if it actually
// decoded (false on error or after `timeoutMs`). The cascade commits a source
// ONLY after it probes good, so the on-DOM <img> then loads it straight from
// cache — and we never ping-pong between broken srcs via the <img> onError.
//
// `cors` MUST match the displayed <img>'s crossOrigin mode for the SAME src, or
// WKWebView serves the probe's cached response in the wrong mode and paints a
// broken "?". The modes map to the source kinds:
//   • OWN CAPTURE blob: thumbnail bytes → cors=false (a blob URL is same-origin;
//     this is the origin-independent PRIMARY load that renders in the release
//     `http://localhost` webview, which can't CORS-load asset://).
//   • LOCAL  asset:// files → cors=true  (Tauri's asset protocol returns CORS
//     headers; the cors-cached bitmap is also what lets the drag-icon canvas
//     export read it back without tainting). Fallback only — blocked in release.
//   • REMOTE Firebase URLs  → cors=false (the Storage bucket has NO CORS config
//     — by design; synced bytes are fetched in Rust — so a crossOrigin probe
//     is rejected and the image never loads, which is exactly what stranded a
//     synced shot on "?"; a plain no-cors <img> loads the token URL fine, just
//     like the public share link).
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
// hung getDownloadURL() can't stall the cascade short of its terminal state.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

// Memoized: MainApp re-renders on every Firestore snapshot (and every poll
// diff), and without memo each snapshot re-rendered every mounted tile. Props
// are stable (path string + App-level useCallback handlers), so churny sync
// activity no longer touches the tiles at all.
const ThumbnailItem = memo(function ThumbnailItem({
  path,
  eager = false,
  onEdit,
  onRemove,
}: ThumbnailItemProps) {
  // No optimistic full-res src: mounting the original (a 5–15MB retina PNG)
  // for the top tiles decoded tens of MB of bitmap per tile on EVERY open
  // (and in release the asset:// load just errors). The cascade below commits
  // the cheap cached thumbnail instead — eager only means "load immediately,
  // skip the viewport windowing".
  const [src, setSrc] = useState<string>("");
  const [ready, setReady] = useState(false);
  // Terminal "unavailable" state: every source (thumb, local, remote) was tried
  // and none rendered. Shows a static placeholder (still deletable) instead of
  // looping back to the shimmer.
  const [failed, setFailed] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [inView, setInView] = useState(eager);
  const rootRef = useRef<HTMLDivElement>(null);
  const exitingRef = useRef(false);

  // Resolve a Firebase Storage token URL for this tile when its local cache
  // file is missing or won't decode — a synced (remote) shot whose Rust
  // download hasn't landed yet, an OWN-DEVICE capture whose local file was
  // evicted, or an orphaned doc. Firebase is dynamically imported so it never
  // enters the startup-critical column chunk (same reason the clipboard list is
  // lazy); the import only fires once a local load fails. `findDocForCachePath`
  // resolves the backing doc for BOTH kinds of cache file — a received shot's
  // `{docId}.png` filename AND an own capture's `shot_{ts}.png` (via the
  // publish-time path→docId map) — so own captures get the same cloud fallback
  // synced shots already had instead of stranding on "Unavailable".
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

  // Windowed mounting: only items near the viewport hold a decoded bitmap, and
  // items scrolled far past it RELEASE theirs (src cleared) — otherwise a long
  // scroll through hundreds of full-res screenshots retains every decode and
  // OOMs the WKWebView (transparent column, app hang). Two observers give the
  // load/unload hysteresis (load at 1200px, unload past 2400px) so items near
  // the edge don't thrash. The load margin doubles as the PRELOAD BUFFER: now
  // that column items decode small cached thumbnails (not full-res shots), a
  // generous ~1200px look-ahead is cheap and keeps fast scrolling gap-free.
  // Eager (newest, top) items stay loaded always.
  useEffect(() => {
    if (eager) return;
    const el = rootRef.current;
    if (!el) return;
    const root = el.closest("[data-thumb-scroll]");
    const loadIO = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setInView(true);
      },
      { root, rootMargin: "1200px 0px" },
    );
    const unloadIO = new IntersectionObserver(
      (entries) => {
        // The Screenshots list is `display:none` while the Text view is active,
        // which reports EVERY tile as non-intersecting. Releasing the decodes
        // there forced a full IPC + re-decode of the whole visible column on
        // each toggle back — the "switching views is extremely slow" bug. A
        // hidden element has no client rects; only unload on real scroll-away.
        if (el.getClientRects().length === 0) return;
        if (entries.every((e) => !e.isIntersecting)) setInView(false);
      },
      { root, rootMargin: "2400px 0px" },
    );
    loadIO.observe(el);
    unloadIO.observe(el);
    return () => {
      loadIO.disconnect();
      unloadIO.disconnect();
    };
  }, [eager]);

  // Column preview loads a small CACHED THUMBNAIL (native-side downscale) —
  // decoding a ~512px PNG is dramatically cheaper than a multi-MB screenshot,
  // which is what made fast scrolling lag. The thumbnail BYTES come back over
  // IPC and are wrapped in a same-origin `blob:` URL (NOT `asset://`): in the
  // RELEASE build the webview origin is `http://localhost:38217`, which cannot
  // CORS-load `asset://`, so a path-based <img> never paints and a just-taken
  // own capture stranded on "Unavailable". A `blob:` URL renders regardless of
  // origin (dev AND release) — the same Rust-bytes trick synced shots already
  // use. The blob is pre-decoded off-DOM (probeImage) before swapping in, so the
  // crossfade over the shimmer never shows a half-painted frame. All ACTIONS
  // (edit, drag payload, share upload, delete) still use the original full-res
  // `path`. No cache-bust needed: the native thumbnail cache is content-keyed
  // (path+mtime+size), so the bytes change when the file does.
  useEffect(() => {
    if (!inView) {
      setSrc("");
      setReady(false);
      setFailed(false);
      return;
    }
    let cancelled = false;
    // The one `blob:` URL this run may mint (from the thumbnail bytes). Revoked
    // on cleanup (deps change / unmount) so a long scroll doesn't leak object
    // URLs. Revoking after the bitmap has painted is safe — the decoded image
    // stays; only a fresh load of the (now-dead) URL would fail, which never
    // happens for an already-committed src.
    let createdUrl: string | null = null;

    const commit = (url: string) => {
      if (cancelled) return;
      setSrc(url);
      setReady(true);
      setFailed(false);
    };

    // Deterministic source cascade. Each step PROBES its candidate (off-DOM
    // load) and only commits one that actually decodes, so an own-device shot
    // shows instantly from its local file and a synced shot falls back to its
    // bounded Firebase URL — but a doc with no valid blob anywhere ends in the
    // terminal "unavailable" state instead of an endless shimmer or an
    // onError ping-pong between two broken srcs.
    (async () => {
      const local = convertFileSrc(path);

      // 1. Cheap cached thumbnail (native downscale), returned as raw BYTES and
      //    wrapped in a same-origin `blob:` URL — NEVER `asset://`, so it loads
      //    under the release webview's `http://localhost` origin (which can't
      //    CORS-load `asset://`). This is the PRIMARY, origin-independent load
      //    for OWN local captures. TIME-BOUNDED: a hung Rust call (or a missing
      //    local file → reject) returns null instead of stranding the tile on
      //    the shimmer forever — we fall through to the local file, then the
      //    remote URL, and ultimately the terminal state. A `blob:` URL is
      //    same-origin, so it's probed/loaded in NO-CORS mode (no crossOrigin).
      const thumbBytes = await withTimeout(
        invoke<ArrayBuffer>("get_screenshot_thumbnail", { path, maxPx: THUMB_MAX_PX }),
        REMOTE_TIMEOUT_MS,
      );
      if (cancelled) return;
      if (thumbBytes && thumbBytes.byteLength > 0) {
        const thumbUrl = URL.createObjectURL(new Blob([thumbBytes], { type: "image/png" }));
        createdUrl = thumbUrl;
        if (await probeImage(thumbUrl, undefined, false)) {
          commit(thumbUrl);
          return;
        }
      }
      if (cancelled) return;

      // 2. Original full-res local file — fallback when the thumbnail bytes
      //    couldn't be produced (dev-origin only; release can't CORS-load it).
      if (await probeImage(local)) {
        commit(local);
        return;
      }
      if (cancelled) return;

      // 3. Remote Firebase token URL — the reliable source for a SYNCED shot
      //    whose local cache file won't decode in the webview (or never landed).
      //    Probed/loaded in NO-CORS mode: the Storage bucket has no CORS config,
      //    so a cors probe would fail exactly like the local fast-path it's meant
      //    to rescue and leave the tile stuck on "?". Both resolve + load are
      //    time-bounded.
      const remote = await withTimeout(resolveFallbackUrl(), REMOTE_TIMEOUT_MS);
      if (cancelled) return;
      if (remote && (await probeImage(remote, REMOTE_TIMEOUT_MS, false))) {
        commit(remote);
        return;
      }
      if (cancelled) return;

      // 4. Exhausted every source (no local file AND remote failed/timed out) —
      //    terminal state so the user can SEE + DELETE an orphaned/corrupted doc.
      setSrc("");
      setReady(false);
      setFailed(true);
    })();

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [path, inView]);

  // Drag preview is generated ON DRAG START from the already-decoded <img>
  // (no extra full-res decode, no per-item temp file on mount). The temp icon
  // is deleted once the drag session ends.
  const beginDrag = (imgEl: HTMLImageElement) => {
    (async () => {
      let iconPath: string | null = null;
      try {
        const target = 160;
        const ratio = Math.min(target / imgEl.naturalWidth, target / imgEl.naturalHeight, 1);
        const w = Math.max(1, Math.round(imgEl.naturalWidth * ratio));
        const h = Math.max(1, Math.round(imgEl.naturalHeight * ratio));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(imgEl, 0, 0, w, h);
          const dataUrl = canvas.toDataURL("image/png");
          const tempDir = await invoke<string>("get_temp_directory");
          const safe = path.replace(/[^a-zA-Z0-9._-]/g, "_");
          iconPath = await invoke<string>("save_edited_image", {
            imageData: dataUrl,
            saveDir: tempDir,
            copyToClip: false,
            overwritePath: `${tempDir}/sx-drag-${safe}`,
          });
        }
      } catch (err) {
        console.error("drag icon generation failed:", err);
        iconPath = null;
      }
      try {
        await startDrag({ item: [path], icon: iconPath || path });
      } catch (err) {
        console.error("startDrag failed:", err);
      } finally {
        if (iconPath) {
          invoke("delete_file", { path: iconPath }).catch(() => {});
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

  // Copies the ORIGINAL full-res image file (not the downscaled column
  // thumbnail) via the same Rust command used on editor open.
  const copyImage = async () => {
    try {
      await invoke("copy_to_clipboard", { path });
      toast.success("Copied to clipboard", { duration: 1500 });
      setIsCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setIsCopied(false), 1500);
    } catch (err) {
      console.error("copy image failed:", err);
      toast.error("Couldn't copy image", {
        description: err instanceof Error ? err.message : String(err),
        duration: 4000,
      });
    }
  };

  const slideOutAndRemove = () => {
    if (exitingRef.current) return;
    exitingRef.current = true;
    setIsExiting(true);
    setTimeout(() => onRemove(path), 220);
  };

  return (
    <div
      ref={rootRef}
      className={`relative w-full shrink-0 overflow-visible transition-all duration-200 ease-in ${
        isExiting ? "-translate-x-full opacity-0" : "translate-x-0 opacity-100"
      }`}
      style={{ aspectRatio: "4 / 3" }}
    >
      {/* Skeleton keeps the slot's fixed size and animates while the thumbnail
          decodes, so fast scrolling shows a shimmer instead of blank gaps.
          Hidden once the image is ready OR the tile reached its terminal
          "unavailable" state — it never loops back to the shimmer. */}
      {/* Sweep animates only for tiles actually loading in/near view — an
          offscreen tail of hundreds of unloaded tiles must not composite an
          infinite animation each. */}
      <div
        aria-hidden="true"
        className={`absolute inset-0 rounded-md bs-thumb-shimmer transition-opacity duration-200 ${
          ready || failed
            ? "opacity-0 bs-thumb-shimmer-done"
            : inView
              ? "opacity-100"
              : "opacity-100 bs-thumb-shimmer-done"
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
          // CORS mode must match the probe that committed this src (see
          // probeImage). Three source kinds, two modes:
          //   • blob:/data:  (own-capture thumbnail bytes) → NO crossOrigin. A
          //     blob URL is same-origin, so a crossOrigin="anonymous" would add a
          //     pointless CORS check; this is the origin-independent path that
          //     renders in the release localhost webview.
          //   • https://     (remote Firebase token URL) → NO crossOrigin. The
          //     Storage bucket has no CORS config, so a cors request is rejected
          //     and a synced shot would fall to "?"; a plain no-cors <img> loads
          //     the token URL fine, like the public share link.
          //   • asset://     (local full-res fallback) → crossOrigin="anonymous".
          //     Tauri's asset protocol supplies CORS headers, and the cors-cached
          //     bitmap lets the drag-icon canvas read it back untainted.
          crossOrigin={/^(blob:|data:|https?:\/\/)/i.test(src) ? undefined : "anonymous"}
          decoding="async"
          className={`relative block h-full w-full object-cover select-none rounded-md cursor-pointer transition-opacity duration-200 ${
            ready ? "opacity-100" : "opacity-0"
          }`}
          draggable
          onDragStart={(e) => {
            e.preventDefault();
            beginDrag(e.currentTarget);
          }}
          onError={() => {
            // Every on-DOM src was cascade-committed (probed-good off-DOM), so a
            // failure here — e.g. cache eviction between probe and paint — is
            // terminal: looping back through the cascade would risk a
            // local↔remote ping-pong.
            setReady(false);
            setFailed(true);
          }}
          onClick={() => {
            exitingRef.current = true;
            onEdit(path);
          }}
        />
      ) : null}

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          slideOutAndRemove();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        aria-label="Delete"
        title="Delete"
        className="absolute top-1.5 left-1.5 size-6 rounded-full bg-black/55 hover:bg-red-600/90 text-white flex items-center justify-center backdrop-blur-sm shadow-md z-10 cursor-pointer"
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
        className="absolute top-1.5 right-1.5 size-6 rounded-full bg-black/55 hover:bg-blue-600/90 text-white flex items-center justify-center backdrop-blur-sm shadow-md z-10 cursor-pointer"
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
        className="absolute bottom-1.5 right-1.5 size-6 rounded-full bg-black/55 hover:bg-blue-600/90 text-white flex items-center justify-center backdrop-blur-sm shadow-md z-10 cursor-pointer disabled:cursor-wait"
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

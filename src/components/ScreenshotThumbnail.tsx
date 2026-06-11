import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { animate } from "motion";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { ChevronLeft, ChevronRight, Link2, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useSyncStore } from "@/stores/syncStore";

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
  onEdit,
  onRemove,
  onToggleCollapsed,
  onHoverChange,
}: ScreenshotThumbnailProps) {
  const [animatingOut, setAnimatingOut] = useState(false);
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
      if (e.key === "Escape" && !isCollapsed && paths.length > 0) {
        onRemove(paths[0]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paths, onRemove, isCollapsed]);

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
      <div
        data-thumb-scroll
        className="flex-1 min-w-0 overflow-y-auto pt-3 pb-4 pr-3 pl-1 flex flex-col gap-5 items-stretch [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]"
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
            onEdit={() => onEdit(path)}
            onRemove={() => onRemove(path)}
          />
        ))}
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
  onEdit: () => void;
  onRemove: () => void;
}

function ThumbnailItem({ path, eager = false, onEdit, onRemove }: ThumbnailItemProps) {
  const [src, setSrc] = useState<string>("");
  const [dragIconPath, setDragIconPath] = useState<string | null>(null);
  const [isExiting, setIsExiting] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [inView, setInView] = useState(eager);
  const rootRef = useRef<HTMLDivElement>(null);
  const exitingRef = useRef(false);

  // Mount the heavy work (image decode + drag-icon canvas) only once the item is
  // near the viewport. Once shown it stays mounted so drag/edit/remove are intact.
  useEffect(() => {
    if (inView) return;
    const el = rootRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          io.disconnect();
        }
      },
      {
        root: el.closest("[data-thumb-scroll]"),
        rootMargin: "500px 0px",
      },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [inView]);

  // No `?t=Date.now()` cache-bust: that forced every image to re-decode on every
  // render/expand. Each screenshot has a unique path and edits produce a new path,
  // so a plain asset URL caches across collapse/expand cycles and still refreshes
  // when the file actually changes.
  useEffect(() => {
    if (!inView) return;
    setSrc(convertFileSrc(path));
  }, [path, inView]);

  useEffect(() => {
    if (!inView) return;
    let cancelled = false;
    let savedIconPath: string | null = null;
    (async () => {
      try {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.src = convertFileSrc(path);
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error("icon load failed"));
        });
        if (cancelled) return;
        const target = 160;
        const ratio = Math.min(target / img.width, target / img.height, 1);
        const w = Math.max(1, Math.round(img.width * ratio));
        const h = Math.max(1, Math.round(img.height * ratio));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL("image/png");
        const tempDir = await invoke<string>("get_temp_directory");
        // Unique, stable icon path derived from the source path. Concurrent
        // thumbnails previously saved to the same timestamped filename and
        // overwrote each other, so every drag showed the same preview. A
        // per-source path is collision-free and reused (no temp churn).
        const safe = path.replace(/[^a-zA-Z0-9._-]/g, "_");
        const iconPath = `${tempDir}/sx-drag-${safe}`;
        const saved = await invoke<string>("save_edited_image", {
          imageData: dataUrl,
          saveDir: tempDir,
          copyToClip: false,
          overwritePath: iconPath,
        });
        savedIconPath = saved;
        if (!cancelled) setDragIconPath(saved);
      } catch (err) {
        console.error("drag icon generation failed:", err);
      }
    })();
    return () => {
      cancelled = true;
      if (savedIconPath) {
        invoke("delete_file", { path: savedIconPath }).catch(() => {});
      }
    };
  }, [path, inView]);

  // Copy a PUBLIC shareable link for this image. Firebase/upload code is pulled
  // in lazily here (keeps it off the launch critical path) and only on tap, so
  // the column never uploads eagerly. Reuses the sync engine's auth/device and
  // the publisher's dedup+upload path — no Firebase re-init or duplicate upload.
  const copyShareLink = async () => {
    if (isSharing) return;
    const libId = useSyncStore.getState().libId;
    if (!libId) {
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
      const url = await shareScreenshotLink(libId, device, path);
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

  const slideOutAndRemove = () => {
    if (exitingRef.current) return;
    exitingRef.current = true;
    setIsExiting(true);
    setTimeout(() => onRemove(), 220);
  };

  return (
    <div
      ref={rootRef}
      className={`relative w-full shrink-0 overflow-visible transition-all duration-200 ease-in ${
        isExiting ? "-translate-x-full opacity-0" : "translate-x-0 opacity-100"
      }`}
      style={{ aspectRatio: "4 / 3" }}
    >
      {src ? (
        <img
          src={src}
          alt="Screenshot preview"
          loading="lazy"
          decoding="async"
          className="block h-full w-full object-cover select-none rounded-md cursor-pointer"
          draggable
          onDragStart={(e) => {
            e.preventDefault();
            startDrag({ item: [path], icon: dragIconPath || path }).catch((err) => {
              console.error("startDrag failed:", err);
            });
          }}
          onClick={() => {
            exitingRef.current = true;
            onEdit();
          }}
        />
      ) : null}

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
        className="absolute top-1.5 left-1.5 size-6 rounded-full bg-black/55 hover:bg-blue-600/90 text-white flex items-center justify-center backdrop-blur-sm shadow-md z-10 cursor-pointer disabled:cursor-wait"
      >
        {isSharing ? (
          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
        ) : (
          <Link2 className="size-3" aria-hidden="true" />
        )}
      </button>

      <button
        type="button"
        onClick={slideOutAndRemove}
        aria-label="Delete"
        className="absolute top-1.5 right-1.5 size-6 rounded-full bg-black/55 hover:bg-red-600/90 text-white flex items-center justify-center backdrop-blur-sm shadow-md z-10 cursor-pointer"
      >
        <Trash2 className="size-3" aria-hidden="true" />
      </button>
    </div>
  );
}

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { ChevronLeft, ChevronRight, Trash2 } from "lucide-react";

// Genie-style open/close for the column, played via the Web Animations API on a
// stable element (no remount → thumbnails don't reload, no flash).
// Open: fast opacity + small horizontal slide only. No vertical scale — the
// scaleY "unfold" was what made opening read as slow.
const COL_IN_KEYFRAMES: Keyframe[] = [
  { opacity: 0, transform: "translateX(-12%)" },
  { opacity: 1, transform: "translateX(0)" },
];
const COL_OUT_KEYFRAMES: Keyframe[] = [
  { opacity: 1, transform: "translateX(0) scaleX(1) scaleY(1)" },
  { opacity: 0, transform: "translateX(-38%) scaleX(0.3) scaleY(0.1)" },
];
const COL_IN_MS = 130;
const COL_OUT_MS = 260;

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
  const animRef = useRef<Animation | null>(null);
  const prevOpenRef = useRef(openSignal);

  useEffect(() => {
    setAnimatingOut(false);
  }, [isCollapsed]);

  // Play the open animation only once the window is actually visible (the parent
  // bumps openSignal after showing it). Skips the initial mount, which happens
  // while the window is still hidden — that's what made open look instant/flashy.
  useLayoutEffect(() => {
    if (prevOpenRef.current === openSignal) return;
    prevOpenRef.current = openSignal;
    const el = colRef.current;
    if (!el) return;
    animRef.current?.cancel();
    animRef.current = el.animate(COL_IN_KEYFRAMES, {
      duration: COL_IN_MS,
      easing: "ease-out",
      fill: "both",
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
    animRef.current?.cancel();
    const anim = el.animate(COL_OUT_KEYFRAMES, {
      duration: COL_OUT_MS,
      easing: "cubic-bezier(0.5, 0, 0.75, 0)",
      fill: "both",
    });
    animRef.current = anim;
    anim.addEventListener("finish", () => onToggleCollapsed(), { once: true });
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
        className="flex-1 min-w-0 overflow-y-auto pt-3 pb-4 pr-3 pl-1 flex flex-col gap-5 items-stretch [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]"
        style={{
          background: "transparent",
          maskImage:
            "linear-gradient(to bottom, transparent 0, black 4px, black calc(100% - 6px), transparent 100%)",
          WebkitMaskImage:
            "linear-gradient(to bottom, transparent 0, black 4px, black calc(100% - 6px), transparent 100%)",
        }}
      >
        {paths.map((path) => (
          <ThumbnailItem
            key={path}
            path={path}
            onEdit={() => onEdit(path)}
            onRemove={() => onRemove(path)}
          />
        ))}
      </div>
    </div>
  );
}

interface ThumbnailItemProps {
  path: string;
  onEdit: () => void;
  onRemove: () => void;
}

function ThumbnailItem({ path, onEdit, onRemove }: ThumbnailItemProps) {
  const [src, setSrc] = useState<string>("");
  const [dragIconPath, setDragIconPath] = useState<string | null>(null);
  const [isExiting, setIsExiting] = useState(false);
  const exitingRef = useRef(false);

  useEffect(() => {
    setSrc(`${convertFileSrc(path)}?t=${Date.now()}`);
  }, [path]);

  useEffect(() => {
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
  }, [path]);

  const slideOutAndRemove = () => {
    if (exitingRef.current) return;
    exitingRef.current = true;
    setIsExiting(true);
    setTimeout(() => onRemove(), 220);
  };

  return (
    <div
      className={`relative w-full shrink-0 overflow-visible transition-all duration-200 ease-in ${
        isExiting ? "-translate-x-full opacity-0" : "translate-x-0 opacity-100"
      }`}
      style={{ aspectRatio: "4 / 3" }}
    >
      {src ? (
        <img
          src={src}
          alt="Screenshot preview"
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
        onClick={slideOutAndRemove}
        aria-label="Delete"
        className="absolute top-1.5 right-1.5 size-6 rounded-full bg-black/55 hover:bg-red-600/90 text-white flex items-center justify-center backdrop-blur-sm shadow-md z-10 cursor-pointer"
      >
        <Trash2 className="size-3" aria-hidden="true" />
      </button>
    </div>
  );
}

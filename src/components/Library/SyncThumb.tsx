import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, ImageOff, Loader2, Trash2 } from "lucide-react";
import {
  deleteScreenshotDoc,
  saveReceivedScreenshot,
  storageDownloadUrl,
} from "@/lib/sync/screenshots";
import type { ScreenshotDoc } from "@/lib/sync/types";
import { useUid } from "@/stores/syncStore";
import { cn } from "@/lib/utils";

interface SyncThumbProps {
  item: ScreenshotDoc;
}

/** A single synced screenshot tile: WebP thumb (loaded as a CSP-safe blob URL),
 *  click to download the full image + copy it to this Mac's clipboard. */
export function SyncThumb({ item }: SyncThumbProps) {
  const uid = useUid();
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [inView, setInView] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Render windowing: resolve this tile's Storage token URL (a network
  // getDownloadURL) and decode its thumbnail only once it scrolls near the
  // viewport. Paired with the grid's lazy paging, this stops a large library
  // from firing 100+ getDownloadURL requests up front — off-screen tiles stay
  // idle on the shimmer. Once loaded a tile stays loaded (the window is paged,
  // so the count is bounded — no need to unload + refetch on scroll-back).
  useEffect(() => {
    const el = rootRef.current;
    if (!el || inView) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setInView(true);
      },
      { rootMargin: "400px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [inView]);

  // Render via the Storage getDownloadURL token URL as a plain <img src>. The
  // token is a capability (bypasses Storage rules + CORS), so an <img> load
  // succeeds with no bucket-CORS config — unlike getBytes()/getBlob(), whose
  // XHR the bucket blocks, which left this tile stuck on "Preview unavailable".
  // Gated on inView so an off-screen tile shows the shimmer (no fetch) until it
  // nears the viewport.
  useEffect(() => {
    if (!inView) return;
    let cancelled = false;
    setFailed(false);
    setSrc(null);
    if (!item.thumbPath) {
      setFailed(true);
      return;
    }
    storageDownloadUrl(item.thumbPath)
      .then((u) => {
        if (!cancelled) setSrc(u);
      })
      .catch((err) => {
        console.error("thumb url failed:", err);
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [item.thumbPath, inView]);

  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (savedTimer.current) clearTimeout(savedTimer.current);
  }, []);

  const onClick = async () => {
    if (saving || !item.fullPath) return;
    setSaving(true);
    try {
      await saveReceivedScreenshot(item);
      setSaved(true);
      toast.success("Saved & copied to clipboard", { duration: 1800 });
      savedTimer.current = setTimeout(() => setSaved(false), 1600);
    } catch (err) {
      toast.error("Failed to save image", {
        description: err instanceof Error ? err.message : String(err),
        duration: 4000,
      });
    } finally {
      setSaving(false);
    }
  };

  const uploading = item.status !== "full";

  // Delete EVERYWHERE: removes the Firestore doc + Storage blobs (and any local
  // cache copy) so the shot leaves every device and the subscription can't
  // resync it. Also the only way to clear orphaned/corrupted docs whose preview
  // is unavailable. The subscription drops the doc on the next snapshot, which
  // unmounts this tile — no local list surgery needed.
  const onDelete = async () => {
    if (deleting || !uid) return;
    setDeleting(true);
    try {
      await deleteScreenshotDoc(uid, item);
      toast.success("Screenshot deleted", { duration: 1500 });
    } catch (err) {
      setDeleting(false);
      toast.error("Failed to delete screenshot", {
        description: err instanceof Error ? err.message : String(err),
        duration: 4000,
      });
    }
  };

  return (
    <div
      ref={rootRef}
      className={cn(
        "group relative block aspect-[4/3] w-full overflow-hidden rounded-lg border border-border bg-muted",
        "transition-all focus-within:border-ring hover:border-ring",
        deleting && "pointer-events-none opacity-50",
      )}
    >
      <button
        type="button"
        onClick={onClick}
        disabled={uploading || saving || deleting}
        aria-label={uploading ? "Screenshot uploading" : "Save and copy screenshot"}
        className={cn(
          "block size-full",
          "focus-visible:outline-none focus-visible:ring-ring/50 focus-visible:ring-[3px]",
          (uploading || saving) && "cursor-default",
        )}
      >
      {src && !failed ? (
        <img
          src={src}
          alt="Synced screenshot"
          className="size-full object-cover"
          draggable={false}
          onError={() => setFailed(true)}
        />
      ) : failed ? (
        <div
          className="flex size-full flex-col items-center justify-center gap-1 bg-muted text-muted-foreground"
          aria-label="Preview unavailable"
        >
          <ImageOff className="size-5" aria-hidden="true" />
          <span className="text-[10px]">Preview unavailable</span>
        </div>
      ) : (
        <div className="size-full animate-pulse bg-muted" aria-hidden="true" />
      )}

      {uploading && (
        <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/65 px-2 py-0.5 text-[11px] font-medium text-white">
          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
          Syncing
        </span>
      )}

      <span
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent px-2.5 py-2 text-[11px] text-white opacity-0 transition-opacity",
          !uploading && "group-hover:opacity-100",
          saved && "opacity-100",
        )}
      >
        <span className="truncate">{item.device.name || item.device.platform}</span>
        {saved ? (
          <span className="inline-flex items-center gap-1 font-medium">
            <Check className="size-3" aria-hidden="true" /> Copied
          </span>
        ) : (
          <span className="tabular-nums">{item.width}×{item.height}</span>
        )}
      </span>
      </button>

      <button
        type="button"
        onClick={onDelete}
        disabled={deleting || !uid}
        aria-label="Delete screenshot"
        title="Delete"
        className={cn(
          "absolute right-2 top-2 z-10 inline-flex size-7 items-center justify-center rounded-full",
          "bg-black/55 text-white shadow-md backdrop-blur-sm transition-opacity hover:bg-red-600/90",
          "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 cursor-pointer disabled:cursor-wait",
        )}
      >
        {deleting ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Trash2 className="size-3.5" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}

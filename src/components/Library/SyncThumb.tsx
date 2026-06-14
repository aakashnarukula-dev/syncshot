import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, ImageOff, Loader2 } from "lucide-react";
import { saveReceivedScreenshot, storageDownloadUrl } from "@/lib/sync/screenshots";
import type { ScreenshotDoc } from "@/lib/sync/types";
import { cn } from "@/lib/utils";

interface SyncThumbProps {
  item: ScreenshotDoc;
}

/** A single synced screenshot tile: WebP thumb (loaded as a CSP-safe blob URL),
 *  click to download the full image + copy it to this Mac's clipboard. */
export function SyncThumb({ item }: SyncThumbProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Render via the Storage getDownloadURL token URL as a plain <img src>. The
  // token is a capability (bypasses Storage rules + CORS), so an <img> load
  // succeeds with no bucket-CORS config — unlike getBytes()/getBlob(), whose
  // XHR the bucket blocks, which left this tile stuck on "Preview unavailable".
  useEffect(() => {
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
  }, [item.thumbPath]);

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

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={uploading || saving}
      aria-label={uploading ? "Screenshot uploading" : "Save and copy screenshot"}
      className={cn(
        "group relative block aspect-[4/3] w-full overflow-hidden rounded-lg border border-border bg-muted",
        "transition-all hover:border-ring focus-visible:outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
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
  );
}

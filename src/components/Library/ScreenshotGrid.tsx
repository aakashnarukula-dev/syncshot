import { useEffect, useRef } from "react";
import { ImageIcon, Loader2 } from "lucide-react";
import {
  loadMoreScreenshots,
  useScreenshots,
  useScreenshotsHasMore,
} from "@/stores/syncStore";
import { SyncThumb } from "./SyncThumb";

interface ScreenshotGridProps {
  /** Whether this Mac is paired into a library yet. */
  paired: boolean;
  /** Switch the library nav to the Pairing section. */
  onOpenPairing: () => void;
}

export function ScreenshotGrid({ paired, onOpenPairing }: ScreenshotGridProps) {
  const screenshots = useScreenshots();
  const hasMore = useScreenshotsHasMore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Lazy paging: when the sentinel below the grid scrolls within ~600px of the
  // viewport, pull the next older page. The engine GROWS the live Firestore
  // window (subscribeScreenshots) so we never fetch all 100+ shots up front.
  // Re-running on screenshots.length lets a page that lands still inside the
  // prefetch margin immediately trigger the next one.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root || !hasMore) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMoreScreenshots();
      },
      { root, rootMargin: "600px 0px" },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [hasMore, screenshots.length]);

  if (!paired) {
    return (
      <EmptyState
        title="Pair a device to start syncing"
        body="Capture a screenshot on any paired device and it appears here in under a second."
        actionLabel="Set up pairing"
        onAction={onOpenPairing}
      />
    );
  }

  if (screenshots.length === 0) {
    return (
      <EmptyState
        title="No screenshots yet"
        body="Capture with ⇧⌘2, or take a screenshot on a paired device — it'll show up here automatically."
      />
    );
  }

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto p-6">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {screenshots.map((item) => (
          <SyncThumb key={item.id} item={item} />
        ))}
      </div>
      {hasMore && (
        <div
          ref={sentinelRef}
          className="flex items-center justify-center py-6 text-muted-foreground"
          aria-hidden="true"
        >
          <Loader2 className="size-4 animate-spin" />
        </div>
      )}
    </div>
  );
}

interface EmptyStateProps {
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
}

function EmptyState({ title, body, actionLabel, onAction }: EmptyStateProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <ImageIcon className="size-6" aria-hidden="true" />
      </div>
      <h2 className="text-balance text-lg font-semibold">{title}</h2>
      <p className="max-w-sm text-pretty text-sm text-muted-foreground">{body}</p>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="mt-1 inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

import { useMemo, useState } from "react";
import { ClipboardList, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { setSyncPaused } from "@/lib/sync/engine";
import { useClipboardEntries, usePaused } from "@/stores/syncStore";
import { ClipboardEntry } from "./ClipboardEntry";

interface ClipboardPanelProps {
  /** Whether this Mac is paired into a library yet. */
  paired: boolean;
  uid: string | null;
  onOpenPairing: () => void;
}

export function ClipboardPanel({ paired, uid, onOpenPairing }: ClipboardPanelProps) {
  const entries = useClipboardEntries();
  const paused = usePaused();
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matched = q
      ? entries.filter((e) => e.text.toLowerCase().includes(q))
      : entries;
    // Pinned first, otherwise preserve the createdAt-desc order from Firestore.
    return [...matched].sort((a, b) => Number(b.pinned) - Number(a.pinned));
  }, [entries, search]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-border px-6 py-3">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search clipboard"
            aria-label="Search clipboard entries"
            className="pl-8"
            disabled={!paired}
          />
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm text-muted-foreground">
          <span>Pause capture</span>
          <Switch
            checked={paused}
            onCheckedChange={(v) => void setSyncPaused(v)}
            aria-label="Pause clipboard capture"
          />
        </label>
      </div>

      {paused && (
        <p className="border-b border-border bg-accent/40 px-6 py-2 text-xs text-accent-foreground">
          Clipboard capture is paused — copies on this Mac won't sync until you resume.
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {!paired ? (
          <Empty
            title="Pair a device to sync your clipboard"
            body="Once paired, every text you copy on this Mac is captured and shared with your devices in realtime."
            actionLabel="Set up pairing"
            onAction={onOpenPairing}
          />
        ) : filtered.length === 0 ? (
          <Empty
            title={search ? "No matching entries" : "Clipboard is empty"}
            body={
              search
                ? "Try a different search term."
                : "Copy some text — it'll appear here and on every paired device."
            }
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {uid &&
              filtered.map((entry) => (
                <ClipboardEntry key={entry.id} uid={uid} entry={entry} />
              ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface EmptyProps {
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
}

function Empty({ title, body, actionLabel, onAction }: EmptyProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <ClipboardList className="size-6" aria-hidden="true" />
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

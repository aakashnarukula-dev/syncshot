import { useState } from "react";
import { toast } from "sonner";
import { Check, Copy, Pin, PinOff, Trash2 } from "lucide-react";
import {
  deleteClipboardEntry,
  setClipboardPinned,
  setLocalClipboard,
} from "@/lib/sync/clipboard";
import type { ClipboardDoc } from "@/lib/sync/types";
import { cn } from "@/lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

interface ClipboardEntryProps {
  uid: string;
  entry: ClipboardDoc;
}

export function relativeTime(ms: number | null): string {
  if (!ms) return "syncing…";
  const diff = Date.now() - ms;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

export function ClipboardEntry({ uid, entry }: ClipboardEntryProps) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const recopy = async () => {
    try {
      await setLocalClipboard(entry.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch (err) {
      toast.error("Couldn't copy", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const togglePin = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await setClipboardPinned(uid, entry.id, !entry.pinned);
    } catch (err) {
      toast.error("Couldn't update pin", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    try {
      await deleteClipboardEntry(uid, entry.id);
    } catch (err) {
      toast.error("Couldn't delete", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <li
      className={cn(
        "group relative flex items-start gap-3 rounded-lg border border-border bg-card p-3 transition-colors hover:border-ring/60",
        entry.pinned && "border-ring/40 bg-accent/40",
      )}
    >
      <button
        type="button"
        onClick={recopy}
        className="min-w-0 flex-1 text-left focus-visible:outline-none"
        aria-label="Copy this entry to the clipboard"
      >
        <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm text-card-foreground">
          {entry.text}
        </p>
        <p className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate">{entry.device.name || entry.device.platform}</span>
          <span aria-hidden="true">·</span>
          <span className="shrink-0 tabular-nums">{relativeTime(entry.createdAt)}</span>
          <span aria-hidden="true">·</span>
          <span className="shrink-0 tabular-nums">{entry.charCount} chars</span>
        </p>
      </button>

      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={recopy}
          aria-label="Copy to clipboard"
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          {copied ? (
            <Check className="size-4 text-primary" aria-hidden="true" />
          ) : (
            <Copy className="size-4" aria-hidden="true" />
          )}
        </button>

        <button
          type="button"
          onClick={togglePin}
          aria-label={entry.pinned ? "Unpin entry" : "Pin entry"}
          aria-pressed={entry.pinned}
          className={cn(
            "flex size-7 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-accent-foreground",
            entry.pinned ? "text-primary" : "text-muted-foreground",
          )}
        >
          {entry.pinned ? (
            <PinOff className="size-4" aria-hidden="true" />
          ) : (
            <Pin className="size-4" aria-hidden="true" />
          )}
        </button>

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <button
              type="button"
              aria-label="Delete entry"
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="size-4" aria-hidden="true" />
            </button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete clipboard entry?</AlertDialogTitle>
              <AlertDialogDescription>
                This removes the entry from every paired device. This can't be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={remove}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </li>
  );
}

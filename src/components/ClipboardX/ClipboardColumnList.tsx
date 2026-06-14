import { useState } from "react";
import { toast } from "sonner";
import { Check, Pin, PinOff, Trash2 } from "lucide-react";
import {
  deleteClipboardEntry,
  setClipboardPinned,
  setLocalClipboard,
} from "@/lib/sync/clipboard";
import { useClipboardEntries, useUid } from "@/stores/syncStore";
import type { ClipboardDoc } from "@/lib/sync/types";
import { cn } from "@/lib/utils";
import { relativeTime } from "./ClipboardEntry";

// Compact copied-text cards for the 240px edge column. This module pulls in
// lib/sync/clipboard (→ Firebase), so it must only ever be loaded lazily from
// the column — never statically from the launch-critical chunk.
export function ClipboardColumnList() {
  const entries = useClipboardEntries();
  const uid = useUid();

  if (entries.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-1 px-4 text-center">
        <p className="text-sm text-white/80">No copied text yet</p>
        <p className="text-xs text-white/50">
          {uid
            ? "Text you copy on paired devices shows up here."
            : "Pair a device to sync your clipboard."}
        </p>
      </div>
    );
  }

  return (
    <ul
      data-thumb-scroll
      className="flex-1 min-w-0 overflow-y-auto pt-1 pb-4 pr-3 pl-1 flex flex-col gap-2 items-stretch [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]"
      style={{
        background: "transparent",
        maskImage:
          "linear-gradient(to bottom, transparent 0, black 4px, black calc(100% - 6px), transparent 100%)",
        WebkitMaskImage:
          "linear-gradient(to bottom, transparent 0, black 4px, black calc(100% - 6px), transparent 100%)",
      }}
    >
      {entries.map((entry) => (
        <ClipCard key={entry.id} uid={uid} entry={entry} />
      ))}
    </ul>
  );
}

interface ClipCardProps {
  uid: string | null;
  entry: ClipboardDoc;
}

function ClipCard({ uid, entry }: ClipCardProps) {
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
    if (busy || !uid) return;
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
    if (!uid) return;
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
        "group relative shrink-0 rounded-md bg-neutral-900/90 p-2.5 text-white transition-colors hover:bg-neutral-800/95",
        entry.pinned && "ring-1 ring-white/25",
      )}
    >
      <button
        type="button"
        onClick={recopy}
        aria-label="Copy this entry to the clipboard"
        className="block w-full text-left cursor-pointer focus-visible:outline-none"
      >
        <p className="line-clamp-4 whitespace-pre-wrap break-words text-xs leading-4 text-white/90">
          {entry.text}
        </p>
        <p className="mt-1.5 flex items-center gap-1.5 text-[10px] text-white/50">
          {copied ? (
            <span className="flex items-center gap-1 text-green-400">
              <Check className="size-3" aria-hidden="true" />
              Copied
            </span>
          ) : (
            <span className="tabular-nums">{relativeTime(entry.createdAt)}</span>
          )}
        </p>
      </button>

      <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={togglePin}
          aria-label={entry.pinned ? "Unpin entry" : "Pin entry"}
          aria-pressed={entry.pinned}
          className={cn(
            "flex size-5 items-center justify-center rounded bg-black/55 backdrop-blur-sm cursor-pointer",
            entry.pinned ? "text-white" : "text-white/60 hover:text-white",
          )}
        >
          {entry.pinned ? (
            <PinOff className="size-3" aria-hidden="true" />
          ) : (
            <Pin className="size-3" aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          onClick={remove}
          aria-label="Delete entry"
          className="flex size-5 items-center justify-center rounded bg-black/55 backdrop-blur-sm text-white/60 hover:bg-red-600/90 hover:text-white cursor-pointer"
        >
          <Trash2 className="size-3" aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}

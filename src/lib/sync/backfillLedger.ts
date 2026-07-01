/**
 * Backfill ledger — remembers which local files were already published so
 * sign-in backfill hashes a file AT MOST ONCE EVER.
 *
 * A published capture is normally renamed to `{docId}.<ext>` and skipped by
 * `isSyncedCacheFile`, but every file that KEEPS a non-doc-id name (rename
 * failed, legacy `syncshot_…`/`synced_…` editor saves) re-paid a full-res IPC
 * byte read + sha256 + dupe query on EVERY launch just to no-op. The ledger
 * persists path → {docId, sha256} (plus mtime/size when a stat is available)
 * in localStorage, keyed per uid so an account switch never skips files the
 * new account hasn't seen.
 *
 * Validation: when BOTH the stored entry and the caller carry mtime/size, a
 * mismatch (file replaced in place) invalidates the entry and the file is
 * re-hashed. Without stat data the path alone is trusted — capture files are
 * write-once, so a same-path different-content swap is not a real flow.
 */

export interface FileStat {
  mtimeMs: number;
  size: number;
}

export interface LedgerEntry {
  docId: string;
  sha256: string;
  mtimeMs?: number;
  size?: number;
}

export interface BackfillLedger {
  /** Entry for `path` if present AND not invalidated by a stat mismatch. */
  get: (path: string, stat?: FileStat | null) => LedgerEntry | null;
  put: (path: string, entry: LedgerEntry) => void;
  /** Drop entries whose path is no longer on disk (keeps storage bounded). */
  prune: (livePaths: string[]) => void;
  /** Persist pending writes. Call once after a backfill pass, not per file. */
  flush: () => void;
}

const KEY_PREFIX = "syncshot.backfillLedger.v1:";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): StorageLike | null {
  try {
    // Method check matters: Node ≥22 exposes an experimental `localStorage`
    // global whose methods are undefined without --localstorage-file (seen in
    // vitest) — treat that as "no storage" rather than throwing on use.
    if (
      typeof localStorage === "undefined" ||
      typeof localStorage.getItem !== "function" ||
      typeof localStorage.setItem !== "function"
    ) {
      return null;
    }
    return localStorage;
  } catch {
    return null;
  }
}

export function createBackfillLedger(
  uid: string,
  storageArea: StorageLike | null = defaultStorage(),
): BackfillLedger {
  const key = KEY_PREFIX + uid;
  let entries: Record<string, LedgerEntry> = {};
  let dirty = false;

  try {
    const raw = storageArea?.getItem(key);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        entries = parsed as Record<string, LedgerEntry>;
      }
    }
  } catch {
    entries = {}; // corrupted ledger → start fresh (worst case: one re-hash)
  }

  return {
    get(path: string, stat?: FileStat | null): LedgerEntry | null {
      const entry = entries[path];
      if (!entry || !entry.docId) return null;
      if (
        stat &&
        entry.mtimeMs !== undefined &&
        entry.size !== undefined &&
        (entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size)
      ) {
        delete entries[path];
        dirty = true;
        return null;
      }
      return entry;
    },
    put(path: string, entry: LedgerEntry): void {
      entries[path] = entry;
      dirty = true;
    },
    prune(livePaths: string[]): void {
      const live = new Set(livePaths);
      for (const path of Object.keys(entries)) {
        if (!live.has(path)) {
          delete entries[path];
          dirty = true;
        }
      }
    },
    flush(): void {
      if (!dirty) return;
      dirty = false;
      try {
        storageArea?.setItem(key, JSON.stringify(entries));
      } catch {
        /* quota/unavailable — ledger is an optimization, never fatal */
      }
    },
  };
}

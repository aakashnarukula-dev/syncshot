/**
 * Memoizing cache for Storage download-URL resolution.
 *
 * getDownloadURL fires one Storage RPC per call; the tile grid called it per
 * tile per MOUNT, so every cold open / scroll produced a wave of identical
 * RPCs. Tokenized download URLs are long-lived capabilities, so they cache
 * safely: entries live for `ttlMs` (default 1h), a rejected fetch is never
 * cached, and concurrent requests for the same path share ONE in-flight
 * promise (N tiles asking for one path = one RPC).
 *
 * Pure logic with an injectable clock — screenshots.ts wires it to
 * `getDownloadURL`; tests wire it to fakes.
 */

export interface DownloadUrlCache {
  get: (path: string) => Promise<string>;
  /** Drop a path (e.g. its object was deleted, or a consumer hit a 404). */
  invalidate: (path: string) => void;
  /** Drop everything (sign-out / account switch). */
  clear: () => void;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;

export function createDownloadUrlCache(
  fetcher: (path: string) => Promise<string>,
  opts: { ttlMs?: number; now?: () => number } = {},
): DownloadUrlCache {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { url: string; expiresAt: number }>();
  const inFlight = new Map<string, Promise<string>>();

  return {
    get(path: string): Promise<string> {
      const hit = cache.get(path);
      if (hit && hit.expiresAt > now()) return Promise.resolve(hit.url);
      const pending = inFlight.get(path);
      if (pending) return pending;
      const p = fetcher(path).then(
        (url) => {
          cache.set(path, { url, expiresAt: now() + ttlMs });
          inFlight.delete(path);
          return url;
        },
        (err) => {
          inFlight.delete(path);
          cache.delete(path);
          throw err;
        },
      );
      inFlight.set(path, p);
      return p;
    },
    invalidate(path: string): void {
      cache.delete(path);
      inFlight.delete(path);
    },
    clear(): void {
      cache.clear();
      inFlight.clear();
    },
  };
}

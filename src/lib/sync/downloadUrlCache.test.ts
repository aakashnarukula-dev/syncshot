import { describe, expect, it, vi } from "vitest";
import { createDownloadUrlCache } from "./downloadUrlCache";

describe("createDownloadUrlCache", () => {
  it("resolves via the fetcher once, then serves the cached URL", async () => {
    const fetcher = vi.fn((p: string) => Promise.resolve(`url:${p}`));
    const cache = createDownloadUrlCache(fetcher);

    expect(await cache.get("a/thumb.webp")).toBe("url:a/thumb.webp");
    expect(await cache.get("a/thumb.webp")).toBe("url:a/thumb.webp");
    expect(await cache.get("a/thumb.webp")).toBe("url:a/thumb.webp");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent requests for the same path into ONE fetch", async () => {
    let resolveFetch!: (url: string) => void;
    const fetcher = vi.fn(
      () => new Promise<string>((resolve) => (resolveFetch = resolve)),
    );
    const cache = createDownloadUrlCache(fetcher);

    // N tiles mount and ask for the same storage path before the RPC returns.
    const p1 = cache.get("a/thumb.webp");
    const p2 = cache.get("a/thumb.webp");
    const p3 = cache.get("a/thumb.webp");
    expect(fetcher).toHaveBeenCalledTimes(1);

    resolveFetch("url:a");
    expect(await Promise.all([p1, p2, p3])).toEqual(["url:a", "url:a", "url:a"]);
  });

  it("caches per path, not globally", async () => {
    const fetcher = vi.fn((p: string) => Promise.resolve(`url:${p}`));
    const cache = createDownloadUrlCache(fetcher);

    expect(await cache.get("a")).toBe("url:a");
    expect(await cache.get("b")).toBe("url:b");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("expires entries after the TTL and refetches", async () => {
    let nowMs = 0;
    const fetcher = vi.fn((p: string) => Promise.resolve(`url:${p}`));
    const cache = createDownloadUrlCache(fetcher, {
      ttlMs: 1000,
      now: () => nowMs,
    });

    await cache.get("a");
    nowMs = 999;
    await cache.get("a"); // still fresh
    expect(fetcher).toHaveBeenCalledTimes(1);

    nowMs = 1001;
    await cache.get("a"); // expired → refetch
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("never caches a rejected fetch — the next get retries", async () => {
    const fetcher = vi
      .fn<(p: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error("storage down"))
      .mockResolvedValue("url:ok");
    const cache = createDownloadUrlCache(fetcher);

    await expect(cache.get("a")).rejects.toThrow("storage down");
    expect(await cache.get("a")).toBe("url:ok");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("invalidate() forces a refetch for that path only", async () => {
    const fetcher = vi.fn((p: string) => Promise.resolve(`url:${p}`));
    const cache = createDownloadUrlCache(fetcher);

    await cache.get("a");
    await cache.get("b");
    cache.invalidate("a");
    await cache.get("a"); // refetched
    await cache.get("b"); // still cached
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("clear() drops everything", async () => {
    const fetcher = vi.fn((p: string) => Promise.resolve(`url:${p}`));
    const cache = createDownloadUrlCache(fetcher);

    await cache.get("a");
    cache.clear();
    await cache.get("a");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

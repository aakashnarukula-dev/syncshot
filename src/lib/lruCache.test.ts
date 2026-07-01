import { describe, expect, it, vi } from "vitest";
import { LruCache } from "./lruCache";

describe("LruCache", () => {
  it("stores and retrieves values", () => {
    const lru = new LruCache<string, number>(3);
    lru.set("a", 1);
    lru.set("b", 2);
    expect(lru.get("a")).toBe(1);
    expect(lru.get("b")).toBe(2);
    expect(lru.get("missing")).toBeUndefined();
    expect(lru.size).toBe(2);
  });

  it("evicts the least-recently-used entry past capacity", () => {
    const evicted: Array<[string, number]> = [];
    const lru = new LruCache<string, number>(2, (k, v) => evicted.push([k, v]));
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("c", 3);
    expect(evicted).toEqual([["a", 1]]);
    expect(lru.has("a")).toBe(false);
    expect(lru.has("b")).toBe(true);
    expect(lru.has("c")).toBe(true);
  });

  it("get refreshes recency so hot entries survive eviction", () => {
    const evicted: string[] = [];
    const lru = new LruCache<string, number>(2, (k) => evicted.push(k));
    lru.set("a", 1);
    lru.set("b", 2);
    lru.get("a"); // a is now most recent
    lru.set("c", 3);
    expect(evicted).toEqual(["b"]);
    expect(lru.has("a")).toBe(true);
  });

  it("peek does not refresh recency", () => {
    const evicted: string[] = [];
    const lru = new LruCache<string, number>(2, (k) => evicted.push(k));
    lru.set("a", 1);
    lru.set("b", 2);
    lru.peek("a");
    lru.set("c", 3);
    expect(evicted).toEqual(["a"]);
  });

  it("re-setting an existing key updates value without eviction", () => {
    const onEvict = vi.fn();
    const lru = new LruCache<string, number>(2, onEvict);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("a", 10);
    expect(onEvict).not.toHaveBeenCalled();
    expect(lru.get("a")).toBe(10);
    expect(lru.size).toBe(2);
  });

  it("delete runs onEvict for the removed entry", () => {
    const onEvict = vi.fn();
    const lru = new LruCache<string, number>(2, onEvict);
    lru.set("a", 1);
    expect(lru.delete("a")).toBe(true);
    expect(lru.delete("a")).toBe(false);
    expect(onEvict).toHaveBeenCalledTimes(1);
    expect(onEvict).toHaveBeenCalledWith("a", 1);
  });

  it("clear evicts everything", () => {
    const onEvict = vi.fn();
    const lru = new LruCache<string, number>(3, onEvict);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.clear();
    expect(onEvict).toHaveBeenCalledTimes(2);
    expect(lru.size).toBe(0);
  });
});

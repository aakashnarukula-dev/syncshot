/**
 * Minimal LRU cache on Map insertion order. `get` refreshes recency; inserting
 * past `capacity` evicts the least-recently-used entry through `onEvict` (used
 * by the thumbnail cache to revoke evicted blob object URLs — and ONLY evicted
 * ones, so cached thumbnails survive column mount/unmount cycles).
 */
export class LruCache<K, V> {
  private map = new Map<K, V>();

  constructor(
    private readonly capacity: number,
    private readonly onEvict?: (key: K, value: V) => void,
  ) {
    if (capacity < 1) throw new Error("LruCache capacity must be >= 1");
  }

  get size(): number {
    return this.map.size;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key)!;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  /** Peek without refreshing recency. */
  peek(key: K): V | undefined {
    return this.map.get(key);
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as K;
      const evicted = this.map.get(oldest)!;
      this.map.delete(oldest);
      this.onEvict?.(oldest, evicted);
    }
  }

  /** Remove one entry, running `onEvict` on it (e.g. shot deleted from disk). */
  delete(key: K): boolean {
    if (!this.map.has(key)) return false;
    const value = this.map.get(key)!;
    this.map.delete(key);
    this.onEvict?.(key, value);
    return true;
  }

  clear(): void {
    for (const [key, value] of this.map) this.onEvict?.(key, value);
    this.map.clear();
  }
}

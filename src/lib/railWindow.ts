/**
 * Windowing math for the edge-rail lists: fixed-height slots in a vertical
 * column, so the visible index range is pure arithmetic — no per-item
 * measurement, no IntersectionObservers.
 */

export interface WindowRange {
  /** First rendered index (inclusive). */
  start: number;
  /** One past the last rendered index (exclusive). */
  end: number;
}

/** Number of older screenshots kept warm beyond the visible rail viewport.
 * Tiny 320px WebP thumbnails are cheap; one viewport plus a full scroll-ahead
 * page prevents fast trackpad movement from outrunning network decode. */
export const RAIL_THUMB_BUFFER = 12;

/**
 * Forward-only preload range for a newest-first rail. Items below the viewport
 * are older and are what a downward scroll reveals next. Items above were
 * already visible/cached, so re-requesting them would steal bandwidth from the
 * useful forward buffer.
 */
export function computePreloadRange(
  visibleStart: number,
  visibleEnd: number,
  count: number,
  buffer = RAIL_THUMB_BUFFER,
): WindowRange {
  const start = Math.max(0, Math.min(count, visibleStart));
  const end = Math.max(start, Math.min(count, visibleEnd + Math.max(0, buffer)));
  return { start, end };
}

export function computeWindowRange(
  scrollTop: number,
  viewportHeight: number,
  count: number,
  itemHeight: number,
  gap: number,
  overscan: number,
): WindowRange {
  if (count <= 0 || itemHeight <= 0) return { start: 0, end: 0 };
  const stride = itemHeight + gap;
  const first = Math.floor(Math.max(0, scrollTop) / stride);
  const last = Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewportHeight)) / stride);
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(count, last + overscan),
  };
}

export function windowTotalHeight(count: number, itemHeight: number, gap: number): number {
  if (count <= 0) return 0;
  return count * itemHeight + (count - 1) * gap;
}

export function windowItemTop(index: number, itemHeight: number, gap: number): number {
  return index * (itemHeight + gap);
}

/** Start the next Firestore metadata page while the preloaded thumbnail buffer
 * is still ahead of the viewport, not after the user reaches the final tile. */
export function shouldLoadMore(
  scrollTop: number,
  viewportHeight: number,
  totalHeight: number,
  itemStride: number,
  buffer = RAIL_THUMB_BUFFER,
): boolean {
  if (totalHeight <= 0 || itemStride <= 0) return false;
  const remaining = totalHeight - (Math.max(0, scrollTop) + Math.max(0, viewportHeight));
  return remaining <= itemStride * Math.max(0, buffer);
}

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

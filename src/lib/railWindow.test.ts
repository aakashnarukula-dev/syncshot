import { describe, expect, it } from "vitest";
import { computePreloadRange, computeWindowRange, windowItemTop, windowTotalHeight } from "./railWindow";

const ITEM = 155;
const GAP = 20;
const STRIDE = ITEM + GAP;

describe("computeWindowRange", () => {
  it("renders from the top with overscan below at scrollTop 0", () => {
    const r = computeWindowRange(0, 700, 371, ITEM, GAP, 12);
    expect(r.start).toBe(0);
    // ceil(700/175)=4 visible → +12 overscan
    expect(r.end).toBe(16);
  });

  it("windows the middle of a long list", () => {
    const scrollTop = 100 * STRIDE; // item 100 at the top edge
    const r = computeWindowRange(scrollTop, 700, 371, ITEM, GAP, 12);
    expect(r.start).toBe(88);
    expect(r.end).toBe(116);
    // A ~30-item window instead of all 371.
    expect(r.end - r.start).toBeLessThanOrEqual(30);
  });

  it("clamps at the end of the list", () => {
    const r = computeWindowRange(370 * STRIDE, 700, 371, ITEM, GAP, 12);
    expect(r.end).toBe(371);
    expect(r.start).toBeLessThan(371);
  });

  it("returns an empty range for an empty list or unmeasured item height", () => {
    expect(computeWindowRange(0, 700, 0, ITEM, GAP, 12)).toEqual({ start: 0, end: 0 });
    expect(computeWindowRange(0, 700, 10, 0, GAP, 12)).toEqual({ start: 0, end: 0 });
  });

  it("tolerates negative scrollTop (rubber-banding)", () => {
    const r = computeWindowRange(-50, 700, 371, ITEM, GAP, 2);
    expect(r.start).toBe(0);
    expect(r.end).toBeGreaterThan(0);
  });

  it("covers every visible item exactly (no gaps while scrolling)", () => {
    for (let scrollTop = 0; scrollTop < 20 * STRIDE; scrollTop += 37) {
      const r = computeWindowRange(scrollTop, 650, 371, ITEM, GAP, 0);
      // First fully/partially visible item must be included…
      expect(r.start).toBeLessThanOrEqual(Math.floor(scrollTop / STRIDE));
      // …and the last one at the bottom edge too (an item whose top sits
      // exactly AT the bottom edge is not visible yet).
      const lastVisible = Math.min(370, Math.ceil((scrollTop + 650) / STRIDE) - 1);
      expect(r.end).toBeGreaterThan(lastVisible);
    }
  });
});

describe("windowTotalHeight", () => {
  it("matches the flex-column height it replaces", () => {
    expect(windowTotalHeight(0, ITEM, GAP)).toBe(0);
    expect(windowTotalHeight(1, ITEM, GAP)).toBe(ITEM);
    expect(windowTotalHeight(4, ITEM, GAP)).toBe(4 * ITEM + 3 * GAP);
  });
});

describe("windowItemTop", () => {
  it("positions items on the stride grid", () => {
    expect(windowItemTop(0, ITEM, GAP)).toBe(0);
    expect(windowItemTop(5, ITEM, GAP)).toBe(5 * STRIDE);
  });
});

describe("computePreloadRange", () => {
  it("keeps visible items plus three older screenshots warm", () => {
    expect(computePreloadRange(10, 15, 100)).toEqual({ start: 10, end: 18 });
  });

  it("clamps the buffer at the end without revisiting older cached items", () => {
    expect(computePreloadRange(97, 100, 100)).toEqual({ start: 97, end: 100 });
  });
});

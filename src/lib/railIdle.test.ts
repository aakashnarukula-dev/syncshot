import { afterEach, describe, expect, it, vi } from "vitest";
import { createRailIdleTimer } from "./railIdle";

afterEach(() => vi.useRealTimers());
describe("rail idle deadline", () => {
  it("recovers when native mouseleave is missing after a monitor move", async () => {
    vi.useFakeTimers();
    const occupied = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const close = vi.fn();
    const timer = createRailIdleTimer(5000, occupied, close);
    timer.restart();
    await vi.advanceTimersByTimeAsync(5000);
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(close).toHaveBeenCalledOnce();
  });
  it("ignores an old cursor query after a fresh capture resets the deadline", async () => {
    vi.useFakeTimers();
    let resolve!: (busy: boolean) => void;
    const close = vi.fn();
    const timer = createRailIdleTimer(5000, () => new Promise(r => { resolve = r; }), close);
    timer.restart();
    await vi.advanceTimersByTimeAsync(5000);
    timer.restart();
    resolve(false);
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    timer.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(close).not.toHaveBeenCalled();
  });
  it("closes after native hover query fails", async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    const timer = createRailIdleTimer(5000, async () => { throw Error("window moved"); }, close);
    timer.restart();
    await vi.advanceTimersByTimeAsync(5000);
    expect(close).toHaveBeenCalledOnce();
  });
});

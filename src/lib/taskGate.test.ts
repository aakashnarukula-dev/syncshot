import { describe, expect, it } from "vitest";
import { TaskGate } from "./taskGate";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("TaskGate", () => {
  it("runs up to the limit concurrently and queues the rest", async () => {
    const gate = new TaskGate(2);
    const d1 = deferred<string>();
    const d2 = deferred<string>();
    const d3 = deferred<string>();
    const h1 = gate.schedule(() => d1.promise);
    const h2 = gate.schedule(() => d2.promise);
    const h3 = gate.schedule(() => d3.promise);
    expect(gate.running).toBe(2);
    expect(gate.pending).toBe(1);

    d1.resolve("one");
    await expect(h1.promise).resolves.toBe("one");
    expect(gate.running).toBe(2); // third task promoted

    d2.resolve("two");
    d3.resolve("three");
    await expect(h2.promise).resolves.toBe("two");
    await expect(h3.promise).resolves.toBe("three");
    expect(gate.running).toBe(0);
    expect(gate.pending).toBe(0);
  });

  it("cancelling a queued task resolves null without running it", async () => {
    const gate = new TaskGate(1);
    const d1 = deferred<string>();
    let ran = false;
    gate.schedule(() => d1.promise);
    const h2 = gate.schedule(async () => {
      ran = true;
      return "never";
    });
    h2.cancel();
    await expect(h2.promise).resolves.toBeNull();
    expect(ran).toBe(false);
    expect(gate.pending).toBe(0);
    d1.resolve("done");
  });

  it("cancelling a running task is a no-op — it still completes", async () => {
    const gate = new TaskGate(1);
    const d1 = deferred<string>();
    const h1 = gate.schedule(() => d1.promise);
    h1.cancel();
    d1.resolve("finished");
    await expect(h1.promise).resolves.toBe("finished");
  });

  it("propagates rejections and keeps pumping the queue", async () => {
    const gate = new TaskGate(1);
    const h1 = gate.schedule(async () => {
      throw new Error("boom");
    });
    const h2 = gate.schedule(async () => "after");
    await expect(h1.promise).rejects.toThrow("boom");
    await expect(h2.promise).resolves.toBe("after");
    expect(gate.running).toBe(0);
  });

  it("serves the queue in FIFO order", async () => {
    const gate = new TaskGate(1);
    const order: number[] = [];
    const handles = [1, 2, 3].map((n) =>
      gate.schedule(async () => {
        order.push(n);
        return n;
      }),
    );
    await Promise.all(handles.map((h) => h.promise));
    expect(order).toEqual([1, 2, 3]);
  });
});

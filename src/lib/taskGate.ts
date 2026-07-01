/**
 * Concurrency gate: at most `limit` tasks run at once, the rest queue in FIFO
 * order (tiles mount top-down, so visible tiles are served first). A queued
 * task can be cancelled — it resolves `null` without ever running. Cancelling
 * a task that already started is a no-op (it completes and its result can
 * still be cached by the caller).
 */

interface GateEntry<T> {
  fn: () => Promise<T>;
  resolve: (value: T | null) => void;
  reject: (reason: unknown) => void;
  state: "queued" | "running" | "settled";
}

export interface GateHandle<T> {
  promise: Promise<T | null>;
  /** Drop the task if it hasn't started; resolves its promise with null. */
  cancel: () => void;
}

export class TaskGate {
  private queue: GateEntry<unknown>[] = [];
  private active = 0;

  constructor(private readonly limit: number) {
    if (limit < 1) throw new Error("TaskGate limit must be >= 1");
  }

  get running(): number {
    return this.active;
  }

  get pending(): number {
    return this.queue.length;
  }

  schedule<T>(fn: () => Promise<T>): GateHandle<T> {
    let entry!: GateEntry<T>;
    const promise = new Promise<T | null>((resolve, reject) => {
      entry = { fn, resolve, reject, state: "queued" };
    });
    this.queue.push(entry as GateEntry<unknown>);
    this.pump();
    return {
      promise,
      cancel: () => {
        if (entry.state !== "queued") return;
        entry.state = "settled";
        const i = this.queue.indexOf(entry as GateEntry<unknown>);
        if (i >= 0) this.queue.splice(i, 1);
        entry.resolve(null);
      },
    };
  }

  private pump(): void {
    while (this.active < this.limit && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      if (entry.state !== "queued") continue;
      entry.state = "running";
      this.active += 1;
      entry.fn().then(
        (value) => {
          entry.state = "settled";
          this.active -= 1;
          entry.resolve(value);
          this.pump();
        },
        (reason) => {
          entry.state = "settled";
          this.active -= 1;
          entry.reject(reason);
          this.pump();
        },
      );
    }
  }
}

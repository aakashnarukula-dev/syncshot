import { beforeEach, describe, expect, it } from "vitest";
import { createBackfillLedger, type LedgerEntry } from "./backfillLedger";

function makeStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> & {
  data: Map<string, string>;
} {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

const ENTRY: LedgerEntry = {
  docId: "Doc00000000000000001",
  sha256: "sha-abc",
  mtimeMs: 1000,
  size: 42,
};

describe("createBackfillLedger", () => {
  let storage: ReturnType<typeof makeStorage>;

  beforeEach(() => {
    storage = makeStorage();
  });

  it("misses for unknown paths and hits after put+flush across instances", () => {
    const ledger = createBackfillLedger("u1", storage);
    expect(ledger.get("/cache/legacy_1.png")).toBeNull();

    ledger.put("/cache/legacy_1.png", ENTRY);
    ledger.flush();

    // A NEW instance (next launch) reads the persisted entry back.
    const reloaded = createBackfillLedger("u1", storage);
    expect(reloaded.get("/cache/legacy_1.png")).toEqual(ENTRY);
  });

  it("hits without a stat (path-only trust) and with a MATCHING stat", () => {
    const ledger = createBackfillLedger("u1", storage);
    ledger.put("/p", ENTRY);

    expect(ledger.get("/p")).toEqual(ENTRY);
    expect(ledger.get("/p", null)).toEqual(ENTRY);
    expect(ledger.get("/p", { mtimeMs: 1000, size: 42 })).toEqual(ENTRY);
  });

  it("invalidates on a stat MISMATCH (file replaced in place → re-hash)", () => {
    const ledger = createBackfillLedger("u1", storage);
    ledger.put("/p", ENTRY);

    expect(ledger.get("/p", { mtimeMs: 2000, size: 42 })).toBeNull();
    // Entry is gone for good, not just skipped once.
    expect(ledger.get("/p")).toBeNull();
  });

  it("keeps entries WITHOUT stored stat even when the caller has one", () => {
    const ledger = createBackfillLedger("u1", storage);
    ledger.put("/p", { docId: "d", sha256: "s" });
    expect(ledger.get("/p", { mtimeMs: 1, size: 2 })).toEqual({
      docId: "d",
      sha256: "s",
    });
  });

  it("prunes entries whose file is no longer on disk", () => {
    const ledger = createBackfillLedger("u1", storage);
    ledger.put("/alive", ENTRY);
    ledger.put("/deleted", ENTRY);

    ledger.prune(["/alive"]);
    expect(ledger.get("/alive")).toEqual(ENTRY);
    expect(ledger.get("/deleted")).toBeNull();
  });

  it("isolates ledgers per uid (account switch never skips unseen files)", () => {
    const a = createBackfillLedger("user-a", storage);
    a.put("/p", ENTRY);
    a.flush();

    const b = createBackfillLedger("user-b", storage);
    expect(b.get("/p")).toBeNull();
  });

  it("survives corrupted persisted JSON by starting fresh", () => {
    storage.data.set("syncshot.backfillLedger.v1:u1", "{not json!");
    const ledger = createBackfillLedger("u1", storage);
    expect(ledger.get("/p")).toBeNull();
    ledger.put("/p", ENTRY);
    ledger.flush();
    expect(createBackfillLedger("u1", storage).get("/p")).toEqual(ENTRY);
  });

  it("works (as a no-op) when no storage is available", () => {
    const ledger = createBackfillLedger("u1", null);
    ledger.put("/p", ENTRY);
    expect(ledger.get("/p")).toEqual(ENTRY); // in-memory for this session
    ledger.flush(); // must not throw
  });
});

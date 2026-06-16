import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceRef, ScreenshotDoc } from "./types";

const { invokeMock, deleteObject, deleteDoc, getDocs, refMock, sha256Hex } =
  vi.hoisted(() => ({
    invokeMock: vi.fn(),
    deleteObject: vi.fn((_ref: { fullPath: string }) => Promise.resolve()),
    deleteDoc: vi.fn(() => Promise.resolve()),
    getDocs: vi.fn(),
    refMock: vi.fn((_storage: unknown, path: string) => ({ fullPath: path })),
    sha256Hex: vi.fn(),
  }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  convertFileSrc: vi.fn((p: string) => p),
}));
vi.mock("./firebase", () => ({ db: {}, storage: {} }));
vi.mock("./hash", () => ({ sha256Hex }));
vi.mock("firebase/storage", () => ({
  deleteObject,
  getDownloadURL: vi.fn(),
  ref: refMock,
  uploadBytes: vi.fn(),
}));
vi.mock("firebase/firestore", () => ({
  collection: vi.fn((_db, ..._rest) => ({ __col: true })),
  deleteDoc,
  doc: vi.fn((col, id) => ({ __doc: id, col })),
  getDocs,
  limit: vi.fn(),
  onSnapshot: vi.fn(),
  orderBy: vi.fn(),
  query: vi.fn((col) => col),
  serverTimestamp: vi.fn(),
  setDoc: vi.fn(),
  updateDoc: vi.fn(),
  where: vi.fn(),
  Timestamp: class {},
}));

import {
  backfillScreenshots,
  cacheDocId,
  deleteLocalCacheById,
  deleteScreenshotByPath,
  deleteScreenshotDoc,
  reconcileLocalCache,
} from "./screenshots";

const UID = "u1";
const DEVICE: DeviceRef = {
  uid: UID,
  deviceId: "dev-mac",
  name: "Mac",
  platform: "mac",
};

function makeDoc(overrides: Partial<ScreenshotDoc> = {}): ScreenshotDoc {
  return {
    id: "d1",
    sha256: "abc",
    createdAt: 0,
    device: { uid: UID, deviceId: "dev-android", name: "Pixel", platform: "android" },
    width: 10,
    height: 10,
    bytes: 5,
    mime: "image/png",
    thumbPath: "users/u1/screenshots/d1/thumb.webp",
    fullPath: "users/u1/screenshots/d1/full.png",
    status: "full",
    ...overrides,
  };
}

beforeEach(() => {
  invokeMock.mockReset();
  deleteObject.mockClear();
  deleteDoc.mockClear();
  getDocs.mockReset();
  refMock.mockClear();
  sha256Hex.mockReset();
});

describe("cacheDocId", () => {
  it("recovers a received shot's doc id from its {id}.png cache filename", () => {
    expect(cacheDocId("/cache/Abc123XYZ.png")).toBe("Abc123XYZ");
    expect(cacheDocId("/a/b/c/doc-42.png")).toBe("doc-42");
  });

  it("handles bare names and missing extensions", () => {
    expect(cacheDocId("doc-42.png")).toBe("doc-42");
    expect(cacheDocId("noext")).toBe("noext");
    expect(cacheDocId("")).toBeNull();
  });
});

describe("deleteScreenshotByPath", () => {
  it("hashes the file, finds the doc by sha256, sweeps both blobs + the doc, then the local file", async () => {
    // Local bytes now come from Rust IPC (read_image_bytes), NOT a CORS
    // asset:// fetch — the release localhost origin can't CORS-load asset://.
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "read_image_bytes"
        ? Promise.resolve(new ArrayBuffer(4))
        : Promise.resolve(undefined),
    );
    sha256Hex.mockResolvedValue("sha-xyz");
    getDocs.mockResolvedValue({
      docs: [
        {
          id: "d1",
          data: () => ({
            thumbPath: "users/u1/screenshots/d1/thumb.webp",
            fullPath: "users/u1/screenshots/d1/full.png",
          }),
        },
      ],
    });

    await deleteScreenshotByPath(UID, "/cache/d1.png");

    // Both deterministic blob paths get deleted (deduped against doc fields).
    const deleted = deleteObject.mock.calls.map((c) => c[0].fullPath);
    expect(deleted).toContain("users/u1/screenshots/d1/thumb.webp");
    expect(deleted).toContain("users/u1/screenshots/d1/full.png");
    expect(deleteDoc).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("delete_file", { path: "/cache/d1.png" });
  });

  it("falls back to the {id}.png filename when the local file can't be hashed", async () => {
    // File gone → the read_image_bytes IPC rejects, so no sha256 to query by;
    // the doc id is recovered from the {id}.png filename instead.
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "read_image_bytes"
        ? Promise.reject(new Error("file gone"))
        : Promise.resolve(undefined),
    );

    await deleteScreenshotByPath(UID, "/cache/orphanId.png");

    // No Firestore query result, so the doc id comes from the filename.
    expect(getDocs).not.toHaveBeenCalled();
    expect(deleteDoc).toHaveBeenCalledTimes(1);
    const deleted = deleteObject.mock.calls.map((c) => c[0].fullPath);
    expect(deleted).toContain("users/u1/screenshots/orphanId/thumb.webp");
    expect(deleted).toContain("users/u1/screenshots/orphanId/full.png");
  });
});

describe("deleteScreenshotDoc", () => {
  it("deletes the doc, its blobs, and the local cache copy", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "get_desktop_directory" ? Promise.resolve("/cache") : Promise.resolve(undefined),
    );

    await deleteScreenshotDoc(UID, makeDoc());

    expect(deleteDoc).toHaveBeenCalledTimes(1);
    expect(deleteObject).toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("delete_file", { path: "/cache/d1.png" });
  });
});

describe("deleteLocalCacheById", () => {
  it("tries every known image extension (the cache file isn't always .png)", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "get_desktop_directory" ? Promise.resolve("/cache") : Promise.resolve(undefined),
    );

    await deleteLocalCacheById("d1");

    const deleted = invokeMock.mock.calls
      .filter((c) => c[0] === "delete_file")
      .map((c) => (c[1] as { path: string }).path);
    // A phone JPEG is cached as {id}.jpg, not {id}.png — both must be swept.
    expect(deleted).toContain("/cache/d1.png");
    expect(deleted).toContain("/cache/d1.jpg");
    expect(deleted).toContain("/cache/d1.webp");
    expect(deleted).toContain("/cache/d1.heic");
  });

  it("swallows a missing cache dir without throwing", async () => {
    invokeMock.mockRejectedValue(new Error("no dir"));
    await expect(deleteLocalCacheById("d1")).resolves.toBeUndefined();
  });
});

describe("reconcileLocalCache", () => {
  // 20-char Firestore-style auto ids (received-shot cache filenames).
  const KEEP_ID = "AbcdefghijklmnopqrST";
  const GONE_ID = "ZyxwvutsrqponmlkjiHG";

  function mockDir(files: string[]) {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "get_desktop_directory") return Promise.resolve("/cache");
      if (cmd === "list_screenshots") return Promise.resolve(files);
      return Promise.resolve(undefined);
    });
  }

  function deletedPaths() {
    return invokeMock.mock.calls
      .filter((c) => c[0] === "delete_file")
      .map((c) => (c[1] as { path: string }).path);
  }

  it("deletes received-shot cache files whose doc id is gone from the server set", async () => {
    mockDir([`/cache/${KEEP_ID}.png`, `/cache/${GONE_ID}.jpg`]);

    await reconcileLocalCache(new Set([KEEP_ID]));

    const deleted = deletedPaths();
    expect(deleted).toEqual([`/cache/${GONE_ID}.jpg`]);
  });

  it("clears EVERY received-shot file on an empty server set (bulk delete)", async () => {
    mockDir([`/cache/${KEEP_ID}.png`, `/cache/${GONE_ID}.webp`]);

    await reconcileLocalCache(new Set());

    expect(deletedPaths().sort()).toEqual(
      [`/cache/${GONE_ID}.webp`, `/cache/${KEEP_ID}.png`].sort(),
    );
  });

  it("never deletes own-device captures (shot_/screenshot_/region_ names have an underscore)", async () => {
    mockDir([
      `/cache/shot_1700000000.png`,
      `/cache/screenshot_1700000001.png`,
      `/cache/region_1700000002.png`,
      `/cache/${GONE_ID}.png`,
    ]);

    await reconcileLocalCache(new Set());

    // Only the received-shot file is swept; local captures are untouched.
    expect(deletedPaths()).toEqual([`/cache/${GONE_ID}.png`]);
  });

  it("swallows a missing cache dir without throwing", async () => {
    invokeMock.mockRejectedValue(new Error("no dir"));
    await expect(reconcileLocalCache(new Set())).resolves.toBeUndefined();
  });
});

describe("backfillScreenshots", () => {
  afterEach(() => {
    refMock.mockImplementation((_s: unknown, path: string) => ({ fullPath: path }));
  });

  it("publishes each path, skipping already-synced (sha256 dupe) shots", async () => {
    // publishScreenshot reads local bytes via read_image_bytes IPC (origin-
    // independent), then content-addresses by sha256 exactly as before.
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "read_image_bytes"
        ? Promise.resolve(new ArrayBuffer(4))
        : Promise.resolve(undefined),
    );
    sha256Hex.mockResolvedValue("dupe-sha");
    // Every dedup query returns a hit, so publishScreenshot short-circuits to
    // false BEFORE any thumbnail/canvas work — keeps this test jsdom-safe.
    getDocs.mockResolvedValue({ empty: false, docs: [{ id: "exists" }] });

    const published = await backfillScreenshots(UID, DEVICE, [
      "/cache/a.png",
      "/cache/b.png",
      "/cache/c.png",
    ]);

    expect(published).toBe(0);
    expect(getDocs).toHaveBeenCalledTimes(3);
  });

  it("returns 0 and does nothing for an empty library", async () => {
    const published = await backfillScreenshots(UID, DEVICE, []);
    expect(published).toBe(0);
    expect(getDocs).not.toHaveBeenCalled();
  });
});

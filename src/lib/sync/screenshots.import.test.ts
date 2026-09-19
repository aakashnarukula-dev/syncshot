import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceRef } from "./types";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getDocs: vi.fn(),
  setDoc: vi.fn(),
  updateDoc: vi.fn(),
  uploadBytes: vi.fn(),
  cacheThumbBlob: vi.fn(),
  sha256Hex: vi.fn(),
  makeThumb: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("./firebase", () => ({ db: {}, storage: {} }));
vi.mock("./hash", () => ({ sha256Hex: mocks.sha256Hex }));
vi.mock("./thumbs", () => ({ makeThumb: mocks.makeThumb }));
vi.mock("@/lib/thumbCache", () => ({ cacheThumbBlob: mocks.cacheThumbBlob }));
vi.mock("firebase/storage", () => ({
  deleteObject: vi.fn(),
  getDownloadURL: vi.fn(),
  ref: vi.fn((_storage, path: string) => ({ fullPath: path })),
  uploadBytes: mocks.uploadBytes,
}));
vi.mock("firebase/firestore", () => ({
  collection: vi.fn(),
  deleteDoc: vi.fn(),
  doc: vi.fn((_col, id?: string) => ({ id: id ?? "new-doc", fullPath: id ?? "new-doc" })),
  getDocs: mocks.getDocs,
  limit: vi.fn(),
  onSnapshot: vi.fn(),
  orderBy: vi.fn(),
  query: vi.fn(),
  serverTimestamp: vi.fn(() => "server-time"),
  setDoc: mocks.setDoc,
  updateDoc: mocks.updateDoc,
  where: vi.fn(),
  Timestamp: class {},
}));

import { registerRenameCapturePath, useSyncStore } from "@/stores/syncStore";
import { publishImportedImage } from "./screenshots";

const DEVICE: DeviceRef = {
  uid: "u1",
  deviceId: "mac-1",
  name: "Mac",
  platform: "mac",
};

describe("publishImportedImage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDocs.mockResolvedValue({ empty: true, docs: [] });
    mocks.sha256Hex.mockResolvedValue("sha-import");
    mocks.makeThumb.mockResolvedValue({
      width: 1200,
      height: 800,
      thumb: new Blob(["thumb"], { type: "image/webp" }),
    });
    mocks.uploadBytes.mockResolvedValue(undefined);
    mocks.setDoc.mockResolvedValue(undefined);
    mocks.updateDoc.mockResolvedValue(undefined);
  });

  afterEach(() => {
    registerRenameCapturePath(null);
    useSyncStore.getState().reset();
  });

  it("uploads from memory with the real type and reveals it only after full upload", async () => {
    const swaps: Array<[string, string]> = [];
    registerRenameCapturePath((from, to) => swaps.push([from, to]));
    const staging = "syncshot-import://one";
    const file = new File(["jpeg-bytes"], "photo.jpg", { type: "image/jpeg" });

    const result = await publishImportedImage("u1", DEVICE, staging, file);

    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.uploadBytes).toHaveBeenNthCalledWith(
      1,
      { fullPath: "users/u1/screenshots/new-doc/thumb.webp" },
      expect.any(Blob),
      { contentType: "image/webp" },
    );
    expect(mocks.uploadBytes).toHaveBeenNthCalledWith(
      2,
      { fullPath: "users/u1/screenshots/new-doc/full.jpg" },
      file,
      { contentType: "image/jpeg" },
    );
    expect(mocks.setDoc).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mime: "image/jpeg", status: "thumb", fullPath: null }),
    );
    expect(mocks.updateDoc).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "full", fullPath: "users/u1/screenshots/new-doc/full.jpg" }),
    );
    expect(swaps).toEqual([[staging, "syncshot-cloud://new-doc?v=sha-import"]]);
    expect(result.cloudPath).toBe("syncshot-cloud://new-doc?v=sha-import");
  });

  it("rejects unsupported files before writing Firebase", async () => {
    const file = new File(["svg"], "shape.svg", { type: "image/svg+xml" });
    await expect(publishImportedImage("u1", DEVICE, "syncshot-import://two", file))
      .rejects.toThrow("Choose a PNG, JPEG, GIF, or WebP image");
    expect(mocks.uploadBytes).not.toHaveBeenCalled();
  });
});

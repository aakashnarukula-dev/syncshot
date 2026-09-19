import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScreenshotDoc } from "./types";

const { invokeMock, getDownloadURL, refMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  getDownloadURL: vi.fn(),
  refMock: vi.fn((_storage: unknown, path: string) => ({ fullPath: path })),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  convertFileSrc: vi.fn((p: string) => p),
}));

// Module-load-time imports — stubbed so importing screenshots.ts is side-effect free.
vi.mock("./firebase", () => ({ db: {}, storage: {} }));
vi.mock("./hash", () => ({ sha256Hex: vi.fn() }));
vi.mock("firebase/storage", () => ({
  getDownloadURL,
  ref: refMock,
  uploadBytes: vi.fn(),
}));
vi.mock("firebase/firestore", () => ({
  collection: vi.fn(),
  doc: vi.fn(),
  getDocs: vi.fn(),
  limit: vi.fn(),
  onSnapshot: vi.fn(),
  orderBy: vi.fn(),
  query: vi.fn(),
  serverTimestamp: vi.fn(),
  setDoc: vi.fn(),
  updateDoc: vi.fn(),
  where: vi.fn(),
  Timestamp: class {},
}));

import {
  downloadScreenshotToDownloads,
  resolveScreenshotFullImageUrl,
  resolveScreenshotThumbnailUrl,
  saveReceivedScreenshot,
} from "./screenshots";

function makeDoc(overrides: Partial<ScreenshotDoc> = {}): ScreenshotDoc {
  return {
    id: "doc123",
    sha256: "abc",
    createdAt: 0,
    device: { uid: "u1", deviceId: "dev-a", name: "Android", platform: "android" },
    width: 100,
    height: 100,
    bytes: 10,
    mime: "image/png",
    thumbPath: "users/u1/screenshots/doc123/thumb.webp",
    fullPath: "users/u1/screenshots/doc123/full.png",
    status: "full",
    ...overrides,
  };
}

describe("saveReceivedScreenshot", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    getDownloadURL.mockReset();
    refMock.mockClear();
  });

  it("resolves a download URL and fetches the bytes via the Rust HTTP command (no getBytes/CORS)", async () => {
    getDownloadURL.mockResolvedValue("https://firebasestorage.googleapis.com/full.png?token=t");
    invokeMock.mockResolvedValue("/tmp/syncshot-cloud-doc123.png");

    const saved = await saveReceivedScreenshot(makeDoc());

    expect(refMock).toHaveBeenCalledWith({}, "users/u1/screenshots/doc123/full.png");
    expect(getDownloadURL).toHaveBeenCalledWith({
      fullPath: "users/u1/screenshots/doc123/full.png",
    });
    expect(invokeMock).toHaveBeenCalledWith("download_temporary_image", {
      url: "https://firebasestorage.googleapis.com/full.png?token=t",
      name: "doc123.png",
    });
    expect(saved).toBe("/tmp/syncshot-cloud-doc123.png");
  });

  it("saves a phone JPEG under a .jpg name (real mime), not a hardcoded .png", async () => {
    getDownloadURL.mockResolvedValue("https://firebasestorage.googleapis.com/full.jpg?token=t");
    invokeMock.mockResolvedValue("/cache/doc123.jpg");

    await saveReceivedScreenshot(
      makeDoc({ mime: "image/jpeg", fullPath: "users/u1/screenshots/doc123/full.jpg" }),
    );

    expect(invokeMock).toHaveBeenCalledWith("download_temporary_image", {
      url: "https://firebasestorage.googleapis.com/full.jpg?token=t",
      name: "doc123.jpg",
    });
  });

  it("derives the extension from the Storage object when mime is missing/unknown", async () => {
    getDownloadURL.mockResolvedValue("https://firebasestorage.googleapis.com/full.webp?token=t");
    invokeMock.mockResolvedValue("/cache/doc123.webp");

    await saveReceivedScreenshot(
      makeDoc({ mime: "", fullPath: "users/u1/screenshots/doc123/full.webp" }),
    );

    expect(invokeMock).toHaveBeenCalledWith("download_temporary_image", {
      url: "https://firebasestorage.googleapis.com/full.webp?token=t",
      name: "doc123.webp",
    });
  });

  it("throws before any network call when the full image is not uploaded yet", async () => {
    await expect(
      saveReceivedScreenshot(makeDoc({ fullPath: null, status: "thumb" })),
    ).rejects.toThrow("no full image");
    expect(getDownloadURL).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("downloadScreenshotToDownloads", () => {
  it("saves a local full-resolution image through the native Downloads command", async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue("/Users/test/Downloads/shot.png");

    await expect(downloadScreenshotToDownloads("/tmp/shot.png")).resolves.toBe(
      "/Users/test/Downloads/shot.png",
    );
    expect(invokeMock).toHaveBeenCalledWith("save_image_to_downloads", {
      path: "/tmp/shot.png",
      url: null,
      name: "shot.png",
    });
  });
});

describe("editor/preload URL identity", () => {
  it("versions direct Firestore URLs so editor hits preloaded Rust RAM bytes", async () => {
    const item = makeDoc({
      sha256: "sha-edited",
      thumbUrl: "https://firebasestorage.googleapis.com/thumb.webp?token=t",
      fullUrl: "https://firebasestorage.googleapis.com/full.png?token=t",
    });

    await expect(resolveScreenshotThumbnailUrl(item)).resolves.toBe(
      "https://firebasestorage.googleapis.com/thumb.webp?token=t&syncshotVersion=sha-edited",
    );
    await expect(resolveScreenshotFullImageUrl(item)).resolves.toBe(
      "https://firebasestorage.googleapis.com/full.png?token=t&syncshotVersion=sha-edited",
    );
    expect(getDownloadURL).not.toHaveBeenCalled();
  });

  it("does not append duplicate content versions", async () => {
    const item = makeDoc({
      sha256: "sha-edited",
      fullUrl:
        "https://firebasestorage.googleapis.com/full.png?token=t&syncshotVersion=sha-edited",
    });

    await expect(resolveScreenshotFullImageUrl(item)).resolves.toBe(item.fullUrl);
  });
});

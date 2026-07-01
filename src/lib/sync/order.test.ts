import { afterEach, describe, expect, it } from "vitest";
import { useSyncStore } from "@/stores/syncStore";
import type { ScreenshotDoc } from "./types";
import {
  cacheDocId,
  isRecentScreenshot,
  isSyncedCacheFile,
  orderScreenshotsByCreatedAt,
  screenshotCreatedAt,
} from "./order";

function makeDoc(id: string, createdAt: number | null): ScreenshotDoc {
  return {
    id,
    sha256: "",
    createdAt,
    device: { uid: "", deviceId: "", name: "", platform: "mac" },
    width: 0,
    height: 0,
    bytes: 0,
    mime: "image/png",
    thumbPath: "",
    fullPath: null,
    status: "full",
  };
}

function setStore(
  screenshots: ScreenshotDoc[],
  localCaptureDocIds: Record<string, string> = {},
) {
  useSyncStore.setState({ screenshots, localCaptureDocIds });
}

afterEach(() => {
  setStore([], {});
});

describe("screenshotCreatedAt", () => {
  it("prefers a received {docId} file's doc createdAt", () => {
    setStore([makeDoc("Abc123XYZ0000000abcd", 5000)]);
    expect(screenshotCreatedAt("/cache/Abc123XYZ0000000abcd.png")).toBe(5000);
  });

  it("parses the capture epoch from an own shot_{ts} filename", () => {
    setStore([]);
    expect(screenshotCreatedAt("/cache/shot_1700000000000.png")).toBe(
      1700000000000,
    );
  });

  it("prefers the doc createdAt over the filename epoch for a mapped own capture", () => {
    setStore([makeDoc("docMapped00000000000", 9999)], {
      "/cache/shot_1700000000000.png": "docMapped00000000000",
    });
    expect(screenshotCreatedAt("/cache/shot_1700000000000.png")).toBe(9999);
  });

  it("returns null for a legacy/unsynced name with no doc", () => {
    setStore([]);
    expect(screenshotCreatedAt("/cache/screenshot_42.png")).toBeNull();
  });
});

describe("orderScreenshotsByCreatedAt", () => {
  it("puts the newest Mac capture on top even when a phone shot was re-downloaded (newer mtime)", () => {
    // Phone doc captured earlier (createdAt 1000) but its local file was just
    // re-downloaded, so it arrives FIRST in the mtime-desc disk list. The Mac
    // shot was captured later (epoch 2000) but its file is older on disk.
    setStore([makeDoc("PhoneDocId0000000001", 1000)]);
    const disk = ["/cache/PhoneDocId0000000001.png", "/cache/shot_2000.png"];
    expect(orderScreenshotsByCreatedAt(disk)).toEqual([
      "/cache/shot_2000.png",
      "/cache/PhoneDocId0000000001.png",
    ]);
  });

  it("is stable regardless of incoming order (createdAt decides)", () => {
    setStore([
      makeDoc("DocA00000000000000001", 3000),
      makeDoc("DocB00000000000000002", 1000),
      makeDoc("DocC00000000000000003", 2000),
    ]);
    const a = "/cache/DocA00000000000000001.png";
    const b = "/cache/DocB00000000000000002.png";
    const c = "/cache/DocC00000000000000003.png";
    const expected = [a, c, b]; // 3000, 2000, 1000
    expect(orderScreenshotsByCreatedAt([b, a, c])).toEqual(expected);
    expect(orderScreenshotsByCreatedAt([c, b, a])).toEqual(expected);
  });

  it("sorts own shot_{ts} captures newest-first by their epoch", () => {
    setStore([]);
    const disk = [
      "/cache/shot_100.png",
      "/cache/shot_300.png",
      "/cache/shot_200.png",
    ];
    expect(orderScreenshotsByCreatedAt(disk)).toEqual([
      "/cache/shot_300.png",
      "/cache/shot_200.png",
      "/cache/shot_100.png",
    ]);
  });

  it("keeps resolved shots above mtime-only legacy files, preserving mtime order for the tail", () => {
    setStore([makeDoc("DocOld00000000000001", 50)]);
    // disk is mtime-desc: two legacy files (newest mtime) then the resolved doc.
    const disk = [
      "/cache/legacy_b.png",
      "/cache/legacy_a.png",
      "/cache/DocOld00000000000001.png",
    ];
    expect(orderScreenshotsByCreatedAt(disk)).toEqual([
      "/cache/DocOld00000000000001.png", // resolved (createdAt 50) wins
      "/cache/legacy_b.png", // mtime-only tail keeps incoming order
      "/cache/legacy_a.png",
    ]);
  });
});

describe("isSyncedCacheFile", () => {
  it("matches a {docId}.<ext> cache file (20 alnum chars)", () => {
    expect(isSyncedCacheFile("/cache/Abc123XYZ0000000abcd.png")).toBe(true);
    expect(isSyncedCacheFile("/cache/Abc123XYZ0000000abcd.jpg")).toBe(true);
  });

  it("never matches unpublished local captures (underscore names)", () => {
    expect(isSyncedCacheFile("/cache/shot_1700000000000.png")).toBe(false);
    expect(isSyncedCacheFile("/cache/screenshot_42.png")).toBe(false);
    expect(isSyncedCacheFile("/cache/syncshot_1.png")).toBe(false);
    expect(isSyncedCacheFile("/cache/region_9.png")).toBe(false);
    expect(isSyncedCacheFile("/cache/synced_1.png")).toBe(false);
  });

  it("rejects wrong-length ids", () => {
    expect(isSyncedCacheFile("/cache/short.png")).toBe(false);
    expect(isSyncedCacheFile("/cache/waytoolongid000000000000000.png")).toBe(false);
  });
});

describe("isRecentScreenshot", () => {
  const NOW = 1_700_000_100_000;
  const MAX = 120_000;

  it("true when the doc createdAt is within the window", () => {
    setStore([makeDoc("FreshDoc000000000001", NOW - 10_000)]);
    expect(isRecentScreenshot("/cache/FreshDoc000000000001.png", NOW, MAX)).toBe(true);
  });

  it("false when the doc createdAt is older than the window (backlog page-in)", () => {
    setStore([makeDoc("OldDoc00000000000001", NOW - 3_600_000)]);
    expect(isRecentScreenshot("/cache/OldDoc00000000000001.png", NOW, MAX)).toBe(false);
  });

  it("uses the shot_{ts} filename epoch for own captures", () => {
    setStore([]);
    expect(isRecentScreenshot(`/cache/shot_${NOW - 5_000}.png`, NOW, MAX)).toBe(true);
    expect(isRecentScreenshot(`/cache/shot_${NOW - 300_000}.png`, NOW, MAX)).toBe(false);
  });

  it("treats an unresolvable file as recent (own edits/saves must keep today's behavior)", () => {
    setStore([]);
    expect(isRecentScreenshot("/cache/syncshot_99.png", NOW, MAX)).toBe(true);
  });
});

describe("cacheDocId (re-exported through order)", () => {
  it("strips the extension to recover the doc id", () => {
    expect(cacheDocId("/cache/Abc123XYZ.png")).toBe("Abc123XYZ");
    expect(cacheDocId("noext")).toBe("noext");
    expect(cacheDocId("")).toBeNull();
  });
});

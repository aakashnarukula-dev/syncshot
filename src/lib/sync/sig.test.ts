import { describe, expect, it } from "vitest";
import type { ClipboardDoc, ScreenshotDoc } from "./types";
import { clipboardSignature, screenshotsSignature } from "./types";

function makeDoc(overrides: Partial<ScreenshotDoc> = {}): ScreenshotDoc {
  return {
    id: "Doc00000000000000001",
    sha256: "abc",
    createdAt: 1000,
    device: { uid: "u", deviceId: "d", name: "Mac", platform: "mac" },
    width: 10,
    height: 10,
    bytes: 100,
    mime: "image/png",
    thumbPath: "t",
    fullPath: "f",
    status: "full",
    ...overrides,
  };
}

describe("screenshotsSignature", () => {
  it("is stable for identical doc sets (echo snapshots can be skipped)", () => {
    const a = [makeDoc(), makeDoc({ id: "Doc00000000000000002" })];
    const b = [makeDoc(), makeDoc({ id: "Doc00000000000000002" })];
    expect(screenshotsSignature(a, true)).toBe(screenshotsSignature(b, true));
  });

  it("changes when status flips thumb -> full", () => {
    const a = [makeDoc({ status: "thumb", fullPath: null })];
    const b = [makeDoc({ status: "full" })];
    expect(screenshotsSignature(a, false)).not.toBe(screenshotsSignature(b, false));
  });

  it("changes when createdAt resolves from null to a server timestamp", () => {
    const a = [makeDoc({ createdAt: null })];
    const b = [makeDoc({ createdAt: 123 })];
    expect(screenshotsSignature(a, false)).not.toBe(screenshotsSignature(b, false));
  });

  it("changes with hasMore, order, and membership", () => {
    const one = [makeDoc()];
    const two = [makeDoc(), makeDoc({ id: "Doc00000000000000002" })];
    expect(screenshotsSignature(one, true)).not.toBe(screenshotsSignature(one, false));
    expect(screenshotsSignature(one, true)).not.toBe(screenshotsSignature(two, true));
    expect(screenshotsSignature(two, true)).not.toBe(
      screenshotsSignature([...two].reverse(), true),
    );
  });
});

function makeClip(overrides: Partial<ClipboardDoc> = {}): ClipboardDoc {
  return {
    id: "Clip0000000000000001",
    text: "hello",
    hash: "h1",
    createdAt: 1000,
    device: { uid: "u", deviceId: "d", name: "Mac", platform: "mac" },
    pinned: false,
    charCount: 5,
    ...overrides,
  };
}

describe("clipboardSignature", () => {
  it("is stable for identical doc sets (echo snapshots can be skipped)", () => {
    const a = [makeClip(), makeClip({ id: "Clip0000000000000002" })];
    const b = [makeClip(), makeClip({ id: "Clip0000000000000002" })];
    expect(clipboardSignature(a)).toBe(clipboardSignature(b));
  });

  it("changes when the pinned flag toggles", () => {
    expect(clipboardSignature([makeClip({ pinned: false })])).not.toBe(
      clipboardSignature([makeClip({ pinned: true })]),
    );
  });

  it("changes when createdAt resolves from null to a server timestamp", () => {
    expect(clipboardSignature([makeClip({ createdAt: null })])).not.toBe(
      clipboardSignature([makeClip({ createdAt: 123 })]),
    );
  });

  it("changes with order and membership", () => {
    const one = [makeClip()];
    const two = [makeClip(), makeClip({ id: "Clip0000000000000002" })];
    expect(clipboardSignature(one)).not.toBe(clipboardSignature(two));
    expect(clipboardSignature(two)).not.toBe(clipboardSignature([...two].reverse()));
    expect(clipboardSignature([])).not.toBe(clipboardSignature(one));
  });
});

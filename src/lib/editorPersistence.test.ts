import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { createEditorPersistence } from "./editorPersistence";

vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn().mockResolvedValue(undefined) }));

const canvas = {
  toBlob: (callback: BlobCallback) => callback({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as Blob),
} as HTMLCanvasElement;

beforeEach(() => vi.clearAllMocks());

describe("editor save pipeline", () => {
  it("replaces consecutive crops while clipboard is blocked, and copies in order", async () => {
    let finishFirstCopy!: () => void;
    let saves = 0;
    let copies = 0;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "get_temp_directory") return "/tmp/screenshots";
      if (command === "save_edited_image_bytes") return `/tmp/crop-${++saves}.png`;
      if (command === "copy_png_bytes_to_clipboard" && ++copies === 1) {
        await new Promise<void>((resolve) => { finishFirstCopy = resolve; });
      }
    });
    const persist = createEditorPersistence();
    const session = { path: "/tmp/original.png" };
    const first = persist(session, canvas, "preview-1");
    const second = persist(session, canvas, "preview-2");
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(2));
    expect(emit).toHaveBeenNthCalledWith(1, "editor-saved", {
      originalPath: "/tmp/original.png", newPath: "/tmp/crop-1.png", previewDataUrl: "preview-1",
    });
    expect(emit).toHaveBeenNthCalledWith(2, "editor-saved", {
      originalPath: "/tmp/crop-1.png", newPath: "/tmp/crop-2.png", previewDataUrl: "preview-2",
    });
    expect(copies).toBe(1);
    finishFirstCopy();
    await expect(first).resolves.toBe("/tmp/crop-1.png");
    await expect(second).resolves.toBe("/tmp/crop-2.png");
    expect(copies).toBe(2);
    expect(invoke).toHaveBeenCalledWith("copy_png_bytes_to_clipboard", new Uint8Array([1, 2, 3]));
  });

  it("keeps a newly opened image separate from an older queued save", async () => {
    let saves = 0;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "get_temp_directory") return "/tmp";
      if (command === "save_edited_image_bytes") return `/tmp/result-${++saves}.png`;
    });
    const persist = createEditorPersistence();
    await Promise.all([
      persist({ path: "first-image" }, canvas, "first"),
      persist({ path: "second-image" }, canvas, "second"),
    ]);
    expect(emit).toHaveBeenNthCalledWith(2, "editor-saved", {
      originalPath: "second-image", newPath: "/tmp/result-2.png", previewDataUrl: "second",
    });
  });

  it("leaves original identity intact when disk write fails, then permits retry", async () => {
    let fail = true;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "get_temp_directory") return "/tmp";
      if (command === "save_edited_image_bytes") {
        if (fail) throw new Error("disk full");
        return "/tmp/retry.png";
      }
    });
    const persist = createEditorPersistence();
    const session = { path: "original" };
    await expect(persist(session, canvas, "crop")).rejects.toThrow("disk full");
    expect(session.path).toBe("original");
    expect(emit).not.toHaveBeenCalled();
    fail = false;
    await expect(persist(session, canvas, "crop")).resolves.toBe("/tmp/retry.png");
  });
});

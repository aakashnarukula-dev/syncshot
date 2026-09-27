import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePreviewGenerator } from "./usePreviewGenerator";
import { useEditorStore } from "@/stores/editorStore";
import type { EditorBitmap } from "@/lib/canvas-utils";

afterEach(() => vi.restoreAllMocks());

describe("decoded editor previews", () => {
  it("shows a crop and undo immediately without encoding, decoding, or debounce", () => {
    const encode = vi.spyOn(HTMLCanvasElement.prototype, "toBlob");
    const encodeData = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL");
    const original = new Image(4000, 3000);
    const crop = document.createElement("canvas");
    crop.width = 800;
    crop.height = 600;
    const canvasRef = { current: document.createElement("canvas") };
    const settings = { ...useEditorStore.getState().settings, padding: 0, borderRadius: 0 };
    const { result, rerender } = renderHook(({ source }: { source: EditorBitmap | null }) =>
      usePreviewGenerator({ screenshotImage: source, settings, canvasRef, padding: 0 }),
      { initialProps: { source: original as EditorBitmap | null } },
    );
    expect(result.current.previewImage).toBe(original);
    act(() => rerender({ source: crop }));
    expect(result.current.previewImage).toBe(crop);
    expect(result.current.isGenerating).toBe(false);
    act(() => rerender({ source: original }));
    expect(result.current.previewImage).toBe(original);
    act(() => rerender({ source: null }));
    expect(result.current.previewImage).toBeNull();
    expect(encode).not.toHaveBeenCalled();
    expect(encodeData).not.toHaveBeenCalled();
  });
});

import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/thumbCache", () => ({
  ensureDragIconPath: vi.fn().mockResolvedValue(null),
  getCachedThumbUrl: vi.fn(() => "data:image/png;base64,iVBORw0KGgo="),
  requestThumbUrl: vi.fn(() => ({
    promise: Promise.resolve(null),
    release: vi.fn(),
  })),
}));

vi.mock("@crabnebula/tauri-plugin-drag", () => ({
  startDrag: vi.fn().mockResolvedValue(undefined),
}));

const { downloadScreenshotToDownloads } = vi.hoisted(() => ({
  downloadScreenshotToDownloads: vi.fn().mockResolvedValue("/Users/test/Downloads/shot.png"),
}));
vi.mock("@/lib/sync/screenshots", () => ({ downloadScreenshotToDownloads }));

import { ScreenshotThumbnail, ThumbnailItem } from "./ScreenshotThumbnail";

const columnProps = {
  paths: [] as string[],
  isCollapsed: false,
  columnView: "screenshots" as const,
  onColumnViewChange: vi.fn(),
  onAddImage: vi.fn(),
  onEdit: vi.fn(),
  onRemove: vi.fn(),
  onToggleCollapsed: vi.fn(),
};

describe("ScreenshotThumbnail add image", () => {
  it("passes the selected image to the uploader and permits reselecting it", () => {
    const onAddImage = vi.fn();
    const view = render(<ScreenshotThumbnail {...columnProps} onAddImage={onAddImage} />);
    const input = view.getByLabelText("Choose image") as HTMLInputElement;
    const file = new File(["png"], "manual.png", { type: "image/png" });

    expect(view.getByRole("button", { name: "Add image" })).toBeTruthy();
    fireEvent.change(input, { target: { files: [file] } });

    expect(onAddImage).toHaveBeenCalledWith(file);
    expect(input.value).toBe("");
  });

  it("runs the normal collapse path when auto-hide signal changes", () => {
    vi.useFakeTimers();
    const onToggleCollapsed = vi.fn();
    const view = render(
      <ScreenshotThumbnail
        {...columnProps}
        autoCollapseSignal={0}
        onToggleCollapsed={onToggleCollapsed}
      />,
    );

    view.rerender(
      <ScreenshotThumbnail
        {...columnProps}
        autoCollapseSignal={1}
        onToggleCollapsed={onToggleCollapsed}
      />,
    );
    act(() => vi.advanceTimersByTime(380));

    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("reports hover and scroll activity to idle-timer owner", () => {
    const onHoverChange = vi.fn();
    const onActivity = vi.fn();
    const view = render(
      <ScreenshotThumbnail
        {...columnProps}
        paths={["/managed/shot.png"]}
        isReadOnly={() => false}
        onHoverChange={onHoverChange}
        onActivity={onActivity}
      />,
    );
    const rail = view.getByRole("button", { name: "Hide screenshots" }).parentElement?.parentElement;
    const scroller = view.container.querySelector(".overflow-y-auto");

    expect(rail).toBeTruthy();
    expect(scroller).toBeTruthy();
    fireEvent.mouseEnter(rail!);
    fireEvent.scroll(scroller!);
    fireEvent.mouseLeave(rail!);

    expect(onHoverChange).toHaveBeenNthCalledWith(1, true);
    expect(onActivity).toHaveBeenCalledTimes(1);
    expect(onHoverChange).toHaveBeenLastCalledWith(false);
  });
});

describe("ThumbnailItem", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("still deletes after the screenshot was opened", () => {
    vi.useFakeTimers();
    const onEdit = vi.fn();
    const onRemove = vi.fn();
    const view = render(
      <ThumbnailItem
        path="/managed/original.png"
        onEdit={onEdit}
        onRemove={onRemove}
        readOnly={false}
      />,
    );

    fireEvent.click(view.getByAltText("Screenshot preview"));
    expect(onEdit).toHaveBeenCalledWith("/managed/original.png");

    fireEvent.click(view.getByRole("button", { name: "Delete" }));
    act(() => vi.advanceTimersByTime(220));

    expect(onRemove).toHaveBeenCalledWith("/managed/original.png");
  });

  it("places four actions in their requested corners and downloads the image", async () => {
    const view = render(
      <ThumbnailItem
        path="/managed/original.png"
        onEdit={vi.fn()}
        onRemove={vi.fn()}
        readOnly={false}
      />,
    );

    expect(view.getByRole("button", { name: "Delete" }).className).toContain("top-1.5 left-1.5");
    expect(view.getByRole("button", { name: "Copy image" }).className).toContain("top-1.5 right-1.5");
    expect(view.getByRole("button", { name: "Copy share link" }).className).toContain("bottom-1.5 left-1.5");
    const download = view.getByRole("button", { name: "Download image" });
    expect(download.className).toContain("bottom-1.5 right-1.5");

    fireEvent.click(download);
    await waitFor(() => {
      expect(downloadScreenshotToDownloads).toHaveBeenCalledWith("/managed/original.png");
    });
  });
});

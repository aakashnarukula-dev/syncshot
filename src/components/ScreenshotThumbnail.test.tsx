import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { startDragMock, prepareDragMock, releaseDragMock, ensureDragIconMock } = vi.hoisted(() => ({
  startDragMock: vi.fn().mockResolvedValue(undefined),
  prepareDragMock: vi.fn((path: string) => Promise.resolve({ path, temporary: false })),
  releaseDragMock: vi.fn().mockResolvedValue(undefined),
  ensureDragIconMock: vi.fn().mockResolvedValue("/cache/icon.png"),
}));

vi.mock("@/lib/thumbCache", () => ({
  ensureDragIconPath: ensureDragIconMock,
  getCachedThumbUrl: vi.fn(() => "data:image/png;base64,iVBORw0KGgo="),
  requestThumbUrl: vi.fn(() => ({
    promise: Promise.resolve(null),
    release: vi.fn(),
  })),
}));

vi.mock("@crabnebula/tauri-plugin-drag", () => ({
  startDrag: startDragMock,
}));

const { downloadScreenshotToDownloads } = vi.hoisted(() => ({
  downloadScreenshotToDownloads: vi.fn().mockResolvedValue("/Users/test/Downloads/shot.png"),
}));
vi.mock("@/lib/sync/screenshots", () => ({
  downloadScreenshotToDownloads,
  prepareScreenshotDragSource: prepareDragMock,
  releaseScreenshotDragSource: releaseDragMock,
}));

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

  it("cancels an old collapse when a new screenshot is revealed", () => {
    vi.useFakeTimers();
    try {
      const onToggleCollapsed = vi.fn();
      const view = render(<ScreenshotThumbnail {...columnProps} openSignal={0} autoCollapseSignal={0} onToggleCollapsed={onToggleCollapsed} />);
      view.rerender(<ScreenshotThumbnail {...columnProps} openSignal={0} autoCollapseSignal={1} onToggleCollapsed={onToggleCollapsed} />);
      view.rerender(<ScreenshotThumbnail {...columnProps} openSignal={1} autoCollapseSignal={1} onToggleCollapsed={onToggleCollapsed} />);
      act(() => vi.advanceTimersByTime(400));
      expect(onToggleCollapsed).not.toHaveBeenCalled();
      view.rerender(<ScreenshotThumbnail {...columnProps} openSignal={1} autoCollapseSignal={2} onToggleCollapsed={onToggleCollapsed} />);
      act(() => vi.advanceTimersByTime(400));
      expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("Escape collapses an empty rail", () => {
    vi.useFakeTimers();
    try {
      const onToggleCollapsed = vi.fn();
      render(<ScreenshotThumbnail {...columnProps} onToggleCollapsed={onToggleCollapsed} />);
      fireEvent.keyDown(window, { key: "Escape" });
      act(() => vi.advanceTimersByTime(400));
      expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
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
    vi.restoreAllMocks();
    startDragMock.mockClear();
    prepareDragMock.mockClear();
    releaseDragMock.mockClear();
  });

  it("starts drag on the first pointer gesture while unfocused, without a browser dragstart", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const source = { path: "/tmp/syncshot-cloud-one.png", temporary: true };
    prepareDragMock.mockResolvedValueOnce(source);
    const onDragStateChange = vi.fn();
    const onEdit = vi.fn();
    const view = render(
      <ThumbnailItem path="syncshot-cloud://one" onEdit={onEdit} onRemove={vi.fn()} readOnly={false} onDragStateChange={onDragStateChange} />,
    );
    const image = view.getByAltText("Screenshot preview");
    expect(image).toHaveAttribute("draggable", "false");

    fireEvent.pointerDown(image, { button: 0, pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(image, { pointerId: 1, buttons: 1, clientX: 40, clientY: 20 });
    fireEvent.pointerMove(image, { pointerId: 1, buttons: 1, clientX: 40, clientY: 20 });
    await waitFor(() => expect(startDragMock).toHaveBeenCalledTimes(1));
    expect(startDragMock).toHaveBeenCalledWith(
      { item: [source.path], icon: "/cache/icon.png" }, expect.any(Function),
    );
    expect(releaseDragMock).not.toHaveBeenCalled();
    startDragMock.mock.calls[0][1]({ result: "Cancelled", cursorPos: { x: 1, y: 1 } });
    await waitFor(() => expect(releaseDragMock).toHaveBeenCalledWith(source));
    expect(onDragStateChange.mock.calls).toEqual([[true], [false]]);
    fireEvent.click(image);
    expect(onEdit).not.toHaveBeenCalled();
    view.unmount();
  });

  it("warms image on unfocused hover without requiring a click", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    vi.useFakeTimers();
    const view = render(
      <ThumbnailItem path="/managed/hover.png" onEdit={vi.fn()} onRemove={vi.fn()} readOnly={false} />,
    );
    fireEvent.mouseEnter(view.getByAltText("Screenshot preview"));
    await act(async () => { vi.advanceTimersByTime(150); });
    expect(prepareDragMock).toHaveBeenCalledWith("/managed/hover.png");
    expect(startDragMock).not.toHaveBeenCalled();
    view.unmount();
    await act(async () => {});
  });

  it("keeps a click with small pointer jitter working on first attempt", async () => {
    const onEdit = vi.fn();
    const view = render(
      <ThumbnailItem path="/managed/click.png" onEdit={onEdit} onRemove={vi.fn()} readOnly={false} />,
    );
    const image = view.getByAltText("Screenshot preview");
    fireEvent.pointerDown(image, { button: 0, pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(image, { pointerId: 1, buttons: 1, clientX: 22, clientY: 21 });
    fireEvent.pointerUp(image, { pointerId: 1 });
    fireEvent.click(image);
    expect(startDragMock).not.toHaveBeenCalled();
    expect(onEdit).toHaveBeenCalledWith("/managed/click.png");
    view.unmount();
    await act(async () => {});
  });

  it("does not start a late drag after mouse release", async () => {
    let resolvePreparation!: (source: { path: string; temporary: boolean }) => void;
    prepareDragMock.mockReturnValueOnce(new Promise((resolve) => { resolvePreparation = resolve; }));
    const view = render(
      <ThumbnailItem path="/managed/slow.png" onEdit={vi.fn()} onRemove={vi.fn()} readOnly={false} />,
    );
    const image = view.getByAltText("Screenshot preview");

    fireEvent.pointerDown(image, { button: 0, pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(image, { pointerId: 1, buttons: 1, clientX: 40, clientY: 20 });
    fireEvent.pointerUp(window);
    resolvePreparation({ path: "/managed/slow.png", temporary: false });
    await waitFor(() => expect(releaseDragMock).toHaveBeenCalled());
    expect(startDragMock).not.toHaveBeenCalled();
    view.unmount();
  });

  it("keeps a dropped file until the receiving app can read it", async () => {
    const source = { path: "/tmp/syncshot-cloud-two.png", temporary: true };
    prepareDragMock.mockResolvedValueOnce(source);
    const view = render(
      <ThumbnailItem path="syncshot-cloud://two" onEdit={vi.fn()} onRemove={vi.fn()} readOnly={false} />,
    );
    const image = view.getByAltText("Screenshot preview");
    fireEvent.pointerDown(image, { button: 0, pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(image, { pointerId: 1, buttons: 1, clientX: 40, clientY: 20 });
    await waitFor(() => expect(startDragMock).toHaveBeenCalledTimes(1));

    vi.useFakeTimers();
    startDragMock.mock.calls[0][1]({ result: "Dropped", cursorPos: { x: 1, y: 1 } });
    expect(releaseDragMock).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(119_999); });
    expect(releaseDragMock).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(releaseDragMock).toHaveBeenCalledWith(source);
    view.unmount();
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

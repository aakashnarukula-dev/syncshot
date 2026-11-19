import { act, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorViewport } from "./useEditorViewport";

const image = Object.assign(document.createElement("canvas"), { width: 2000, height: 1000 });
let container: HTMLDivElement;

function setup() {
  const ref = { current: container };
  return renderHook(({ source = image, hand = false }) => useEditorViewport(ref, source, hand), {
    initialProps: { source: image, hand: false },
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue({ left: 10, top: 20, width: 1000, height: 500 } as DOMRect);
  container.setPointerCapture = vi.fn();
  container.hasPointerCapture = vi.fn(() => true);
  container.releasePointerCapture = vi.fn();
});
afterEach(() => { container.remove(); vi.restoreAllMocks(); });

describe("editor viewport", () => {
  it("zooms around the cursor without changing the image pixel beneath it", () => {
    const { result } = setup();
    expect(result.current.displayScale).toBe(0.5);
    const event = new WheelEvent("wheel", { clientX: 760, clientY: 270, ctrlKey: true, deltaY: -Math.log(2) / 0.01, cancelable: true });
    act(() => { container.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(result.current.viewport).toEqual({ zoom: 2, x: -250, y: 0 });
    // Cursor is 250px right of center; image point stays 250px from its center.
    expect((250 - result.current.viewport.x) / result.current.viewport.zoom).toBe(250);
    expect(image.width).toBe(2000);
  });

  it("supports scroll pan, actual size, fit reset, and bounded zoom", () => {
    const { result } = setup();
    act(() => result.current.actualSize());
    act(() => { fireEvent.wheel(container, { deltaX: 30, deltaY: 40 }); });
    expect(result.current.viewport).toEqual({ zoom: 2, x: -30, y: -40 });
    expect(result.current.displayScale).toBe(1);
    act(() => result.current.fitToWindow());
    expect(result.current.viewport).toEqual({ zoom: 1, x: 0, y: 0 });
    act(() => { for (let i = 0; i < 100; i++) result.current.zoomIn(); });
    expect(result.current.viewport.zoom).toBe(16);
    expect(result.current.canZoomIn).toBe(false);
    act(() => { for (let i = 0; i < 100; i++) result.current.zoomOut(); });
    expect(result.current.viewport).toEqual({ zoom: 1, x: 0, y: 0 });
    expect(result.current.canZoomOut).toBe(false);
  });

  it("handles WKWebView pinch without applying duplicate wheel zoom", () => {
    const { result } = setup();
    act(() => { fireEvent(container, new Event("gesturestart", { cancelable: true })); });
    const gesture = Object.assign(new Event("gesturechange", { cancelable: true }), { scale: 2, clientX: 510, clientY: 270 });
    act(() => { container.dispatchEvent(gesture); });
    expect(result.current.viewport.zoom).toBe(2);
    act(() => { fireEvent.wheel(container, { ctrlKey: true, deltaY: -100 }); });
    expect(result.current.viewport.zoom).toBe(2);
    act(() => { fireEvent(container, new Event("gestureend")); });
    act(() => { fireEvent.wheel(container, { ctrlKey: true, deltaY: -10 }); });
    expect(result.current.viewport.zoom).toBeGreaterThan(2);
  });

  it("uses shortcuts outside text fields and resets state when the image changes", () => {
    const { result, rerender } = setup();
    act(() => { fireEvent.keyDown(window, { key: "+", metaKey: true }); });
    expect(result.current.viewport.zoom).toBe(1.25);
    const input = document.createElement("textarea");
    container.append(input);
    act(() => { fireEvent.keyDown(input, { key: "+", metaKey: true }); });
    expect(result.current.viewport.zoom).toBe(1.25);
    act(() => { fireEvent.keyDown(window, { key: " ", code: "Space" }); });
    expect(result.current.spacePressed).toBe(true);
    act(() => { fireEvent.blur(window); });
    expect(result.current.spacePressed).toBe(false);
    rerender({ source: Object.assign(document.createElement("canvas"), { width: 600, height: 400 }), hand: false });
    expect(result.current.viewport).toEqual({ zoom: 1, x: 0, y: 0 });
  });

  it("captures hand drags through pointer release and leaves drawing clicks alone", () => {
    const { result, rerender } = setup();
    const event = (x: number, y: number) => ({
      target: container, currentTarget: container, button: 0, pointerId: 7, clientX: x, clientY: y,
      preventDefault: vi.fn(), stopPropagation: vi.fn(),
    });
    const click = event(100, 100);
    act(() => result.current.pointerHandlers.onPointerDownCapture(click as never));
    expect(click.preventDefault).not.toHaveBeenCalled();
    rerender({ source: image, hand: true });
    act(() => result.current.zoomIn());
    act(() => result.current.pointerHandlers.onPointerDownCapture(event(100, 100) as never));
    act(() => result.current.pointerHandlers.onPointerMoveCapture(event(150, 130) as never));
    expect(result.current.viewport).toEqual({ zoom: 1.25, x: 50, y: 30 });
    expect(result.current.isPanning).toBe(true);
    act(() => result.current.pointerHandlers.onPointerUpCapture(event(150, 130) as never));
    expect(result.current.isPanning).toBe(false);
    expect(container.releasePointerCapture).toHaveBeenCalledWith(7);
  });

  it("permits actual size for long captures but preserves the fit floor for tiny images", () => {
    const { result, rerender } = setup();
    rerender({ source: Object.assign(document.createElement("canvas"), { width: 2000, height: 50000 }), hand: false });
    act(() => result.current.actualSize());
    expect(result.current.displayScale).toBe(1);
    rerender({ source: Object.assign(document.createElement("canvas"), { width: 10, height: 5 }), hand: false });
    expect(result.current.canActualSize).toBe(false);
    act(() => result.current.actualSize());
    expect(result.current.viewport).toEqual({ zoom: 1, x: 0, y: 0 });
    expect(result.current.displayScale).toBe(100);
  });

  it("stops wheel, pinch, and keyboard zoom-out at fit and keeps fit centered", () => {
    const { result } = setup();
    act(() => result.current.actualSize());
    act(() => { fireEvent.wheel(container, { deltaX: 10000, deltaY: -10000 }); });
    expect(result.current.viewport).toEqual({ zoom: 2, x: -500, y: 250 });
    act(() => { fireEvent.wheel(container, { ctrlKey: true, deltaY: 1000, clientX: 900, clientY: 400 }); });
    expect(result.current.viewport).toEqual({ zoom: 1, x: 0, y: 0 });
    act(() => { fireEvent(container, new Event("gesturestart")); });
    act(() => { fireEvent(container, Object.assign(new Event("gesturechange"), { scale: 0.01, clientX: 900, clientY: 400 })); });
    act(() => { fireEvent(container, new Event("gestureend")); });
    act(() => { fireEvent.keyDown(window, { key: "-", metaKey: true }); });
    act(() => { fireEvent.wheel(container, { deltaX: 100, deltaY: 100 }); });
    expect(result.current.viewport).toEqual({ zoom: 1, x: 0, y: 0 });
    expect(result.current.canZoomOut).toBe(false);
  });
});

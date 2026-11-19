import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnnotationCanvas } from "./AnnotationCanvas";
import type { Annotation } from "@/types/annotations";

const image = Object.assign(document.createElement("canvas"), { width: 2000, height: 1000 });
const props = {
  annotations: [] as Annotation[], selectedAnnotation: null, selectedTool: "rectangle" as const, previewImage: image,
  onAnnotationAdd: vi.fn(), onAnnotationUpdate: vi.fn(), onAnnotationSelect: vi.fn(), onCrop: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  const context = { clearRect: vi.fn(), drawImage: vi.fn(), save: vi.fn(), restore: vi.fn(), strokeRect: vi.fn(), setLineDash: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 1000, height: 500 } as DOMRect);
});
afterEach(() => vi.restoreAllMocks());

describe("preview transforms preserve editing pixels", () => {
  it("draws at original image coordinates after zoom without resampling the bitmap", () => {
    const view = render(<AnnotationCanvas {...props} />);
    const canvas = view.container.querySelector("canvas")!;
    fireEvent.click(view.getByRole("button", { name: "Actual image size" }));
    expect(view.container.querySelector("[data-editor-transform]")).toHaveStyle({ transform: "translate(0px, 0px) scale(2)" });
    expect(view.getByLabelText("Image zoom")).toHaveTextContent("100%");
    expect(canvas.width).toBe(2000);
    expect(canvas.height).toBe(1000);
    // Browser geometry at 1:1: the centered 2000×1000 image exceeds the viewport.
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: -500, top: -250, width: 2000, height: 1000 } as DOMRect);
    fireEvent.mouseDown(canvas, { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(canvas, { clientX: 100, clientY: 100 });
    fireEvent.mouseUp(canvas, { clientX: 100, clientY: 100 });
    expect(props.onAnnotationAdd).toHaveBeenCalledWith(expect.objectContaining({ type: "rectangle", x: 500, y: 250, width: 100, height: 100 }));
    fireEvent.click(view.getByRole("button", { name: "Fit image to window" }));
    expect(view.container.querySelector("[data-editor-transform]")).toHaveStyle({ transform: "translate(0px, 0px) scale(1)" });
  });

  it("keeps text editing inside the same transformed surface", () => {
    const text: Annotation = {
      id: "text", type: "text", x: 200, y: 100, width: 400, height: 120, fontSize: 48, fontFamily: "Arial", text: "Editable",
      fill: { hex: "#FF3300", opacity: 100 }, border: { width: 5, color: { hex: "#FF3300", opacity: 100 } },
      alignment: { horizontal: "left", vertical: "top" },
    };
    const context = HTMLCanvasElement.prototype.getContext("2d")!;
    Object.assign(context, { fillText: vi.fn(), measureText: vi.fn(() => ({ width: 100 })) });
    const view = render(<AnnotationCanvas {...props} annotations={[text]} selectedTool="select" />);
    const canvas = view.container.querySelector("canvas")!;
    fireEvent.doubleClick(canvas, { clientX: 150, clientY: 75 });
    const input = view.getByRole("textbox");
    expect(input.closest("[data-editor-transform]")).toBeTruthy();
    expect(input).toHaveStyle({ left: "100px", top: "50px", width: "200px", height: "60px" });
    fireEvent.click(view.getByRole("button", { name: "Zoom in" }));
    expect(input.closest("[data-editor-transform]")).toHaveStyle({ transform: "translate(0px, 0px) scale(1.25)" });
    expect(input).toHaveStyle({ left: "100px", top: "50px" });
  });
});

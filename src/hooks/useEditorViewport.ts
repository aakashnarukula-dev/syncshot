import { useCallback, useEffect, useRef, useState, type RefObject, type PointerEvent as ReactPointerEvent } from "react";
import type { EditorBitmap } from "@/lib/canvas-utils";

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 16;
const FIT = { zoom: 1, x: 0, y: 0 };
type Viewport = typeof FIT;
type GestureEvent = Event & { scale: number; clientX: number; clientY: number };

function isEditing(target: EventTarget | null) {
  return target instanceof Element && !!target.closest("input, textarea, select, [contenteditable=true], [role=dialog], [role=alertdialog]");
}

/** View-only transforms: never change bitmap or annotation coordinates. */
export function useEditorViewport(
  containerRef: RefObject<HTMLDivElement | null>,
  image: EditorBitmap | null,
  handTool: boolean,
) {
  const [viewport, setViewport] = useState(FIT);
  const [fitScale, setFitScale] = useState(1);
  const current = useRef(FIT);
  const [spacePressed, setSpacePressed] = useState(false);
  const space = useRef(false);
  const [isPanning, setIsPanning] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);

  const update = useCallback((next: Viewport) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect && image && rect.width > 0 && rect.height > 0) {
      const fit = Math.min(rect.width / image.width, rect.height / image.height);
      setFitScale(fit);
      // Keep at least 48px visible so a dragged image cannot get lost.
      const limitX = Math.max(0, (image.width * fit * next.zoom + rect.width) / 2 - 48);
      const limitY = Math.max(0, (image.height * fit * next.zoom + rect.height) / 2 - 48);
      next = { ...next, x: Math.max(-limitX, Math.min(limitX, next.x)), y: Math.max(-limitY, Math.min(limitY, next.y)) };
    }
    current.current = next;
    setViewport(next);
  }, [containerRef, image]);

  const fitToWindow = useCallback(() => update(FIT), [update]);
  const zoomTo = useCallback((value: number, clientX?: number, clientY?: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || !image || !rect.width || !rect.height) return;
    const previous = current.current;
    const fit = Math.min(rect.width / image.width, rect.height / image.height);
    // Always allow 1:1, including very long captures and tiny images.
    const nativeZoom = 1 / fit;
    const zoom = Math.max(Math.min(MIN_ZOOM, nativeZoom), Math.min(Math.max(MAX_ZOOM, nativeZoom), value));
    const x = (clientX ?? rect.left + rect.width / 2) - rect.left - rect.width / 2;
    const y = (clientY ?? rect.top + rect.height / 2) - rect.top - rect.height / 2;
    const ratio = zoom / previous.zoom;
    update({ zoom, x: x - (x - previous.x) * ratio, y: y - (y - previous.y) * ratio });
  }, [containerRef, image, update]);
  const zoomIn = useCallback(() => zoomTo(current.current.zoom * 1.25), [zoomTo]);
  const zoomOut = useCallback(() => zoomTo(current.current.zoom / 1.25), [zoomTo]);
  const actualSize = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!image || !rect || !rect.width || !rect.height) return;
    zoomTo(1 / Math.min(rect.width / image.width, rect.height / image.height));
  }, [containerRef, image, zoomTo]);

  useEffect(() => {
    fitToWindow();
    drag.current = null;
    space.current = false;
    setIsPanning(false);
    setSpacePressed(false);
  }, [image, fitToWindow]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !image) return;
    let gestureZoom: number | null = null;
    const wheel = (event: WheelEvent) => {
      if (isEditing(event.target) || (event.target instanceof Element && event.target.closest("[data-viewport-controls]"))) return;
      event.preventDefault();
      if (gestureZoom !== null || drag.current) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? container.clientHeight : 1;
      if (event.ctrlKey || event.metaKey) {
        zoomTo(current.current.zoom * Math.exp(-event.deltaY * unit * 0.01), event.clientX, event.clientY);
      } else {
        const dx = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
        const dy = event.shiftKey && !event.deltaX ? 0 : event.deltaY;
        update({ ...current.current, x: current.current.x - dx * unit, y: current.current.y - dy * unit });
      }
    };
    // WKWebView exposes native trackpad pinch as gesture events.
    const gestureStart = (event: Event) => {
      event.preventDefault();
      gestureZoom = current.current.zoom;
    };
    const gestureChange = (event: Event) => {
      event.preventDefault();
      const gesture = event as GestureEvent;
      if (gestureZoom !== null && Number.isFinite(gesture.scale)) {
        zoomTo(gestureZoom * gesture.scale, gesture.clientX, gesture.clientY);
      }
    };
    const gestureEnd = (event: Event) => { event.preventDefault(); gestureZoom = null; };
    const keyDown = (event: KeyboardEvent) => {
      if (isEditing(event.target)) return;
      if (event.code === "Space" && !(event.target instanceof Element && event.target.closest("button"))) {
        event.preventDefault();
        space.current = true;
        setSpacePressed(true);
      }
      if (!(event.metaKey || event.ctrlKey) || drag.current) return;
      if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomIn(); }
      if (event.key === "-") { event.preventDefault(); zoomOut(); }
      if (event.key === "0") { event.preventDefault(); fitToWindow(); }
      if (event.key === "1") { event.preventDefault(); actualSize(); }
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") { space.current = false; setSpacePressed(false); }
    };
    const blur = () => {
      space.current = false;
      setSpacePressed(false);
      drag.current = null;
      setIsPanning(false);
      gestureZoom = null;
    };
    const resize = () => update(current.current);
    container.addEventListener("wheel", wheel, { passive: false });
    container.addEventListener("gesturestart", gestureStart, { passive: false });
    container.addEventListener("gesturechange", gestureChange, { passive: false });
    container.addEventListener("gestureend", gestureEnd, { passive: false });
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", blur);
    window.addEventListener("resize", resize);
    return () => {
      container.removeEventListener("wheel", wheel);
      container.removeEventListener("gesturestart", gestureStart);
      container.removeEventListener("gesturechange", gestureChange);
      container.removeEventListener("gestureend", gestureEnd);
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", blur);
      window.removeEventListener("resize", resize);
    };
  }, [containerRef, image, zoomTo, zoomIn, zoomOut, fitToWindow, actualSize, update]);

  const onPointerDownCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (isEditing(event.target) || (event.target instanceof Element && event.target.closest("[data-viewport-controls]"))) return;
    if (event.button !== 1 && !(event.button === 0 && (handTool || space.current))) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    setIsPanning(true);
  };
  const onPointerMoveCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const previous = drag.current;
    if (!previous || event.pointerId !== previous.id) return;
    event.preventDefault();
    event.stopPropagation();
    update({ ...current.current, x: current.current.x + event.clientX - previous.x, y: current.current.y + event.clientY - previous.y });
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
  };
  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    drag.current = null;
    setIsPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return {
    viewport, displayScale: viewport.zoom * fitScale, isPanning, spacePressed, zoomIn, zoomOut, fitToWindow, actualSize,
    canZoomIn: viewport.zoom < Math.max(MAX_ZOOM, 1 / fitScale),
    canZoomOut: viewport.zoom > Math.min(MIN_ZOOM, 1 / fitScale),
    pointerHandlers: { onPointerDownCapture, onPointerMoveCapture, onPointerUpCapture: endPan, onPointerCancel: endPan, onLostPointerCapture: endPan },
  };
}

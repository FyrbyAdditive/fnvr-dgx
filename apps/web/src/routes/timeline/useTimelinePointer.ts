import { RefObject, useRef, useState } from "react";
import { applyDragZoom } from "./timeMath";

// Shared pointer controller for the timeline rulers (detail + overview).
// One state machine so click-vs-drag semantics can never diverge:
//   · sub-threshold (<6px) mouse-up  → onClickMs(flooredMs, yPct)
//   · real drag                       → onZoom(composed window)
//   · move                            → hover {x, y, ms}
// Bars stay pointer-transparent; interactive children stopPropagation
// on mousedown/up only so drags across them still zoom.

export const ZOOM_DRAG_THRESHOLD_PX = 6;

export type RulerHover = { x: number; y: number; ms: number };

export function useTimelinePointer(opts: {
  ref: RefObject<HTMLDivElement | null>;
  visFromMs: number;
  visMs: number;
  zoom: { from: number; to: number };
  onZoom: (z: { from: number; to: number }) => void;
  /** Sub-threshold click. ms is floored to a whole second (playback
   *  URLs carry clean starts); yPct is 0..100 of container height so
   *  the overview can resolve which lane was hit. */
  onClickMs: (ms: number, yPct: number) => void;
}) {
  const { ref, visFromMs, visMs, zoom, onZoom, onClickMs } = opts;
  const dragAnchorRef = useRef<number | null>(null);
  const [dragRange, setDragRange] = useState<{ startX: number; endX: number } | null>(null);
  const [hover, setHover] = useState<RulerHover | null>(null);

  const clientXToMs = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return visFromMs + frac * visMs;
  };

  const clientXToVisFrac = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  };

  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragAnchorRef.current = e.clientX;
    setDragRange({ startX: e.clientX, endX: e.clientX });
    // Ensure mouseup fires even if the user drags off the element.
    ref.current?.setPointerCapture?.((e as any).pointerId ?? 1);
  };

  const onMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = ref.current?.getBoundingClientRect();
    if (r) {
      setHover({
        x: e.clientX - r.left,
        y: e.clientY - r.top,
        ms: clientXToMs(e.clientX),
      });
    }
    if (dragAnchorRef.current == null) return;
    setDragRange({ startX: dragAnchorRef.current, endX: e.clientX });
  };

  const onMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
    const anchor = dragAnchorRef.current;
    dragAnchorRef.current = null;
    setDragRange(null);
    if (anchor == null) return;
    const delta = Math.abs(e.clientX - anchor);
    if (delta < ZOOM_DRAG_THRESHOLD_PX) {
      const r = ref.current?.getBoundingClientRect();
      const yPct = r ? ((e.clientY - r.top) / Math.max(r.height, 1)) * 100 : 0;
      onClickMs(Math.floor(clientXToMs(e.clientX) / 1000) * 1000, yPct);
      return;
    }
    onZoom(applyDragZoom(zoom, clientXToVisFrac(anchor), clientXToVisFrac(e.clientX)));
  };

  const onMouseLeave = () => {
    setHover(null);
    // A drag that leaves the element ends without zooming; state must
    // not stick.
    dragAnchorRef.current = null;
    setDragRange(null);
  };

  return {
    hover,
    dragRange,
    containerHandlers: { onMouseDown, onMouseMove, onMouseUp, onMouseLeave },
  };
}

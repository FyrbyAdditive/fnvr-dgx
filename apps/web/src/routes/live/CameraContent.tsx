import { useEffect, useState } from "react";
import { DetectionEvent } from "@/lib/events";
import { useWhepStream } from "./useWhepStream";
import { BBox, FlagPopover, ManualLabelPopover } from "./Live";

// CameraContent is the shared video region for one camera — WebRTC
// <video> with JPEG fallback, bbox overlay, flag popover, and manual
// label drawer. Used by both the small mosaic tile and the enlarged
// modal so the operator's interactions are identical at any size.
//
// Each instance opens its own MediaMTX WHEP subscription via
// useWhepStream — MediaMTX serves multiple readers cheaply and tearing
// the modal down cleans its session up.
//
// `fitTo`:
// - "video"     — the box matches the source aspect ratio and shrinks
//                 to fit the parent (mosaic tile).
// - "container" — the box fills the parent's width and height; the
//                 video letterboxes inside via an inner element so
//                 bbox coordinates map to the visible pixels.
//
// `drawing` is **controlled** — the parent owns the toggle button and
// passes the state in. The drawer commits a rect by opening
// ManualLabelPopover here; the parent's drawing flag flips back to
// false via onDrawingChange when commit happens.
export function CameraContent({
  cameraId,
  name,
  detections,
  isAdmin,
  drawing,
  onDrawingChange,
  onClickEmpty,
  fitTo = "video",
  onPreviewFps,
}: {
  cameraId: string;
  name: string;
  detections: DetectionEvent[];
  isAdmin: boolean;
  drawing: boolean;
  onDrawingChange: (next: boolean) => void;
  /** Click on a non-bbox region of the video. Suppressed while
   *  drawing or while a popover is up. Used by the tile to open the
   *  enlarged modal. */
  onClickEmpty?: () => void;
  fitTo?: "video" | "container";
  /** Sampled every 500ms — the parent uses this for the stats overlay. */
  onPreviewFps?: (fps: number) => void;
}) {
  // Flag-popover state.
  const [pickedDetection, setPickedDetection] = useState<DetectionEvent | null>(null);
  const [pickedFrozenBoxes, setPickedFrozenBoxes] = useState<DetectionEvent[] | null>(null);

  // Manual-label drawer state.
  const [drawnRect, setDrawnRect] = useState<
    { x: number; y: number; w: number; h: number } | null
  >(null);
  const [drawingDragStart, setDrawingDragStart] = useState<
    { x: number; y: number } | null
  >(null);
  const [pendingManualRect, setPendingManualRect] = useState<
    { x: number; y: number; w: number; h: number } | null
  >(null);

  // If the parent flips drawing off mid-drag (e.g. the "cancel draw"
  // button), discard the in-progress rect.
  useEffect(() => {
    if (!drawing) {
      setDrawnRect(null);
      setDrawingDragStart(null);
    }
  }, [drawing]);

  // JPEG fallback refresh.
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    const h = setInterval(() => setT(Date.now()), 1000);
    return () => clearInterval(h);
  }, []);
  const src = `/api/v1/cameras/${encodeURIComponent(cameraId)}/snapshot.jpg?t=${t}`;
  const [imgOk, setImgOk] = useState(true);
  useEffect(() => { setImgOk(true); }, [cameraId]);

  // WHEP plumbing + frame-stall watchdog.
  const { videoRef, rtcLive, tickPreview, previewTicksRef } = useWhepStream(cameraId, { imgOk });

  // Push preview-FPS to the parent's stats overlay if it wants one.
  useEffect(() => {
    if (!onPreviewFps) return;
    const h = setInterval(() => {
      onPreviewFps(previewTicksRef.current.length / 5);
    }, 500);
    return () => clearInterval(h);
  }, [onPreviewFps, previewTicksRef]);

  // Reset JPEG-failed flag whenever the WHEP retry kicks so the <img>
  // gets another chance alongside the renegotiated session.
  useEffect(() => {
    if (!imgOk) setImgOk(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rtcLive]);

  const [aspect, setAspect] = useState(16 / 9);

  // For the modal ("container" mode) we use an absolutely-positioned
  // inner letterbox so the video sizes correctly inside the full-window
  // container. For the tile ("video" mode) the outer wrapper itself
  // matches aspect and the inner div just fills it.
  const outerStyle: React.CSSProperties = fitTo === "container"
    ? { width: "100%", height: "100%" }
    : {
        aspectRatio: aspect,
        width: aspect >= 16 / 9 ? "100%" : "auto",
        height: aspect < 16 / 9 ? "100%" : "auto",
      };

  const innerStyle: React.CSSProperties = fitTo === "container"
    ? {
        position: "absolute",
        inset: 0,
        margin: "auto",
        aspectRatio: aspect,
        maxWidth: "100%",
        maxHeight: "100%",
      }
    : { position: "absolute", inset: 0 };

  return (
    <div
      className={`relative max-w-full max-h-full ${drawing ? "cursor-crosshair" : onClickEmpty ? "cursor-zoom-in" : ""}`}
      style={outerStyle}
      onClick={
        drawing || pickedDetection || pendingManualRect
          ? undefined
          : onClickEmpty
      }
      onMouseDown={
        drawing
          ? (e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const x = (e.clientX - rect.left) / rect.width;
              const y = (e.clientY - rect.top) / rect.height;
              setDrawingDragStart({ x, y });
              setDrawnRect({ x, y, w: 0, h: 0 });
            }
          : undefined
      }
      onMouseMove={
        drawing && drawingDragStart
          ? (e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
              const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
              setDrawnRect({
                x: Math.min(drawingDragStart.x, x),
                y: Math.min(drawingDragStart.y, y),
                w: Math.abs(x - drawingDragStart.x),
                h: Math.abs(y - drawingDragStart.y),
              });
            }
          : undefined
      }
      onMouseUp={
        drawing && drawingDragStart
          ? () => {
              setDrawingDragStart(null);
              if (drawnRect && drawnRect.w > 0.01 && drawnRect.h > 0.01) {
                setPendingManualRect(drawnRect);
                onDrawingChange(false);
              } else {
                setDrawnRect(null);
              }
            }
          : undefined
      }
    >
      <div className="absolute" style={innerStyle}>
        {rtcLive ? (
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              if (v.videoWidth && v.videoHeight) setAspect(v.videoWidth / v.videoHeight);
            }}
            className="absolute inset-0 w-full h-full"
          />
        ) : imgOk ? (
          <img
            src={src}
            alt={name}
            onLoad={(e) => {
              tickPreview();
              const im = e.currentTarget;
              if (im.naturalWidth && im.naturalHeight) setAspect(im.naturalWidth / im.naturalHeight);
            }}
            className="absolute inset-0 w-full h-full"
            onError={() => setImgOk(false)}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-neutral-600 text-sm">
            No recording yet
          </div>
        )}

        {(pickedFrozenBoxes ?? detections).map((d) => (
          <BBox
            key={d.id}
            d={d}
            highlighted={pickedDetection?.id === d.id}
            onPick={
              isAdmin && (d.kind === undefined || d.kind === "object")
                ? () => {
                    setPickedDetection(d);
                    setPickedFrozenBoxes(detections);
                  }
                : undefined
            }
          />
        ))}
        {pickedDetection && (
          <FlagPopover
            detection={pickedDetection}
            onClose={() => {
              setPickedDetection(null);
              setPickedFrozenBoxes(null);
            }}
          />
        )}

        {drawing && drawnRect && (
          <div
            className="absolute pointer-events-none border-2 border-emerald-400 bg-emerald-400/10"
            style={{
              left: `${drawnRect.x * 100}%`,
              top: `${drawnRect.y * 100}%`,
              width: `${drawnRect.w * 100}%`,
              height: `${drawnRect.h * 100}%`,
            }}
          />
        )}

        {pendingManualRect && (
          <ManualLabelPopover
            cameraId={cameraId}
            bbox={pendingManualRect}
            onClose={() => {
              setPendingManualRect(null);
              setDrawnRect(null);
            }}
          />
        )}
      </div>
    </div>
  );
}

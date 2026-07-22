import { memo, useEffect, useState } from "react";
import { DetectionEvent } from "@/lib/events";
import { ConnectionStatus, useWhepStream, WhepStatus } from "./useWhepStream";
import { useStreamQuality } from "./useStreamQuality";
import { BBox, FlagPopover, ManualLabelPopover } from "./overlays";

// CameraContent is the shared video region for one camera — WebRTC
// <video> layered over a snapshot poster, with bbox overlay, flag
// popover, and manual label drawer. Used by the mosaic tile and the
// enlarged modal so the operator's interactions are identical at any
// size.
//
// Layering (bottom → top): snapshot poster (always mounted; blurred
// while the stream connects, sharp when it IS the view) → <video>
// (fades in over the poster on first frame — no black tiles, no
// flash) → shimmer sweep while connecting with no poster → bboxes /
// popovers / draw rect.
//
// Geometry: the outer div fills its parent; the inner letterbox is
// absolutely centered with the source aspect ratio. Metadata updates
// resize only the letterbox — the parent cell never changes size (the
// old tile mode resized its own box on loadedmetadata, which made
// portrait cameras jump).
//
// `drawing` is **controlled** — the parent owns the toggle button and
// passes the state in. The drawer commits a rect by opening
// ManualLabelPopover here; the parent's drawing flag flips back to
// false via onDrawingChange when commit happens.
export const CameraContent = memo(CameraContentImpl);

function CameraContentImpl({
  cameraId,
  name,
  detections,
  isAdmin,
  drawing,
  onDrawingChange,
  onClickEmpty,
  onPreviewFps,
  quality,
  hasProxy,
  onStatusChange,
  onDegradedChange,
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
  /** Sampled every 500ms — the parent uses this for the stats overlay.
   *  Pass undefined when stats are hidden so the sampler doesn't run. */
  onPreviewFps?: (fps: number) => void;
  /** Stream quality: "proxy" = lp_ when available (grid tiles),
   *  "full" = passthrough always, "auto" = passthrough with automatic
   *  proxy fallback on hard failure (enlarged view default). */
  quality: "auto" | "full" | "proxy";
  /** Whether this camera has an lp_ proxy stream (lib/streams
   *  hasProxyStream). */
  hasProxy: boolean;
  /** Reports the derived display status (incl. fallback_jpeg) and the
   *  last WHEP error string up for the tile chrome. */
  onStatusChange?: (s: ConnectionStatus, lastError: string | null) => void;
  /** Reports whether the auto-quality path downgraded to the proxy.
   *  (To retry full quality, remount this component — key bump.) */
  onDegradedChange?: (degraded: boolean) => void;
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

  // WHEP plumbing: quality pref → prefix (with auto-degrade), then the
  // stream + status machine. The health mirror lags one render behind
  // the stream state, which is fine — the degrade decision is a
  // seconds-scale call, not per-frame.
  const [health, setHealth] = useState<{ status: WhepStatus; everLive: boolean }>({
    status: "connecting",
    everLive: false,
  });
  const { prefix, degraded } = useStreamQuality(quality, hasProxy, health);
  const { videoRef, status, lastError, everLive, tickPreview, previewTicksRef } =
    useWhepStream(cameraId, { pathPrefix: prefix });
  useEffect(() => {
    setHealth({ status, everLive });
  }, [status, everLive]);
  useEffect(() => {
    onDegradedChange?.(degraded);
  }, [degraded, onDegradedChange]);

  const live = status === "live";

  // Snapshot poster refresh — 1 Hz, but ONLY while the stream isn't
  // painting (a wall of live tiles used to re-render every second for
  // nothing).
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    if (live) return;
    const h = setInterval(() => setT(Date.now()), 1000);
    return () => clearInterval(h);
  }, [live]);
  const src = `/api/v1/cameras/${encodeURIComponent(cameraId)}/snapshot.jpg?t=${t}`;
  const [imgOk, setImgOk] = useState(true);
  const [imgLoadedOnce, setImgLoadedOnce] = useState(false);
  useEffect(() => {
    setImgOk(true);
    setImgLoadedOnce(false);
  }, [cameraId]);
  // Give the <img> another chance alongside each renegotiation.
  useEffect(() => {
    if (!imgOk && !live) setImgOk(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // The status the chrome renders: JPEG fallback masks a broken WHEP
  // session as long as the poster is actually loading.
  const display: ConnectionStatus =
    live ? "live" : imgOk && imgLoadedOnce ? "fallback_jpeg" : status;
  useEffect(() => {
    onStatusChange?.(display, lastError);
  }, [display, lastError, onStatusChange]);

  // Push preview-FPS to the parent's stats overlay if it wants one.
  useEffect(() => {
    if (!onPreviewFps) return;
    const h = setInterval(() => {
      onPreviewFps(previewTicksRef.current.length / 5);
    }, 500);
    return () => clearInterval(h);
  }, [onPreviewFps, previewTicksRef]);

  const [aspect, setAspect] = useState(16 / 9);

  const showShimmer =
    !live &&
    !imgLoadedOnce &&
    (status === "connecting" || status === "waiting_frame" || status === "reconnecting");

  return (
    <div
      className={`absolute inset-0 ${drawing ? "cursor-crosshair" : onClickEmpty ? "cursor-zoom-in" : ""}`}
      onClick={
        drawing || pickedDetection || pendingManualRect
          ? undefined
          : onClickEmpty
      }
    >
      {/* Inner letterbox — centered, source aspect. All content and
          overlays live inside so bbox %-coords map to visible pixels. */}
      <div
        className="absolute"
        style={{
          position: "absolute",
          inset: 0,
          margin: "auto",
          aspectRatio: aspect,
          maxWidth: "100%",
          maxHeight: "100%",
        }}
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
        {/* Poster layer. Blurred + dimmed while it's just a backdrop
            for the connecting stream; sharp when it IS the view. */}
        {imgOk ? (
          <img
            src={src}
            alt={name}
            onLoad={(e) => {
              tickPreview();
              setImgLoadedOnce(true);
              const im = e.currentTarget;
              if (!live && im.naturalWidth && im.naturalHeight) {
                setAspect(im.naturalWidth / im.naturalHeight);
              }
            }}
            onError={() => setImgOk(false)}
            className={`absolute inset-0 w-full h-full transition-[filter] duration-300 ${
              display === "fallback_jpeg" ? "" : "blur-[2px] brightness-75 scale-[1.02]"
            }`}
          />
        ) : !live ? (
          <div className="absolute inset-0 flex items-center justify-center text-neutral-600 text-sm">
            No recording yet
          </div>
        ) : null}

        {/* Video layer — always mounted so the ref attaches before the
            first frame; fades in over the poster. */}
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            if (v.videoWidth && v.videoHeight) setAspect(v.videoWidth / v.videoHeight);
          }}
          className={`absolute inset-0 w-full h-full transition-opacity duration-500 ${
            live ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}
        />

        {/* Shimmer while connecting with nothing to show yet. */}
        {showShimmer && (
          <div className="absolute inset-0 overflow-hidden pointer-events-none">
            <div className="absolute inset-y-0 -inset-x-full bg-gradient-to-r from-transparent via-white/5 to-transparent animate-[shimmer_1.6s_linear_infinite]" />
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

import { useEffect, useState } from "react";
import { HistoricDetection } from "@/lib/api";
import { BBox, FlagPopover } from "@/routes/live/overlays";
import { DetectionEvent } from "@/lib/events";

// Adapter: BBox / FlagPopover (lifted from Live.tsx) speak in
// `DetectionEvent` shape. Timeline carries `HistoricDetection`. The
// shapes overlap in everything except identity-keying — Live's `id`
// is the event_id hex string and `pg_id` is the optional PG row id;
// HistoricDetection swaps those (id is the PG row id, event_id is
// the hex). `arrived_at_ms` is Live-only (drives bbox staleness on
// the live mosaic) and unused here.
export function asDetectionEvent(d: HistoricDetection): DetectionEvent {
  return {
    id: d.event_id,
    pg_id: d.id,
    camera_id: d.camera_id,
    ts: d.ts,
    arrived_at_ms: Date.parse(d.ts),
    class_name: d.class_name,
    kind: d.kind,
    confidence: d.confidence,
    bbox: d.bbox,
    track_id: d.track_id,
    attributes: d.attributes,
  };
}

export function PlayerOverlay({
  videoRef,
  videoSize,
  detections,
  isAdmin,
}: {
  videoRef: React.RefObject<HTMLVideoElement>;
  videoSize: { w: number; h: number };
  detections: HistoricDetection[];
  isAdmin: boolean;
}) {
  // Compute the letterboxed content rect inside the video element,
  // matching object-contain. bbox coords are 0..1 of the source frame
  // so we multiply by that rect and add the element-relative offset.
  const [box, setBox] = useState<{ left: number; top: number; w: number; h: number } | null>(null);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const recalc = () => {
      const elW = v.clientWidth;
      const elH = v.clientHeight;
      const srcAspect = videoSize.w / videoSize.h;
      const elAspect = elW / elH;
      let w, h, left, top;
      if (elAspect > srcAspect) {
        // Pillarbox: full height, narrower width
        h = elH;
        w = h * srcAspect;
        left = (elW - w) / 2;
        top = 0;
      } else {
        // Letterbox: full width, shorter height
        w = elW;
        h = w / srcAspect;
        left = 0;
        top = (elH - h) / 2;
      }
      setBox({ left, top, w, h });
    };
    recalc();
    const ro = new ResizeObserver(recalc);
    ro.observe(v);
    return () => ro.disconnect();
  }, [videoRef, videoSize]);

  // Click-to-flag plumbing (admin only, object-kind only). When a
  // box is picked we freeze the rendered set on `pickedFrozen` so the
  // box stays under the user's cursor while they confirm — same
  // pattern as Live's CameraContent. We also pause the video so the
  // active detection set doesn't slide out from under them.
  const [pickedDetection, setPickedDetection] = useState<DetectionEvent | null>(null);
  const [pickedFrozen, setPickedFrozen] = useState<HistoricDetection[] | null>(null);

  const renderDetections = pickedFrozen ?? detections;

  if (!box) return null;
  return (
    <div
      className="absolute"
      // Pointer events are managed by the children: BBox sets
      // pointerEvents:auto only when onPick is provided (admin +
      // object). Plates / faces / non-admin views stay click-through.
      style={{
        left: box.left,
        top: box.top,
        width: box.w,
        height: box.h,
        pointerEvents: "none",
      }}
    >
      {renderDetections.map((d) => (
        <BBox
          key={d.id}
          d={asDetectionEvent(d)}
          highlighted={pickedDetection?.pg_id === d.id}
          onPick={
            isAdmin && (d.kind === undefined || d.kind === "object")
              ? () => {
                  setPickedDetection(asDetectionEvent(d));
                  setPickedFrozen(detections);
                  videoRef.current?.pause();
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
            setPickedFrozen(null);
          }}
        />
      )}
    </div>
  );
}

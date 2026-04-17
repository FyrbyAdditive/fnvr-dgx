import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useRecentDetections, DetectionEvent } from "@/lib/events";

export function Live() {
  const { data: cameras = [] } = useQuery({ queryKey: ["cameras"], queryFn: api.listCameras });
  const events = useRecentDetections(100);

  // Group detections by camera, keeping only the freshest few per cam so
  // stale bboxes don't pile up. The SSE stream is already filtered to
  // recent-only, but we additionally time-gate to the last 2s.
  const boxesByCamera = useMemo(() => {
    const now = Date.now();
    const m = new Map<string, DetectionEvent[]>();
    for (const e of events) {
      if (now - new Date(e.ts).getTime() > 2000) continue;
      const arr = m.get(e.camera_id) ?? [];
      arr.push(e);
      m.set(e.camera_id, arr);
    }
    return m;
  }, [events]);

  const grid =
    cameras.length <= 1 ? "grid-cols-1" :
    cameras.length <= 4 ? "grid-cols-2" :
    cameras.length <= 9 ? "grid-cols-3" :
    "grid-cols-4";

  return (
    <div className="p-4 h-full">
      {cameras.length === 0 ? (
        <EmptyState />
      ) : (
        <div className={`grid gap-2 ${grid} h-full`}>
          {cameras.map((c) => (
            <CameraTile
              key={c.id}
              id={c.id}
              name={c.name}
              detections={boxesByCamera.get(c.id) ?? []}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CameraTile({ id, name, detections }: {
  id: string;
  name: string;
  detections: DetectionEvent[];
}) {
  // Refresh the snapshot every second.
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    const h = setInterval(() => setT(Date.now()), 1000);
    return () => clearInterval(h);
  }, []);
  const src = `/api/v1/cameras/${encodeURIComponent(id)}/snapshot.jpg?t=${t}`;

  const [ok, setOk] = useState(true);
  useEffect(() => { setOk(true); }, [id]);

  // Overlay is absolutely-positioned at the tile's edges; bbox normalised
  // 0..1 coords map directly to CSS percentages. We don't need the
  // natural image dimensions because object-cover stretches to fill.
  const imgRef = useRef<HTMLImageElement>(null);
  const latest = detections[0];

  return (
    <div className="bg-neutral-900 rounded aspect-video relative overflow-hidden">
      {ok ? (
        <img
          ref={imgRef}
          src={src}
          alt={name}
          className="absolute inset-0 w-full h-full object-cover"
          onError={() => setOk(false)}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-neutral-600 text-sm">
          No recording yet
        </div>
      )}

      {/* bbox overlay — coords are normalised 0..1 of the source frame */}
      {detections.map((d) => (
        <BBox key={d.id} d={d} />
      ))}

      <div className="absolute bottom-2 left-2 text-xs bg-black/60 px-2 py-0.5 rounded">
        {name}
      </div>
      {latest && (
        <div className="absolute top-2 right-2 text-xs bg-blue-600/80 px-2 py-0.5 rounded">
          {latest.class_name} {(latest.confidence * 100).toFixed(0)}%
        </div>
      )}
    </div>
  );
}

function BBox({ d }: { d: DetectionEvent }) {
  const color = colorForClass(d.class_name);
  const style: React.CSSProperties = {
    position: "absolute",
    left: `${d.bbox.x * 100}%`,
    top: `${d.bbox.y * 100}%`,
    width: `${d.bbox.w * 100}%`,
    height: `${d.bbox.h * 100}%`,
    border: `2px solid ${color}`,
    boxShadow: `0 0 0 1px rgba(0,0,0,0.5)`,
    pointerEvents: "none",
  };
  return (
    <div style={style}>
      <div
        className="absolute top-0 left-0 text-[10px] px-1 font-medium leading-tight"
        style={{ background: color, color: "#000", transform: "translateY(-100%)" }}
      >
        {d.class_name} {(d.confidence * 100).toFixed(0)}%
      </div>
    </div>
  );
}

// Stable per-class colours. A hash of the class name gives consistent
// colours across sessions without needing a lookup table.
function colorForClass(cls: string): string {
  let h = 0;
  for (let i = 0; i < cls.length; i++) h = (h * 31 + cls.charCodeAt(i)) & 0xffffff;
  const hue = h % 360;
  return `hsl(${hue}, 85%, 55%)`;
}

function EmptyState() {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-center space-y-2">
        <div className="text-lg">No cameras yet.</div>
        <div className="text-neutral-500 text-sm">
          Add one from the <a className="underline" href="/cameras">Cameras</a> tab.
        </div>
      </div>
    </div>
  );
}

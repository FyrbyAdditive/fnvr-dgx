import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, HistoricDetection, Segment } from "@/lib/api";

// The timeline shows one day (local time) for one camera. Segments render as
// solid bars across a 24h ruler; detections as coloured pins underneath.
// Clicking the ruler seeks the video player to that moment; the player
// auto-selects the segment that contains the clicked instant.

export function Timeline() {
  const { data: cameras = [] } = useQuery({ queryKey: ["cameras"], queryFn: api.listCameras });
  const [cameraId, setCameraId] = useState<string>("");
  const [dayKey, setDayKey] = useState<string>(() => todayKey());

  // Default to first camera once we know them.
  useEffect(() => {
    if (!cameraId && cameras.length > 0) setCameraId(cameras[0].id);
  }, [cameras, cameraId]);

  const { from, to } = useMemo(() => dayRange(dayKey), [dayKey]);

  const { data: segments = [] } = useQuery({
    queryKey: ["segments", cameraId, dayKey],
    queryFn: () => api.listSegments({ cameraId, from, to, limit: 1000 }),
    enabled: !!cameraId,
  });

  const { data: detections = [] } = useQuery({
    queryKey: ["detections", cameraId, dayKey],
    queryFn: () => api.listDetectionsHistoric({ cameraId, from, to, limit: 5000 }),
    enabled: !!cameraId,
  });

  const [cursorMs, setCursorMs] = useState<number | null>(null);

  // When the user clicks, find the segment containing that ms and set it
  // as the active clip — player swaps source + seeks to the offset within.
  const activeClip = useMemo(() => {
    if (cursorMs == null) return null;
    const cursor = new Date(from.getTime() + cursorMs);
    for (const s of segments) {
      const segStart = new Date(s.started_at).getTime();
      const segEnd = s.ended_at
        ? new Date(s.ended_at).getTime()
        : segStart + (s.duration_ms ?? estimateDurMs(s));
      if (cursor.getTime() >= segStart && cursor.getTime() < segEnd) {
        return { segment: s, offsetSec: (cursor.getTime() - segStart) / 1000 };
      }
    }
    return null;
  }, [cursorMs, segments, from]);

  return (
    <div className="p-4 grid grid-rows-[auto_1fr_auto] gap-3 h-full min-h-0">
      <header className="flex items-center gap-3">
        <h2 className="text-lg font-semibold">Timeline</h2>
        <select
          className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm"
          value={cameraId}
          onChange={(e) => setCameraId(e.target.value)}
        >
          {cameras.length === 0 && <option>No cameras</option>}
          {cameras.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <input
          type="date"
          className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm"
          value={dayKey}
          onChange={(e) => setDayKey(e.target.value)}
        />
        <div className="flex items-center gap-3 text-xs text-neutral-500 ml-auto">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-3 h-2 bg-blue-600/60 rounded-sm" />
            recording ({segments.length})
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-0.5 h-3 bg-amber-400/80" />
            detection ({detections.length})
          </span>
        </div>
      </header>

      <div className="rounded bg-neutral-900 overflow-hidden relative">
        <Player clip={activeClip} />
      </div>

      <TimelineRuler
        from={from}
        to={to}
        segments={segments}
        detections={detections}
        cursorMs={cursorMs}
        onSeek={setCursorMs}
      />
    </div>
  );
}

function Player({ clip }: { clip: { segment: Segment; offsetSec: number } | null }) {
  const ref = useRef<HTMLVideoElement>(null);
  const url = clip ? api.segmentFileUrl(clip.segment.id) : "";

  // Seek within the current source once metadata loads.
  useEffect(() => {
    if (!clip || !ref.current) return;
    const v = ref.current;
    const seek = () => {
      try { v.currentTime = clip.offsetSec; } catch { /* source swap in flight */ }
    };
    if (v.readyState >= 1) seek();
    else v.addEventListener("loadedmetadata", seek, { once: true });
  }, [clip]);

  if (!clip) {
    return (
      <div className="h-full flex items-center justify-center text-neutral-500 text-sm">
        Click the timeline to play
      </div>
    );
  }
  return (
    <video
      ref={ref}
      key={clip.segment.id}
      src={url}
      controls
      autoPlay
      playsInline
      className="w-full h-full object-contain bg-black"
    />
  );
}

function TimelineRuler({
  from, to, segments, detections, cursorMs, onSeek,
}: {
  from: Date;
  to: Date;
  segments: Segment[];
  detections: HistoricDetection[];
  cursorMs: number | null;
  onSeek: (ms: number) => void;
}) {
  const dayMs = to.getTime() - from.getTime();
  const ref = useRef<HTMLDivElement>(null);

  const pct = (d: Date) => ((d.getTime() - from.getTime()) / dayMs) * 100;

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = ref.current!.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    onSeek(frac * dayMs);
  };

  const hours = Array.from({ length: 25 }, (_, i) => i);

  return (
    <div className="select-none">
      <div
        ref={ref}
        onClick={handleClick}
        className="relative h-28 bg-neutral-900 rounded cursor-crosshair"
      >
        {/* row labels */}
        <div className="absolute left-1 top-[28%] -translate-y-1/2 text-[10px] text-neutral-400 pointer-events-none">
          recording
        </div>
        <div className="absolute left-1 top-[73%] -translate-y-1/2 text-[10px] text-neutral-400 pointer-events-none">
          detections
        </div>
        {/* hour grid */}
        {hours.map((h) => (
          <div key={h}
               className="absolute top-0 bottom-3 border-l border-neutral-800 text-[10px] text-neutral-600 pl-1"
               style={{ left: `${(h / 24) * 100}%` }}>
            {h.toString().padStart(2, "0")}
          </div>
        ))}
        {/* segments — top half */}
        {segments.map((s) => {
          const start = new Date(s.started_at);
          const end = s.ended_at ? new Date(s.ended_at) : new Date(start.getTime() + (s.duration_ms ?? estimateDurMs(s)));
          const left = Math.max(0, pct(start));
          const right = Math.min(100, pct(end));
          const width = right - left;
          if (width <= 0) return null;
          return (
            <div
              key={s.id}
              className="absolute bg-blue-600/60 hover:bg-blue-500/80"
              style={{ left: `${left}%`, width: `${width}%`, top: "18%", height: "22%" }}
              title={`${start.toLocaleTimeString()} → ${end.toLocaleTimeString()}`}
            />
          );
        })}
        {/* detection pins — bottom half */}
        {detections.map((d) => {
          const t = new Date(d.ts);
          const p = pct(t);
          if (p < 0 || p > 100) return null;
          return (
            <div
              key={d.id}
              className="absolute w-0.5 bg-amber-400/80"
              style={{ left: `${p}%`, top: "60%", height: "25%" }}
              title={`${t.toLocaleTimeString()} · ${d.class_name} ${(d.confidence * 100).toFixed(0)}%`}
            />
          );
        })}
        {/* cursor */}
        {cursorMs != null && (
          <div
            className="absolute top-0 bottom-0 w-px bg-red-500 pointer-events-none"
            style={{ left: `${(cursorMs / dayMs) * 100}%` }}
          />
        )}
      </div>
    </div>
  );
}

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function pad(n: number): string { return n < 10 ? `0${n}` : `${n}`; }
function dayRange(key: string): { from: Date; to: Date } {
  const [y, m, d] = key.split("-").map(Number);
  const from = new Date(y, m - 1, d, 0, 0, 0, 0);
  const to = new Date(y, m - 1, d + 1, 0, 0, 0, 0);
  return { from, to };
}
// estimateDurMs is a fallback when segments haven't finalised — use bytes
// with a rough h264/h265 bitrate assumption so the bar has *some* width.
// 2 Mbps ≈ 250 KB/s so bytes/250000 ≈ seconds. Clamped to 1h max.
function estimateDurMs(s: Segment): number {
  if (!s.bytes) return 60_000;
  const sec = Math.min(3600, Math.max(10, s.bytes / 250_000));
  return sec * 1000;
}

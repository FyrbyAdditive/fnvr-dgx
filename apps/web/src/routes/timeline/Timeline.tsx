import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, HistoricDetection, Segment } from "@/lib/api";
import { useMe, isAdmin as isAdminFn } from "@/lib/me";
import { CameraToggle } from "@/components/CameraToggle";
import { CameraDetectorChips } from "@/components/CameraDetectorChips";

// Timeline: one day (local time) for one camera. Segments render as solid
// bars across the 24h ruler; detections as coloured pins underneath.
// Features: click anywhere on ruler to seek; drag to zoom into a window;
// double-click to reset; click the green "now" marker to jump to /live;
// click a detection pin to seek to that exact moment; auto-advance to
// the next segment when a clip ends; segment + detection lists refresh
// every 10s so the active recording grows visibly in place.

const ZOOM_DRAG_THRESHOLD_PX = 6;

export function Timeline() {
  const { data: cameras = [] } = useQuery({ queryKey: ["cameras"], queryFn: api.listCameras });
  const { data: me } = useMe();
  const admin = isAdminFn(me);
  const [searchParams, setSearchParams] = useSearchParams();
  const [cameraId, setCameraId] = useState<string>("");
  const activeCamera = useMemo(() => cameras.find((c) => c.id === cameraId), [cameras, cameraId]);
  const [dayKey, setDayKey] = useState<string>(() => todayKey());
  const [cursorMs, setCursorMs] = useState<number | null>(null);

  useEffect(() => {
    if (!cameraId && cameras.length > 0) setCameraId(cameras[0].id);
  }, [cameras, cameraId]);

  // Deeplink: `?camera=X&ts=<ISO>` jumps straight to the right day with
  // the cursor on that timestamp. Used by the Events page to open an
  // incident's moment. Consumed once, then the params are cleared so
  // later interactions don't get re-yanked back to the link target.
  useEffect(() => {
    const cam = searchParams.get("camera");
    const tsStr = searchParams.get("ts");
    if (!cam && !tsStr) return;
    if (cam) setCameraId(cam);
    if (tsStr) {
      const ts = new Date(tsStr);
      if (!Number.isNaN(ts.getTime())) {
        const key = dayKeyFrom(ts);
        setDayKey(key);
        const { from: dayStart } = dayRange(key);
        setCursorMs(ts.getTime() - dayStart.getTime());
      }
    }
    // Strip query so a later refresh/share of the URL reflects the
    // current view, not the original deeplink.
    setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);

  const { from, to } = useMemo(() => dayRange(dayKey), [dayKey]);

  // A past day's segments + detections are immutable. Only poll for
  // live updates when the selected day is today — otherwise we'd
  // re-scan every rec.jsonl sidecar server-side every 10s for no
  // reason. Cold-day view is a one-shot fetch.
  const isToday = dayKey === todayKey();
  const pollMs = isToday ? 10_000 : false;

  const { data: segments = [] } = useQuery({
    queryKey: ["segments", cameraId, dayKey],
    queryFn: () => api.listSegments({ cameraId, from, to, limit: 1000 }),
    enabled: !!cameraId,
    refetchInterval: pollMs,
    refetchIntervalInBackground: false,
  });

  const { data: detections = [] } = useQuery({
    queryKey: ["detections", cameraId, dayKey],
    queryFn: () => api.listDetectionsHistoric({ cameraId, from, to, limit: 5000 }),
    enabled: !!cameraId,
    refetchInterval: pollMs,
    refetchIntervalInBackground: false,
  });

  // Zoom as fractions of the day (0..1). Full day = {0, 1}.
  const [zoom, setZoom] = useState<{ from: number; to: number }>({ from: 0, to: 1 });
  const resetZoom = () => setZoom({ from: 0, to: 1 });

  // Optional: overlay bounding boxes + class labels on the player, fed
  // from the detections endpoint (PG for recent, sidecar JSONL for
  // older clips). Persisted via localStorage so the choice survives
  // reloads, matching the Live page's "show stats" pattern.
  const [showOverlay, setShowOverlay] = useState<boolean>(() => {
    try { return localStorage.getItem("fnvr.timeline.showOverlay") === "1"; }
    catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("fnvr.timeline.showOverlay", showOverlay ? "1" : "0"); }
    catch { /* sandboxed iframe, no-op */ }
  }, [showOverlay]);

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

  // Auto-advance: when a clip ends, seek to the start of the next
  // segment by started_at (if gap is reasonable).
  const handleClipEnded = () => {
    if (!activeClip) return;
    const curStart = new Date(activeClip.segment.started_at).getTime();
    const curEnd = activeClip.segment.ended_at
      ? new Date(activeClip.segment.ended_at).getTime()
      : curStart + (activeClip.segment.duration_ms ?? estimateDurMs(activeClip.segment));
    const next = segments
      .filter((s) => new Date(s.started_at).getTime() >= curEnd)
      .sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime())[0];
    if (!next) return;
    const nextStart = new Date(next.started_at).getTime();
    if (nextStart - curEnd > 10 * 60 * 1000) return; // gap > 10 min, don't leap
    setCursorMs(nextStart - from.getTime() + 1);
  };

  const zoomed = zoom.from > 0 || zoom.to < 1;

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
        {zoomed && (
          <button
            onClick={resetZoom}
            className="text-xs text-neutral-400 hover:text-white bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
            title="Reset zoom (also: double-click the ruler)"
          >
            zoom: {msToHHMM(zoom.from * dayRangeMs(from, to))} – {msToHHMM(zoom.to * dayRangeMs(from, to))} ⟳
          </button>
        )}
        <button
          onClick={() => setShowOverlay((v) => !v)}
          className={`text-xs px-2 py-1 rounded border ${
            showOverlay
              ? "bg-amber-700/70 border-amber-600 text-amber-100"
              : "bg-neutral-900 border-neutral-700 text-neutral-400 hover:text-white"
          }`}
          title="Draw bounding boxes + class labels on the recorded video using detections from the sidecar"
        >
          {showOverlay ? "overlay on" : "overlay off"}
        </button>
        <div className="flex items-center gap-3 text-xs text-neutral-500 ml-auto">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-3 h-2 bg-blue-600/60 rounded-sm" />
            recording ({segments.length})
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-0.5 h-3 bg-amber-400/80" />
            detection ({detections.length})
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-0.5 h-3 bg-emerald-400" />
            now (click → live)
          </span>
        </div>
      </header>

      <div className="rounded bg-neutral-900 overflow-hidden relative">
        <Player
          clip={activeClip}
          onEnded={handleClipEnded}
          detections={showOverlay ? detections : undefined}
          cameraId={cameraId}
          cameraEnabled={activeCamera?.enabled}
          cameraEnabledDetectors={activeCamera?.enabled_detectors ?? []}
          isAdmin={admin}
        />
      </div>

      <TimelineRuler
        from={from}
        to={to}
        segments={segments}
        detections={detections}
        cursorMs={cursorMs}
        onSeek={setCursorMs}
        zoom={zoom}
        onZoom={setZoom}
        onResetZoom={resetZoom}
        cameraId={cameraId}
      />
    </div>
  );
}

function Player({
  clip,
  onEnded,
  detections,
  cameraId,
  cameraEnabled,
  cameraEnabledDetectors,
  isAdmin,
}: {
  clip: { segment: Segment; offsetSec: number } | null;
  onEnded: () => void;
  /** If provided, draw bounding boxes + class labels on the player
   *  using detections whose ts is near the current video frame. If
   *  undefined, overlay is disabled (default). */
  detections?: HistoricDetection[];
  cameraId: string;
  cameraEnabled?: boolean;
  cameraEnabledDetectors?: string[];
  isAdmin: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const url = clip ? api.segmentFileUrl(clip.segment.id) : "";

  useEffect(() => {
    if (!clip || !ref.current) return;
    const v = ref.current;
    const seek = () => {
      try { v.currentTime = clip.offsetSec; } catch { /* source swap in flight */ }
    };
    if (v.readyState >= 1) seek();
    else v.addEventListener("loadedmetadata", seek, { once: true });
  }, [clip]);

  // Track the video's wall-clock timestamp while it plays so the
  // overlay below can redraw boxes as frames advance. rVFC fires per
  // decoded frame when supported; fallback to a 10Hz rAF-ish timer.
  const [wallMs, setWallMs] = useState<number | null>(null);
  const [videoSize, setVideoSize] = useState<{ w: number; h: number }>({ w: 16, h: 9 });
  useEffect(() => {
    if (!clip || detections === undefined || !ref.current) {
      setWallMs(null);
      return;
    }
    const v = ref.current as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    const segStart = new Date(clip.segment.started_at).getTime();
    let cancelled = false;
    const push = () => {
      if (cancelled) return;
      setWallMs(segStart + v.currentTime * 1000);
    };
    if (typeof v.requestVideoFrameCallback === "function") {
      const step = () => {
        if (cancelled) return;
        push();
        v.requestVideoFrameCallback!(step);
      };
      v.requestVideoFrameCallback!(step);
    } else {
      const h = setInterval(push, 100);
      return () => { cancelled = true; clearInterval(h); };
    }
    return () => { cancelled = true; };
  }, [clip, detections]);

  // Observe intrinsic video size so the overlay can size a matching
  // letterboxed inner frame (same trick Live tiles use).
  useEffect(() => {
    if (!ref.current) return;
    const v = ref.current;
    const update = () => {
      if (v.videoWidth && v.videoHeight) {
        setVideoSize({ w: v.videoWidth, h: v.videoHeight });
      }
    };
    v.addEventListener("loadedmetadata", update);
    update();
    return () => v.removeEventListener("loadedmetadata", update);
  }, [clip]);

  if (!clip) {
    return (
      <div className="h-full flex items-center justify-center text-neutral-500 text-sm">
        Click the timeline to play
      </div>
    );
  }

  // When overlay is on, compute which detections are "current" for
  // the active video frame. Window is ±250ms which covers ~15 fps
  // detection rates and keeps latest boxes visible across skipped
  // frames.
  let active: HistoricDetection[] = [];
  if (detections && wallMs != null) {
    const lo = wallMs - 250;
    const hi = wallMs + 250;
    for (const d of detections) {
      const t = new Date(d.ts).getTime();
      if (t >= lo && t <= hi) active.push(d);
    }
  }

  return (
    <div className="group relative w-full h-full flex items-center justify-center">
      <video
        ref={ref}
        key={clip.segment.id}
        src={url}
        controls
        autoPlay
        playsInline
        onEnded={onEnded}
        className="w-full h-full object-contain bg-black"
      />
      {/* Overlay container mirrors the video's letterboxed content box
          so bbox coords (0..1 of source) land on the actual visible
          pixels, not on the black bars. */}
      {detections !== undefined && active.length > 0 && (
        <PlayerOverlay
          videoRef={ref}
          videoSize={videoSize}
          detections={active}
        />
      )}
      {isAdmin && cameraId && cameraEnabled !== undefined && (
        <div className="absolute top-2 right-2 z-10 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <CameraToggle cameraId={cameraId} enabled={cameraEnabled} variant="overlay" />
          <CameraDetectorChips
            cameraId={cameraId}
            enabledDetectors={cameraEnabledDetectors ?? []}
            disabled={!cameraEnabled}
            variant="overlay"
          />
        </div>
      )}
    </div>
  );
}

function PlayerOverlay({
  videoRef,
  videoSize,
  detections,
}: {
  videoRef: React.RefObject<HTMLVideoElement>;
  videoSize: { w: number; h: number };
  detections: HistoricDetection[];
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

  if (!box) return null;
  return (
    <div
      className="absolute pointer-events-none"
      style={{ left: box.left, top: box.top, width: box.w, height: box.h }}
    >
      {detections.map((d) => (
        <OverlayBox key={d.id} d={d} />
      ))}
    </div>
  );
}

function OverlayBox({ d }: { d: HistoricDetection }) {
  const isPlate = d.kind === "anpr";
  const color = isPlate ? "#22c55e" : overlayColor(d.class_name);
  const label = isPlate
    ? d.attributes?.plate ?? "plate"
    : `${d.class_name} ${(d.confidence * 100).toFixed(0)}%`;
  return (
    <div
      className="absolute"
      style={{
        left: `${d.bbox.x * 100}%`,
        top: `${d.bbox.y * 100}%`,
        width: `${d.bbox.w * 100}%`,
        height: `${d.bbox.h * 100}%`,
        border: `2px solid ${color}`,
        boxShadow: `0 0 0 1px rgba(0,0,0,0.5)`,
      }}
    >
      <div
        className="absolute top-0 left-0 text-[10px] px-1 font-medium leading-tight tabular-nums"
        style={{
          background: color,
          color: "#000",
          transform: "translateY(-100%)",
        }}
      >
        {label}
      </div>
    </div>
  );
}

// Stable per-class colour hash — same scheme as Live tiles so a "car"
// is the same colour in live and in Timeline playback.
function overlayColor(cls: string): string {
  let h = 0;
  for (let i = 0; i < cls.length; i++) h = (h * 31 + cls.charCodeAt(i)) & 0xffffff;
  return `hsl(${h % 360}, 85%, 55%)`;
}

function TimelineRuler({
  from, to, segments, detections, cursorMs, onSeek, zoom, onZoom, onResetZoom, cameraId,
}: {
  from: Date;
  to: Date;
  segments: Segment[];
  detections: HistoricDetection[];
  cursorMs: number | null;
  onSeek: (ms: number) => void;
  zoom: { from: number; to: number };
  onZoom: (z: { from: number; to: number }) => void;
  onResetZoom: () => void;
  cameraId: string;
}) {
  const navigate = useNavigate();
  const dayMs = to.getTime() - from.getTime();
  const ref = useRef<HTMLDivElement>(null);

  // Visible window as a fraction of the day.
  const visFromMs = zoom.from * dayMs;
  const visToMs = zoom.to * dayMs;
  const visMs = visToMs - visFromMs;

  // Now marker ticks every 10s.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(h);
  }, []);
  const nowMsInDay = now - from.getTime();
  const nowInWindow = nowMsInDay >= visFromMs && nowMsInDay < visToMs;
  const nowPct = nowInWindow ? ((nowMsInDay - visFromMs) / visMs) * 100 : 0;

  // Map a Date to a percentage across the visible window (returns null
  // if outside — caller skips rendering).
  const pctOf = (d: Date): number | null => {
    const t = d.getTime() - from.getTime();
    if (t < visFromMs || t > visToMs) return null;
    return ((t - visFromMs) / visMs) * 100;
  };

  // Drag-to-zoom state.
  const dragAnchorRef = useRef<number | null>(null); // clientX at mousedown
  const [dragRange, setDragRange] = useState<{ startX: number; endX: number } | null>(null);

  const clientXToVisFrac = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragAnchorRef.current = e.clientX;
    setDragRange({ startX: e.clientX, endX: e.clientX });
    // Ensure mouseup fires even if the user drags off the element.
    ref.current?.setPointerCapture?.((e as any).pointerId ?? 1);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (dragAnchorRef.current == null) return;
    setDragRange({ startX: dragAnchorRef.current, endX: e.clientX });
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
    const anchor = dragAnchorRef.current;
    dragAnchorRef.current = null;
    setDragRange(null);
    if (anchor == null) return;
    const delta = Math.abs(e.clientX - anchor);
    if (delta < ZOOM_DRAG_THRESHOLD_PX) {
      // Treat as plain click → seek.
      const frac = clientXToVisFrac(e.clientX);
      onSeek(visFromMs + frac * visMs);
      return;
    }
    // Real drag → zoom.
    const a = clientXToVisFrac(anchor);
    const b = clientXToVisFrac(e.clientX);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    // Map visible fraction back to day fraction.
    onZoom({
      from: zoom.from + lo * (zoom.to - zoom.from),
      to: zoom.from + hi * (zoom.to - zoom.from),
    });
  };

  const handleDoubleClick = () => onResetZoom();

  // Hour labels — only show hours that fall in the visible window, and
  // prune density if zoomed tight (e.g. < 2h visible shows every minute).
  const hourTicks = useMemo(() => {
    const out: { ms: number; label: string }[] = [];
    // Always show 25 hours worth (00..24). Filter out those outside the
    // visible window.
    for (let h = 0; h <= 24; h++) {
      const ms = h * 3600_000;
      if (ms < visFromMs || ms > visToMs) continue;
      out.push({ ms, label: h.toString().padStart(2, "0") });
    }
    return out;
  }, [visFromMs, visToMs]);

  const jumpToLive = () => {
    navigate(`/live?camera=${encodeURIComponent(cameraId)}`);
  };

  return (
    <div className="select-none">
      <div
        ref={ref}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onDoubleClick={handleDoubleClick}
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
        {hourTicks.map((tick) => {
          const p = ((tick.ms - visFromMs) / visMs) * 100;
          return (
            <div
              key={tick.ms}
              className="absolute top-0 bottom-3 border-l border-neutral-800 text-[10px] text-neutral-600 pl-1 pointer-events-none"
              style={{ left: `${p}%` }}
            >
              {tick.label}
            </div>
          );
        })}
        {/* segments */}
        {segments.map((s) => {
          const start = new Date(s.started_at);
          const end = s.ended_at
            ? new Date(s.ended_at)
            : new Date(start.getTime() + (s.duration_ms ?? estimateDurMs(s)));
          const startMs = start.getTime() - from.getTime();
          const endMs = end.getTime() - from.getTime();
          // Clip to visible window
          const clipLo = Math.max(startMs, visFromMs);
          const clipHi = Math.min(endMs, visToMs);
          if (clipHi <= clipLo) return null;
          const left = ((clipLo - visFromMs) / visMs) * 100;
          const right = ((clipHi - visFromMs) / visMs) * 100;
          return (
            <div
              key={s.id}
              className="absolute bg-blue-600/60 hover:bg-blue-500/80 pointer-events-none"
              style={{ left: `${left}%`, width: `${right - left}%`, top: "18%", height: "22%" }}
              title={`${start.toLocaleTimeString()} → ${end.toLocaleTimeString()}`}
            />
          );
        })}
        {/* detection pins — now clickable */}
        {detections.map((d) => {
          const t = new Date(d.ts);
          const p = pctOf(t);
          if (p == null) return null;
          const offsetMs = t.getTime() - from.getTime();
          return (
            <button
              key={d.id}
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onMouseUp={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onSeek(offsetMs);
              }}
              className="absolute p-0 border-0 bg-transparent cursor-pointer"
              style={{ left: `${p}%`, top: "60%", height: "25%", width: "6px", transform: "translateX(-3px)" }}
              title={`${t.toLocaleTimeString()} · ${d.class_name} ${(d.confidence * 100).toFixed(0)}% — click to seek`}
            >
              <span className="block mx-auto w-0.5 h-full bg-amber-400/80 hover:bg-amber-300" />
            </button>
          );
        })}
        {/* cursor */}
        {cursorMs != null && (() => {
          if (cursorMs < visFromMs || cursorMs > visToMs) return null;
          const p = ((cursorMs - visFromMs) / visMs) * 100;
          return (
            <div
              className="absolute top-0 bottom-0 w-px bg-red-500 pointer-events-none"
              style={{ left: `${p}%` }}
            />
          );
        })()}
        {/* drag-to-zoom selection rectangle */}
        {dragRange && (() => {
          const r = ref.current?.getBoundingClientRect();
          if (!r) return null;
          const lo = Math.min(dragRange.startX, dragRange.endX) - r.left;
          const hi = Math.max(dragRange.startX, dragRange.endX) - r.left;
          return (
            <div
              className="absolute top-0 bottom-0 bg-blue-400/20 border-x border-blue-400/60 pointer-events-none"
              style={{ left: `${lo}px`, width: `${hi - lo}px` }}
            />
          );
        })()}
        {/* "now" marker — clickable; navigates to /live */}
        {nowInWindow && (
          <>
            <div
              className="absolute top-0 bottom-0 w-px bg-emerald-400 pointer-events-none"
              style={{ left: `${nowPct}%` }}
              title={`now · ${new Date(now).toLocaleTimeString()}`}
            />
            <button
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onMouseUp={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                jumpToLive();
              }}
              className="absolute top-0 text-[10px] bg-emerald-500/90 hover:bg-emerald-400 text-black px-1 rounded-sm -translate-x-1/2 tabular-nums cursor-pointer border-0"
              style={{ left: `${nowPct}%` }}
              title="Click to open the live view for this camera"
            >
              now ▸
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function todayKey(): string {
  return dayKeyFrom(new Date());
}
function dayKeyFrom(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function pad(n: number): string { return n < 10 ? `0${n}` : `${n}`; }
function dayRange(key: string): { from: Date; to: Date } {
  const [y, m, d] = key.split("-").map(Number);
  const from = new Date(y, m - 1, d, 0, 0, 0, 0);
  const to = new Date(y, m - 1, d + 1, 0, 0, 0, 0);
  return { from, to };
}
function dayRangeMs(from: Date, to: Date): number {
  return to.getTime() - from.getTime();
}
// Render an ms-into-day value as HH:MM local. Used in the zoom chip.
function msToHHMM(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${pad(h)}:${pad(m)}`;
}
// estimateDurMs is a last-resort fallback when a segment has neither
// ended_at nor duration_ms (storage-manager now tracks both from file
// mtime, so this almost never runs). Matches the pipeline's H.264
// encoder bitrate — 6 Mbps ≈ 750 KB/s → bytes/750000 ≈ seconds.
function estimateDurMs(s: Segment): number {
  if (!s.bytes) return 60_000;
  const sec = Math.min(3600, Math.max(10, s.bytes / 750_000));
  return sec * 1000;
}

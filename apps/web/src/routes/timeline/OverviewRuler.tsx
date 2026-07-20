import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Camera, DetectionSummary, Incident, Segment } from "@/lib/api";
import { severityBg, severityColor } from "@/lib/severity";
import { estimateDurMs, hourTicks, msToHHMMSS } from "./timeMath";
import {
  coalesceSpans,
  fleetP95,
  incidentSpan,
  laneBuckets,
  laneGeometry,
  laneIndexFromYPct,
} from "./overviewLogic";
import { useTimelinePointer } from "./useTimelinePointer";

// All-cameras overview ruler: one compact lane per camera, sharing the
// detail ruler's time axis, zoom and pointer semantics. Per lane:
// muted recording strip, fleet-normalised density bars, prominent
// severity-coloured incident markers. Click in a lane = focus that
// camera + seek (stays in overview); the lane label drills into the
// per-camera detail view with cursor + zoom preserved.

const HEADER_PCT = 8;
const MERGE_FACTOR = 3; // 288 → ≤96 density cells per lane

export function OverviewRuler({
  from,
  to,
  cameras,
  segmentsByCamera,
  incidents,
  summariesByCamera,
  focusCameraId,
  cursorMs,
  zoom,
  hoveredIncidentId,
  onZoom,
  onResetZoom,
  onLaneSeek,
  onDrillToCamera,
  onSelectIncident,
  onHoverIncident,
}: {
  from: Date;
  to: Date;
  cameras: Camera[];
  segmentsByCamera: Map<string, Segment[]>;
  incidents: Incident[];
  summariesByCamera: Map<string, DetectionSummary | undefined>;
  focusCameraId: string | null;
  cursorMs: number | null;
  zoom: { from: number; to: number };
  hoveredIncidentId: string | null;
  onZoom: (z: { from: number; to: number }) => void;
  onResetZoom: () => void;
  onLaneSeek: (cameraId: string, ms: number) => void;
  onDrillToCamera: (cameraId: string) => void;
  onSelectIncident: (inc: Incident) => void;
  onHoverIncident: (id: string | null) => void;
}) {
  const navigate = useNavigate();
  const dayMs = to.getTime() - from.getTime();
  const fromMs = from.getTime();
  const ref = useRef<HTMLDivElement>(null);

  const visFromMs = zoom.from * dayMs;
  const visToMs = zoom.to * dayMs;
  const visMs = visToMs - visFromMs;

  const [containerW, setContainerW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerW(el.clientWidth));
    ro.observe(el);
    setContainerW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(h);
  }, []);
  const nowMsInDay = now - fromMs;
  const nowInWindow = nowMsInDay >= visFromMs && nowMsInDay < visToMs;
  const nowPct = nowInWindow ? ((nowMsInDay - visFromMs) / visMs) * 100 : 0;

  const lanes = useMemo(() => laneGeometry(cameras.length, HEADER_PCT), [cameras.length]);

  const spanPct = (startMs: number, endMs: number): { left: number; width: number } | null => {
    const lo = Math.max(startMs, visFromMs);
    const hi = Math.min(endMs, visToMs);
    if (hi <= lo) return null;
    return { left: ((lo - visFromMs) / visMs) * 100, width: ((hi - lo) / visMs) * 100 };
  };

  // Per-lane render lists.
  const coverage = useMemo(() => {
    return cameras.map((c) => {
      const segs = segmentsByCamera.get(c.id) ?? [];
      const spans = segs.map((s) => {
        const start = new Date(s.started_at).getTime();
        const end = s.ended_at
          ? new Date(s.ended_at).getTime()
          : start + (s.duration_ms ?? estimateDurMs(s));
        return { startMs: start - fromMs, endMs: end - fromMs };
      });
      return coalesceSpans(spans, 2000).flatMap((sp) => {
        const pct = spanPct(sp.startMs, sp.endMs);
        return pct ? [{ ...sp, ...pct }] : [];
      });
    });
  }, [cameras, segmentsByCamera, fromMs, visFromMs, visMs]);

  const density = useMemo(() => {
    const perLane = cameras.map((c) =>
      laneBuckets(summariesByCamera.get(c.id), fromMs, MERGE_FACTOR),
    );
    const p95 = fleetP95(perLane.map((l) => l.map((x) => x.bucket)));
    return perLane.map((lane) =>
      lane.flatMap((cell) => {
        const pct = spanPct(cell.startMs, cell.endMs);
        if (!pct) return [];
        const scale = Math.min(1, cell.bucket.count / p95);
        return [{ ...cell, scale, ...pct }];
      }),
    );
  }, [cameras, summariesByCamera, fromMs, visFromMs, visMs]);

  const incMarkers = useMemo(() => {
    const laneIdxByCam = new Map(cameras.map((c, i) => [c.id, i]));
    return incidents.flatMap((inc) => {
      const lane = inc.camera_id != null ? laneIdxByCam.get(inc.camera_id) : undefined;
      if (lane == null) return [];
      const span = incidentSpan(inc, fromMs);
      const minMs = (8 / Math.max(containerW, 1)) * visMs;
      const pct = spanPct(span.startMs, Math.max(span.endMs, span.startMs + minMs));
      return pct ? [{ inc, lane, ...span, ...pct }] : [];
    });
  }, [incidents, cameras, fromMs, visFromMs, visMs, containerW]);

  const ticks = useMemo(
    () => hourTicks(from, to).filter((t) => t.ms >= visFromMs && t.ms <= visToMs),
    [from, to, visFromMs, visToMs],
  );

  const { hover, dragRange, containerHandlers } = useTimelinePointer({
    ref,
    visFromMs,
    visMs,
    zoom,
    onZoom,
    onClickMs: (ms, yPct) => {
      const lane = laneIndexFromYPct(yPct, cameras.length, HEADER_PCT);
      const cam = lane != null ? cameras[lane] : null;
      if (cam) onLaneSeek(cam.id, ms);
    },
  });

  // Hover resolution: which lane + what's under the pointer.
  const hovered = useMemo(() => {
    if (!hover || !ref.current) return null;
    const h = ref.current.clientHeight || 1;
    const yPct = (hover.y / h) * 100;
    const lane = laneIndexFromYPct(yPct, cameras.length, HEADER_PCT);
    if (lane == null) return null;
    const pct = (hover.x / Math.max(containerW, 1)) * 100;
    const at = <T extends { left: number; width: number }>(list: T[]): T | undefined =>
      list.find((s) => pct >= s.left && pct <= s.left + s.width);
    const cam = cameras[lane];
    const inc = incMarkers.find(
      (m) => m.lane === lane && pct >= m.left && pct <= m.left + m.width,
    );
    if (inc) return { kind: "incident" as const, ...inc, lane, cam };
    const cell = at(density[lane] ?? []);
    if (cell) return { kind: "bucket" as const, lane, cam, ...cell };
    const cov = at(coverage[lane] ?? []);
    if (cov) return { kind: "coverage" as const, lane, cam, ...cov };
    return { kind: "lane" as const, lane, cam };
  }, [hover, containerW, cameras, incMarkers, density, coverage]);

  useEffect(() => {
    onHoverIncident(hovered?.kind === "incident" ? hovered.inc.id : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hovered?.kind === "incident" ? hovered.inc.id : null]);

  const stopMouse = (e: React.MouseEvent) => e.stopPropagation();
  const cursorInWindow = cursorMs != null && cursorMs >= visFromMs && cursorMs <= visToMs;

  return (
    <div className="select-none">
      <div
        ref={ref}
        {...containerHandlers}
        onDoubleClick={onResetZoom}
        className="relative h-64 bg-neutral-900 rounded cursor-crosshair overflow-hidden"
      >
        {/* hour grid (labels live in the header band) */}
        {ticks.map((tick) => {
          const p = ((tick.ms - visFromMs) / visMs) * 100;
          return (
            <div
              key={tick.ms}
              className="absolute top-0 bottom-0 border-l border-neutral-800 text-[10px] text-neutral-600 pl-1 pointer-events-none"
              style={{ left: `${p}%` }}
            >
              {tick.label}
            </div>
          );
        })}

        {/* lanes */}
        {cameras.map((cam, i) => {
          const g = lanes[i];
          const active = cam.id === focusCameraId;
          return (
            <div
              key={cam.id}
              className={`absolute inset-x-0 pointer-events-none ${
                active ? "bg-neutral-800/50" : ""
              } ${i > 0 ? "border-t border-neutral-800/60" : ""}`}
              style={{ top: `${g.topPct}%`, height: `${g.heightPct}%` }}
            >
              {active && <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-emerald-400" />}
              <button
                type="button"
                onMouseDown={stopMouse}
                onMouseUp={stopMouse}
                onClick={(e) => {
                  e.stopPropagation();
                  onDrillToCamera(cam.id);
                }}
                title={`Open ${cam.name} in detail view (cursor + zoom preserved)`}
                className={`absolute left-1.5 top-1/2 -translate-y-1/2 z-10 text-[10px] px-1 rounded pointer-events-auto cursor-pointer border-0 bg-neutral-900/80 group ${
                  active ? "text-white" : "text-neutral-500 hover:text-white"
                }`}
              >
                {cam.name}
                <span className="hidden group-hover:inline text-emerald-400"> →</span>
              </button>
            </div>
          );
        })}

        {/* per-lane content: coverage → density → incidents */}
        {cameras.map((cam, i) => {
          const g = lanes[i];
          return (
            <div key={cam.id} className="contents">
              {coverage[i]?.map((sp, j) => (
                <div
                  key={`c${j}`}
                  className="absolute bg-blue-600/25 pointer-events-none rounded-sm"
                  style={{
                    left: `${sp.left}%`,
                    width: `${sp.width}%`,
                    top: `${g.topPct + g.heightPct * 0.15}%`,
                    height: `${g.heightPct * 0.7}%`,
                  }}
                />
              ))}
              {density[i]?.map((cell, j) => {
                const hFrac = 0.7 * (0.3 + 0.7 * Math.sqrt(cell.scale));
                return (
                  <div
                    key={`d${j}`}
                    className="absolute bg-amber-400 pointer-events-none rounded-sm"
                    style={{
                      left: `${cell.left}%`,
                      width: `${Math.max(cell.width, 0.1)}%`,
                      top: `${g.topPct + g.heightPct * (0.85 - hFrac)}%`,
                      height: `${g.heightPct * hFrac}%`,
                      opacity: 0.25 + 0.75 * cell.scale,
                    }}
                  />
                );
              })}
            </div>
          );
        })}
        {incMarkers.map((m) => {
          const g = lanes[m.lane];
          const highlighted = m.inc.id === hoveredIncidentId;
          return (
            <button
              key={m.inc.id}
              type="button"
              onMouseDown={stopMouse}
              onMouseUp={stopMouse}
              onClick={(e) => {
                e.stopPropagation();
                onSelectIncident(m.inc);
              }}
              className={`absolute rounded-sm border-0 cursor-pointer p-0 z-10 ${severityBg(
                m.inc.severity,
              )} ${highlighted ? "ring-1 ring-white/80" : ""}`}
              style={{
                left: `${m.left}%`,
                width: `${m.width}%`,
                minWidth: "6px",
                top: `${g.topPct + g.heightPct * 0.18}%`,
                height: `${g.heightPct * 0.64}%`,
              }}
              title={`${m.inc.classes.join(" + ")} ×${m.inc.detection_count}`}
            />
          );
        })}

        {/* cursor */}
        {cursorInWindow && (
          <div
            className="absolute top-0 bottom-0 w-px bg-red-500 pointer-events-none"
            style={{ left: `${((cursorMs! - visFromMs) / visMs) * 100}%` }}
          />
        )}

        {/* drag-to-zoom rectangle */}
        {dragRange &&
          (() => {
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

        {/* now marker */}
        {nowInWindow && (
          <>
            <div
              className="absolute top-0 bottom-0 w-px bg-emerald-400 pointer-events-none"
              style={{ left: `${nowPct}%` }}
            />
            <button
              type="button"
              onMouseDown={stopMouse}
              onMouseUp={stopMouse}
              onClick={(e) => {
                e.stopPropagation();
                const cam = focusCameraId ?? cameras[0]?.id ?? "";
                navigate(`/live?camera=${encodeURIComponent(cam)}`);
              }}
              className="absolute top-0 text-[10px] bg-emerald-500/90 hover:bg-emerald-400 text-black px-1 rounded-sm -translate-x-1/2 tabular-nums cursor-pointer border-0 z-10"
              style={{ left: `${nowPct}%` }}
              title="Click to open the live view"
            >
              now ▸
            </button>
          </>
        )}

        {/* hover readout + lean card */}
        {hover && !dragRange && (
          <>
            <div
              className="absolute top-0.5 -translate-x-1/2 bg-neutral-800 border border-neutral-700 rounded px-1 text-[10px] tabular-nums text-neutral-200 pointer-events-none z-20"
              style={{
                left: `${Math.min(Math.max(hover.x, 40), Math.max(containerW - 40, 40))}px`,
              }}
            >
              {msToHHMMSS(hover.ms)}
            </div>
            {hovered && (
              <div
                className="absolute -translate-x-1/2 bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs text-neutral-200 pointer-events-none z-20 shadow-lg max-w-64"
                style={{
                  left: `${Math.min(Math.max(hover.x, 100), Math.max(containerW - 100, 100))}px`,
                  top: "18px",
                }}
              >
                <div className="font-medium">{hovered.cam.name}</div>
                {hovered.kind === "incident" && (
                  <>
                    <div>
                      <span className={severityColor(hovered.inc.severity)}>● </span>
                      {hovered.inc.classes.join(" + ")} ×{hovered.inc.detection_count}
                    </div>
                    <div className="text-neutral-400 tabular-nums">
                      {msToHHMMSS(hovered.startMs)} → {msToHHMMSS(hovered.endMs)}
                    </div>
                    <div className="text-neutral-500">click to play from start</div>
                  </>
                )}
                {hovered.kind === "bucket" && (
                  <>
                    <div className="text-neutral-400">{hovered.bucket.count} detections</div>
                    <div className="text-neutral-500">
                      {hovered.bucket.top_classes.map((c) => `${c.class} ${c.count}`).join(" + ")}
                    </div>
                  </>
                )}
                {hovered.kind === "coverage" && (
                  <div className="text-neutral-400 tabular-nums">
                    recording {msToHHMMSS(hovered.startMs)} → {msToHHMMSS(hovered.endMs)}
                  </div>
                )}
                {hovered.kind === "lane" && (
                  <div className="text-neutral-500">click to play here</div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

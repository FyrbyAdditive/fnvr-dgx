import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { DetectionSummary, HistoricDetection, Incident, Segment } from "@/lib/api";
import { estimateDurMs, hourTicks, msToHHMMSS } from "./timeMath";

// Three-band day ruler:
//   A  recording — blue segment coverage bars
//   B  events    — clickable incident spans, severity-coloured
//   C  activity  — full-day: server-aggregated density buckets;
//                  zoomed ≤2h: per-track detection runs
// One container-level hover model drives an HH:MM:SS readout and a
// single hover card for whichever band the pointer is over — the
// bars themselves stay pointer-transparent so drag-zoom never fights
// them (incident/run buttons are the exception; they stopPropagation
// on mousedown/up only, so click seeks but drag still zooms).

const ZOOM_DRAG_THRESHOLD_PX = 6;
const RUN_GAP_MS = 4_000; // track-run split threshold
const RUN_LANES = 4;

// Band geometry, % of container height.
const BAND_A = { top: 12, height: 18 };
const BAND_B = { top: 36, height: 26 };
const BAND_C = { top: 68, height: 24 };

const SEVERITY_BG: Record<Incident["severity"], string> = {
  critical: "bg-red-500/70 hover:bg-red-400/80",
  warning: "bg-amber-400/70 hover:bg-amber-300/80",
  info: "bg-blue-400/70 hover:bg-blue-300/80",
};

type Run = {
  startMs: number;
  endMs: number;
  classes: Set<string>;
  count: number;
  confLo: number;
  confHi: number;
  /** First positive (PG-backed) row id — resolvable to an object
   *  thumbnail. Sidecar rows have synthetic negative ids. */
  thumbId: number | null;
  lane: number;
};

type Hover = { x: number; y: number; ms: number };

export function Ruler({
  from,
  to,
  segments,
  incidents,
  summary,
  windowDetections,
  cursorMs,
  onSeek,
  onSelectIncident,
  zoom,
  onZoom,
  onResetZoom,
  cameraId,
}: {
  from: Date;
  to: Date;
  segments: Segment[];
  incidents: Incident[];
  summary?: DetectionSummary;
  /** Raw rows for the visible window; only passed when zoomed ≤ 2h —
   *  its presence switches band C from buckets to track runs. */
  windowDetections?: HistoricDetection[];
  cursorMs: number | null;
  /** ms into the day. The Ruler floors clicks to whole seconds before
   *  calling this, so playback URLs carry clean second-aligned starts. */
  onSeek: (ms: number) => void;
  onSelectIncident?: (inc: Incident) => void;
  zoom: { from: number; to: number };
  onZoom: (z: { from: number; to: number }) => void;
  onResetZoom: () => void;
  cameraId: string;
}) {
  const navigate = useNavigate();
  const dayMs = to.getTime() - from.getTime();
  const fromMs = from.getTime();
  const ref = useRef<HTMLDivElement>(null);

  // Visible window as ms-into-day.
  const visFromMs = zoom.from * dayMs;
  const visToMs = zoom.to * dayMs;
  const visMs = visToMs - visFromMs;

  // Container pixel width — drives "is this span wide enough for an
  // inline label" decisions.
  const [containerW, setContainerW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerW(el.clientWidth));
    ro.observe(el);
    setContainerW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Now marker ticks every 10s.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(h);
  }, []);
  const nowMsInDay = now - fromMs;
  const nowInWindow = nowMsInDay >= visFromMs && nowMsInDay < visToMs;
  const nowPct = nowInWindow ? ((nowMsInDay - visFromMs) / visMs) * 100 : 0;

  // ---- geometry helpers -------------------------------------------------

  /** Clip an [startMs, endMs] span (ms into day) to the visible window
   *  and return percentages, or null when fully outside. */
  const spanPct = (startMs: number, endMs: number): { left: number; width: number } | null => {
    const lo = Math.max(startMs, visFromMs);
    const hi = Math.min(endMs, visToMs);
    if (hi <= lo) return null;
    return {
      left: ((lo - visFromMs) / visMs) * 100,
      width: ((hi - lo) / visMs) * 100,
    };
  };

  const clientXToMs = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return visFromMs + frac * visMs;
  };

  // ---- render lists -----------------------------------------------------

  const segSpans = useMemo(() => {
    return segments.flatMap((s) => {
      const start = new Date(s.started_at);
      const end = s.ended_at
        ? new Date(s.ended_at)
        : new Date(start.getTime() + (s.duration_ms ?? estimateDurMs(s)));
      const startMs = start.getTime() - fromMs;
      const endMs = end.getTime() - fromMs;
      const pct = spanPct(startMs, endMs);
      return pct ? [{ seg: s, startMs, endMs, ...pct }] : [];
    });
  }, [segments, fromMs, visFromMs, visMs]);

  const incSpans = useMemo(() => {
    return incidents.flatMap((inc) => {
      const startMs = new Date(inc.started_at).getTime() - fromMs;
      const endMs = new Date(inc.last_detection_at).getTime() - fromMs;
      // Enforce a minimum clickable width in *time* so hit-testing and
      // rendering agree: at least 10px worth of window.
      const minMs = (10 / Math.max(containerW, 1)) * visMs;
      const pct = spanPct(startMs, Math.max(endMs, startMs + minMs));
      return pct ? [{ inc, startMs, endMs, ...pct }] : [];
    });
  }, [incidents, fromMs, visFromMs, visMs, containerW]);

  // Activity buckets, positioned from the summary's own window (the
  // debounced fetch can briefly lag the zoom — absolute anchoring
  // keeps bars honest while it catches up).
  const buckets = useMemo(() => {
    if (!summary || summary.buckets.length === 0) return [];
    const sumFromMs = Date.parse(summary.from) - fromMs;
    const sumToMs = Date.parse(summary.to) - fromMs;
    // Reconstruct the requested bucket count (bucket_ms is floored).
    const n = Math.max(1, Math.round((sumToMs - sumFromMs) / summary.bucket_ms));
    const span = (sumToMs - sumFromMs) / n;
    const counts = summary.buckets.map((b) => b.count).sort((a, b) => a - b);
    const p95 = Math.max(1, counts[Math.floor(0.95 * (counts.length - 1))]);
    return summary.buckets.flatMap((b) => {
      const startMs = sumFromMs + b.i * span;
      const pct = spanPct(startMs, startMs + span);
      if (!pct) return [];
      const scale = Math.min(1, b.count / p95);
      return [{ b, startMs, endMs: startMs + span, scale, ...pct }];
    });
  }, [summary, fromMs, visFromMs, visMs]);

  const runs = useMemo(() => {
    if (!windowDetections) return [];
    return buildRuns(windowDetections, fromMs);
  }, [windowDetections, fromMs]);

  const runSpans = useMemo(() => {
    return runs.flatMap((run) => {
      const minMs = (12 / Math.max(containerW, 1)) * visMs; // ≥12px targets
      const pct = spanPct(run.startMs, Math.max(run.endMs, run.startMs + minMs));
      return pct ? [{ run, ...pct }] : [];
    });
  }, [runs, visFromMs, visMs, containerW]);

  const ticks = useMemo(
    () => hourTicks(from, to).filter((t) => t.ms >= visFromMs && t.ms <= visToMs),
    [from, to, visFromMs, visToMs],
  );

  // ---- hover model ------------------------------------------------------

  const [hover, setHover] = useState<Hover | null>(null);

  const hovered = useMemo(() => {
    if (!hover || !ref.current) return null;
    const h = ref.current.clientHeight || 1;
    const yPct = (hover.y / h) * 100;
    const pct = (hover.x / Math.max(containerW, 1)) * 100;
    const within = (band: { top: number; height: number }) =>
      yPct >= band.top && yPct <= band.top + band.height;
    const at = <T extends { left: number; width: number }>(list: T[]): T | undefined =>
      list.find((s) => pct >= s.left && pct <= s.left + s.width);
    if (within(BAND_A)) {
      const s = at(segSpans);
      if (s) return { kind: "segment" as const, ...s };
    }
    if (within(BAND_B)) {
      const s = at(incSpans);
      if (s) return { kind: "incident" as const, ...s };
    }
    if (within(BAND_C)) {
      if (windowDetections) {
        const s = at(runSpans);
        if (s) return { kind: "run" as const, ...s };
      } else {
        const s = at(buckets);
        if (s) return { kind: "bucket" as const, ...s };
      }
    }
    return null;
  }, [hover, containerW, segSpans, incSpans, buckets, runSpans, windowDetections]);

  // ---- drag-to-zoom / click-to-seek ------------------------------------

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

  const handleMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
    const anchor = dragAnchorRef.current;
    dragAnchorRef.current = null;
    setDragRange(null);
    if (anchor == null) return;
    const delta = Math.abs(e.clientX - anchor);
    if (delta < ZOOM_DRAG_THRESHOLD_PX) {
      // Plain click → seek, floored to a whole second so the playback
      // request starts exactly where the readout said.
      onSeek(Math.floor(clientXToMs(e.clientX) / 1000) * 1000);
      return;
    }
    // Real drag → zoom.
    const a = clientXToVisFrac(anchor);
    const b = clientXToVisFrac(e.clientX);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    onZoom({
      from: zoom.from + lo * (zoom.to - zoom.from),
      to: zoom.from + hi * (zoom.to - zoom.from),
    });
  };

  const handleMouseLeave = () => {
    setHover(null);
    // A drag that leaves the element ends without zooming; state must
    // not stick.
    dragAnchorRef.current = null;
    setDragRange(null);
  };

  const stopMouse = (e: React.MouseEvent) => e.stopPropagation();

  const seekIncident = (inc: Incident) => {
    const ms = new Date(inc.started_at).getTime() - fromMs;
    onSeek(Math.max(0, Math.floor(ms / 1000) * 1000));
    onSelectIncident?.(inc);
  };

  const cursorAbs = cursorMs != null ? fromMs + cursorMs : null;

  const hasActivity = (summary?.buckets.length ?? 0) > 0 || (windowDetections?.length ?? 0) > 0;

  return (
    <div className="select-none">
      <div
        ref={ref}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onDoubleClick={onResetZoom}
        className="relative h-36 bg-neutral-900 rounded cursor-crosshair overflow-hidden"
      >
        {/* row labels */}
        {[
          { band: BAND_A, label: "recording" },
          { band: BAND_B, label: "events" },
          { band: BAND_C, label: "activity" },
        ].map(({ band, label }) => (
          <div
            key={label}
            className="absolute left-1 -translate-y-1/2 text-[10px] text-neutral-500 pointer-events-none z-10"
            style={{ top: `${band.top + band.height / 2}%` }}
          >
            {label}
          </div>
        ))}

        {/* hour grid */}
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

        {/* band A — recording coverage */}
        {segSpans.map((s) => (
          <div
            key={s.seg.id}
            className="absolute bg-blue-600/60 pointer-events-none rounded-sm"
            style={{
              left: `${s.left}%`,
              width: `${s.width}%`,
              top: `${BAND_A.top}%`,
              height: `${BAND_A.height}%`,
            }}
          />
        ))}

        {/* band B — incident spans */}
        {incSpans.map((s) => {
          const active =
            cursorAbs != null &&
            cursorAbs >= s.startMs + fromMs &&
            cursorAbs <= Math.max(s.endMs, s.startMs) + fromMs;
          const widthPx = (s.width / 100) * containerW;
          const label = `${s.inc.classes.join(" + ")} ×${s.inc.detection_count}`;
          return (
            <button
              key={s.inc.id}
              type="button"
              onMouseDown={stopMouse}
              onMouseUp={stopMouse}
              onClick={(e) => {
                e.stopPropagation();
                seekIncident(s.inc);
              }}
              className={`absolute rounded-sm border-0 cursor-pointer overflow-hidden whitespace-nowrap text-[10px] text-black/90 px-1 text-left ${
                SEVERITY_BG[s.inc.severity] ?? SEVERITY_BG.info
              } ${active ? "ring-1 ring-white/80" : ""}`}
              style={{
                left: `${s.left}%`,
                width: `${s.width}%`,
                minWidth: "10px",
                top: `${BAND_B.top}%`,
                height: `${BAND_B.height}%`,
              }}
            >
              {widthPx >= 64 ? label : ""}
            </button>
          );
        })}
        {incidents.length === 0 && hasActivity && (
          <div
            className="absolute inset-x-0 flex items-center justify-center text-[11px] text-neutral-500 pointer-events-none"
            style={{ top: `${BAND_B.top}%`, height: `${BAND_B.height}%` }}
          >
            <span className="pointer-events-auto" onMouseDown={stopMouse} onMouseUp={stopMouse}>
              no events — detections become events when a rule matches ·{" "}
              <button
                type="button"
                className="underline hover:text-neutral-300 cursor-pointer bg-transparent border-0 p-0 text-[11px]"
                onClick={(e) => {
                  e.stopPropagation();
                  navigate("/rules");
                }}
              >
                Rules →
              </button>
            </span>
          </div>
        )}

        {/* band C — activity: density buckets (full view) or track runs (zoomed) */}
        {!windowDetections &&
          buckets.map((b) => {
            const hPct = BAND_C.height * (0.3 + 0.7 * Math.sqrt(b.scale));
            return (
              <div
                key={b.b.i}
                className="absolute bg-amber-400 pointer-events-none rounded-sm"
                style={{
                  left: `${b.left}%`,
                  width: `${Math.max(b.width, 0.1)}%`,
                  top: `${BAND_C.top + BAND_C.height - hPct}%`,
                  height: `${hPct}%`,
                  opacity: 0.25 + 0.75 * b.scale,
                }}
              />
            );
          })}
        {windowDetections &&
          runSpans.map((s, idx) => {
            const laneH = BAND_C.height / RUN_LANES;
            return (
              <button
                key={idx}
                type="button"
                onMouseDown={stopMouse}
                onMouseUp={stopMouse}
                onClick={(e) => {
                  e.stopPropagation();
                  onSeek(Math.max(0, Math.floor(s.run.startMs / 1000) * 1000));
                }}
                className="absolute bg-amber-400/80 hover:bg-amber-300 rounded-sm border-0 cursor-pointer p-0"
                style={{
                  left: `${s.left}%`,
                  width: `${s.width}%`,
                  minWidth: "12px",
                  top: `${BAND_C.top + s.run.lane * laneH + laneH * 0.15}%`,
                  height: `${laneH * 0.7}%`,
                }}
              />
            );
          })}

        {/* cursor */}
        {cursorMs != null && cursorMs >= visFromMs && cursorMs <= visToMs && (
          <div
            className="absolute top-0 bottom-0 w-px bg-red-500 pointer-events-none"
            style={{ left: `${((cursorMs - visFromMs) / visMs) * 100}%` }}
          />
        )}

        {/* drag-to-zoom selection rectangle */}
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

        {/* "now" marker — clickable; navigates to /live */}
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
                navigate(`/live?camera=${encodeURIComponent(cameraId)}`);
              }}
              className="absolute top-0 text-[10px] bg-emerald-500/90 hover:bg-emerald-400 text-black px-1 rounded-sm -translate-x-1/2 tabular-nums cursor-pointer border-0 z-10"
              style={{ left: `${nowPct}%` }}
              title="Click to open the live view for this camera"
            >
              now ▸
            </button>
          </>
        )}

        {/* hover readout + card */}
        {hover && !dragRange && (
          <HoverInfo hover={hover} hovered={hovered} containerW={containerW} />
        )}
      </div>
    </div>
  );
}

// ---- hover card ---------------------------------------------------------

function HoverInfo({
  hover,
  hovered,
  containerW,
}: {
  hover: Hover;
  hovered:
    | ({ kind: "segment"; seg: Segment; startMs: number; endMs: number })
    | ({ kind: "incident"; inc: Incident; startMs: number; endMs: number })
    | ({ kind: "bucket"; b: DetectionSummary["buckets"][number]; startMs: number; endMs: number })
    | ({ kind: "run"; run: Run })
    | null;
  containerW: number;
}) {
  const clampedX = Math.min(Math.max(hover.x, 40), Math.max(containerW - 40, 40));
  return (
    <>
      {/* time readout follows the pointer — what you see is the exact
          second a click will seek to */}
      <div
        className="absolute top-0.5 -translate-x-1/2 bg-neutral-800 border border-neutral-700 rounded px-1 text-[10px] tabular-nums text-neutral-200 pointer-events-none z-20"
        style={{ left: `${clampedX}px` }}
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
          {hovered.kind === "segment" && (
            <>
              <div className="font-medium">recording</div>
              <div className="text-neutral-400 tabular-nums">
                {msToHHMMSS(hovered.startMs)} → {msToHHMMSS(hovered.endMs)}
                {hovered.seg.bytes ? ` · ${fmtBytes(hovered.seg.bytes)}` : ""}
              </div>
            </>
          )}
          {hovered.kind === "incident" && (
            <>
              <div className="font-medium">
                <span
                  className={
                    hovered.inc.severity === "critical"
                      ? "text-red-400"
                      : hovered.inc.severity === "warning"
                        ? "text-amber-300"
                        : "text-blue-300"
                  }
                >
                  ●{" "}
                </span>
                {hovered.inc.classes.join(" + ")} ×{hovered.inc.detection_count}
              </div>
              <div className="text-neutral-400 tabular-nums">
                {msToHHMMSS(hovered.startMs)} → {msToHHMMSS(Math.max(hovered.endMs, hovered.startMs))}
              </div>
              {hovered.inc.summary && (
                <div className="text-neutral-400 truncate">{hovered.inc.summary}</div>
              )}
              <div className="text-neutral-500">click to play from start</div>
            </>
          )}
          {hovered.kind === "bucket" && (
            <>
              <div className="font-medium">{hovered.b.count} detections</div>
              <div className="text-neutral-400">
                {hovered.b.top_classes.map((c) => `${c.class} ${c.count}`).join(" + ")}
              </div>
              {hovered.b.kinds.some((k) => k !== "object") && (
                <div className="text-neutral-500">{hovered.b.kinds.join(", ")}</div>
              )}
            </>
          )}
          {hovered.kind === "run" && (
            <>
              <div className="font-medium">
                {[...hovered.run.classes].join(" + ")} ×{hovered.run.count}
              </div>
              <div className="text-neutral-400 tabular-nums">
                {msToHHMMSS(hovered.run.startMs)} ·{" "}
                {Math.max(1, Math.round((hovered.run.endMs - hovered.run.startMs) / 1000))}s ·{" "}
                {Math.round(hovered.run.confLo * 100)}
                {hovered.run.confHi > hovered.run.confLo
                  ? `–${Math.round(hovered.run.confHi * 100)}`
                  : ""}
                %
              </div>
              {hovered.run.thumbId != null && (
                <img
                  src={`/api/v1/object-thumbnail/${hovered.run.thumbId}`}
                  className="mt-1 rounded max-h-16"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = "none";
                  }}
                />
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}

function fmtBytes(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

// Group raw detections into per-track contiguous runs so a loitering
// person is one clickable span, not hundreds of 2px pins. Runs from
// different tracks stack into lanes (mini-Gantt) so overlapping
// objects stay individually clickable.
function buildRuns(dets: HistoricDetection[], fromMs: number): Run[] {
  const byTrack = new Map<string, HistoricDetection[]>();
  for (const d of dets) {
    const key = d.track_id ?? `~${d.class_name}`;
    const list = byTrack.get(key);
    if (list) list.push(d);
    else byTrack.set(key, [d]);
  }
  const runs: Run[] = [];
  for (const list of byTrack.values()) {
    list.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    let cur: Run | null = null;
    for (const d of list) {
      const t = Date.parse(d.ts) - fromMs;
      if (cur && t - cur.endMs <= RUN_GAP_MS) {
        cur.endMs = t;
        cur.count++;
        cur.classes.add(d.class_name);
        cur.confLo = Math.min(cur.confLo, d.confidence);
        cur.confHi = Math.max(cur.confHi, d.confidence);
        if (cur.thumbId == null && d.id > 0) cur.thumbId = d.id;
      } else {
        if (cur) runs.push(cur);
        cur = {
          startMs: t,
          endMs: t,
          classes: new Set([d.class_name]),
          count: 1,
          confLo: d.confidence,
          confHi: d.confidence,
          thumbId: d.id > 0 ? d.id : null,
          lane: 0,
        };
      }
    }
    if (cur) runs.push(cur);
  }
  runs.sort((a, b) => a.startMs - b.startMs);
  // Greedy lane assignment; overflow wraps so nothing disappears.
  const laneEnds: number[] = [];
  for (const run of runs) {
    let lane = laneEnds.findIndex((end) => end <= run.startMs);
    if (lane === -1) {
      lane = laneEnds.length < RUN_LANES ? laneEnds.length : runs.indexOf(run) % RUN_LANES;
      if (laneEnds.length < RUN_LANES) laneEnds.push(0);
    }
    run.lane = lane;
    laneEnds[lane] = run.endMs + RUN_GAP_MS;
  }
  return runs;
}

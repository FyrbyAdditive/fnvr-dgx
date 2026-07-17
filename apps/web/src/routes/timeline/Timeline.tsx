import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api } from "@/lib/api";
import { useMe, isAdmin as isAdminFn } from "@/lib/me";
import { Player, playbackWindowSec } from "./Player";
import { Ruler } from "./Ruler";
import {
  useDetectionSummary,
  useIncidents,
  useSegments,
  useWindowDetections,
} from "./useDayData";
import { dayKeyFrom, dayRange, dayRangeMs, msToHHMM, todayKey } from "./timeMath";

// Timeline: one day (local time) for one camera, three bands:
// recording coverage, events (incidents — the rule-matched spans, wide
// and clickable), and detection activity (server-aggregated density;
// per-track runs when zoomed under 2h). Click anywhere to seek; drag
// to zoom; double-click/Esc to reset; ←/→ (or k/j) step through
// events; ,/. nudge the cursor ±5s; the green "now" marker jumps to
// /live. Today's data refreshes every 10s so the active recording
// grows in place.

// Zoom windows at or under this switch the activity band from density
// buckets to individual track runs.
const RUN_VIEW_MAX_MS = 2 * 3_600_000;

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
  const dayMs = dayRangeMs(from, to);

  // Zoom as fractions of the day (0..1). Full day = {0, 1}.
  const [zoom, setZoom] = useState<{ from: number; to: number }>({ from: 0, to: 1 });
  const resetZoom = () => setZoom({ from: 0, to: 1 });
  const zoomed = zoom.from > 0 || zoom.to < 1;

  // Day change resets zoom + cursor — fractions of one day mean
  // nothing on another (especially across DST-length days).
  useEffect(() => {
    setZoom({ from: 0, to: 1 });
    setCursorMs(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayKey, cameraId]);

  const visFromAbs = from.getTime() + zoom.from * dayMs;
  const visToAbs = from.getTime() + zoom.to * dayMs;
  const runView = visToAbs - visFromAbs <= RUN_VIEW_MAX_MS;

  const { data: segments = [] } = useSegments(cameraId, dayKey);
  const { data: incidents = [] } = useIncidents(cameraId, dayKey);
  const { data: summary } = useDetectionSummary(
    cameraId,
    new Date(visFromAbs),
    new Date(visToAbs),
    dayKey,
  );
  const { data: windowDetections } = useWindowDetections(
    cameraId,
    visFromAbs,
    visToAbs,
    dayKey,
    runView,
  );

  // Optional: overlay bounding boxes + class labels on the player.
  // Persisted via localStorage so the choice survives reloads. The
  // rows come from a fetch scoped to the playback window (not the
  // whole day, which used to truncate at 5000 rows on busy cameras).
  const [showOverlay, setShowOverlay] = useState<boolean>(() => {
    try { return localStorage.getItem("fnvr.timeline.showOverlay") === "1"; }
    catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("fnvr.timeline.showOverlay", showOverlay ? "1" : "0"); }
    catch { /* sandboxed iframe, no-op */ }
  }, [showOverlay]);

  const cursorAbs = cursorMs != null ? from.getTime() + cursorMs : null;
  const { data: overlayDetections } = useWindowDetections(
    cameraId,
    cursorAbs != null ? cursorAbs - 10_000 : 0,
    cursorAbs != null ? cursorAbs + playbackWindowSec() * 1000 + 10_000 : 0,
    dayKey,
    showOverlay && cursorAbs != null,
    5000,
  );

  // Auto-advance: when the playback window runs out, move the cursor
  // by exactly that window so the next request starts where the last
  // one ended. playbackWindowSec() is the same value the Player
  // fetches with (Safari 60s, others 1h) — they used to disagree,
  // which made Safari skip 59 minutes at every clip end. Stop at
  // end-of-day and when we've caught up with the present.
  const handleClipEnded = () => {
    if (cursorMs == null) return;
    const next = cursorMs + playbackWindowSec() * 1000;
    if (next >= dayMs) return;
    if (from.getTime() + next > Date.now()) return;
    setCursorMs(next);
  };

  // ---- incident navigation ----------------------------------------------

  const seekTo = (ms: number) => {
    setCursorMs(Math.max(0, Math.min(dayMs - 1000, Math.floor(ms / 1000) * 1000)));
  };
  const goToIncident = (inc: { started_at: string }) => {
    seekTo(new Date(inc.started_at).getTime() - from.getTime());
  };
  // incidents come sorted ascending from useIncidents.
  const prevIncident = () => {
    const t = cursorAbs ?? Infinity;
    for (let i = incidents.length - 1; i >= 0; i--) {
      if (new Date(incidents[i].started_at).getTime() < t - 500) {
        goToIncident(incidents[i]);
        return;
      }
    }
  };
  const nextIncident = () => {
    const t = cursorAbs ?? -Infinity;
    for (const inc of incidents) {
      if (new Date(inc.started_at).getTime() > t + 500) {
        goToIncident(inc);
        return;
      }
    }
  };
  const hasPrev = incidents.some(
    (i) => new Date(i.started_at).getTime() < (cursorAbs ?? Infinity) - 500,
  );
  const hasNext = incidents.some(
    (i) => new Date(i.started_at).getTime() > (cursorAbs ?? -Infinity) + 500,
  );
  const currentIdx = cursorAbs == null
    ? 0
    : incidents.filter((i) => new Date(i.started_at).getTime() <= cursorAbs + 500).length;

  // Keyboard: ←/k prev event, →/j next event, ,/. nudge ±5s, Esc
  // resets zoom. Inert while typing or with modifier keys held.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (["INPUT", "SELECT", "TEXTAREA"].includes(t.tagName) || t.isContentEditable)) return;
      switch (e.key) {
        case "ArrowLeft":
        case "k":
          e.preventDefault();
          prevIncident();
          break;
        case "ArrowRight":
        case "j":
          e.preventDefault();
          nextIncident();
          break;
        case ",":
          e.preventDefault();
          if (cursorMs != null) seekTo(cursorMs - 5000);
          break;
        case ".":
          e.preventDefault();
          if (cursorMs != null) seekTo(cursorMs + 5000);
          break;
        case "Escape":
          resetZoom();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const activityTotal = useMemo(
    () => (summary?.buckets ?? []).reduce((acc, b) => acc + b.count, 0),
    [summary],
  );

  return (
    <div className="p-4 grid grid-rows-[auto_1fr_auto] gap-3 h-full min-h-0">
      <header className="flex items-center gap-3 flex-wrap">
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
            title="Reset zoom (also: double-click the ruler, or Esc)"
          >
            zoom: {msToHHMM(zoom.from * dayMs)} – {msToHHMM(zoom.to * dayMs)} ⟳
          </button>
        )}
        <button
          onClick={() => setShowOverlay((v) => !v)}
          className={`text-xs px-2 py-1 rounded border ${
            showOverlay
              ? "bg-amber-700/70 border-amber-600 text-amber-100"
              : "bg-neutral-900 border-neutral-700 text-neutral-400 hover:text-white"
          }`}
          title="Draw bounding boxes + class labels on the recorded video"
        >
          {showOverlay ? "overlay on" : "overlay off"}
        </button>
        {/* event stepper — also on ←/→ or k/j */}
        <div className="flex items-center gap-1 text-xs">
          <button
            onClick={prevIncident}
            disabled={!hasPrev}
            className="px-2 py-1 rounded border bg-neutral-900 border-neutral-700 text-neutral-300 hover:text-white disabled:opacity-40 disabled:hover:text-neutral-300"
            title="Previous event (← or k)"
          >
            ‹ prev
          </button>
          <span className="text-neutral-500 tabular-nums px-1">
            event {currentIdx > 0 ? currentIdx : "–"} / {incidents.length}
          </span>
          <button
            onClick={nextIncident}
            disabled={!hasNext}
            className="px-2 py-1 rounded border bg-neutral-900 border-neutral-700 text-neutral-300 hover:text-white disabled:opacity-40 disabled:hover:text-neutral-300"
            title="Next event (→ or j)"
          >
            next ›
          </button>
        </div>
        <div className="flex items-center gap-3 text-xs text-neutral-500 ml-auto">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-3 h-2 bg-blue-600/60 rounded-sm" />
            recording ({segments.length})
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-3 h-2 bg-red-500/70 rounded-sm" />
            events ({incidents.length})
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-3 h-2 bg-amber-400/70 rounded-sm" />
            activity ({activityTotal})
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-0.5 h-3 bg-emerald-400" />
            now (click → live)
          </span>
        </div>
      </header>

      <div className="rounded bg-neutral-900 overflow-hidden relative">
        <Player
          startDate={cursorAbs != null ? new Date(cursorAbs) : null}
          onEnded={handleClipEnded}
          detections={showOverlay ? overlayDetections ?? [] : undefined}
          cameraId={cameraId}
          cameraEnabled={activeCamera?.enabled}
          cameraEnabledDetectors={activeCamera?.enabled_detectors ?? []}
          isAdmin={admin}
        />
      </div>

      <Ruler
        from={from}
        to={to}
        segments={segments}
        incidents={incidents}
        summary={summary}
        windowDetections={runView ? windowDetections : undefined}
        cursorMs={cursorMs}
        onSeek={(ms) => seekTo(ms)}
        zoom={zoom}
        onZoom={setZoom}
        onResetZoom={resetZoom}
        cameraId={cameraId}
      />
    </div>
  );
}

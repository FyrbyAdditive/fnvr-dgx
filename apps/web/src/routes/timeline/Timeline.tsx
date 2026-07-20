import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api, Incident } from "@/lib/api";
import { useMe, isAdmin as isAdminFn } from "@/lib/me";
import { severityColor } from "@/lib/severity";
import { Player, playbackWindowSec } from "./Player";
import { Ruler } from "./Ruler";
import { OverviewRuler } from "./OverviewRuler";
import { EventsDigest } from "./EventsDigest";
import {
  useDetectionSummary,
  useIncidents,
  useSegments,
  useWindowDetections,
} from "./useDayData";
import {
  useAllCameraSummaries,
  useAllIncidents,
  useAllSegments,
  useNotableDetections,
} from "./useOverviewData";
import { buildDigest, collapseNotables } from "./overviewLogic";
import { dayKeyFrom, dayRange, dayRangeMs, hourTicks, msToHHMM, todayKey } from "./timeMath";

// Timeline: one local-time day, in two modes sharing the player, the
// cursor, the zoom and the pointer semantics:
//   · overview ("All cameras", the landing view) — a stacked lane per
//     camera (recording coverage, activity density, incident markers)
//     plus a global events digest of the visible window across all
//     cameras (incidents + notable detections). Clicking a lane
//     focuses that camera in the player; the lane label drills into…
//   · detail (a specific camera) — the classic three-band ruler with
//     run view under 2h zoom.
// Cursor + zoom survive mode/camera switches (view the same moment
// from another angle); only a day change resets them. URL carries
// ?camera=&day= persistently; ?ts= is a one-shot deeplink (Events →
// "open in timeline").

const RUN_VIEW_MAX_MS = 2 * 3_600_000;
const ALL = "all";

export function Timeline() {
  const { data: cameras = [] } = useQuery({ queryKey: ["cameras"], queryFn: api.listCameras });
  const { data: me } = useMe();
  const admin = isAdminFn(me);
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const [selectedCamera, setSelectedCamera] = useState<string>(ALL);
  const mode = selectedCamera === ALL ? "overview" : "detail";
  // The camera the player is bound to while in overview mode.
  const [focusCameraId, setFocusCameraId] = useState<string | null>(null);
  const [dayKey, setDayKey] = useState<string>(() => todayKey());
  const [cursorMs, setCursorMs] = useState<number | null>(null);
  const [hoveredIncidentId, setHoveredIncidentId] = useState<string | null>(null);

  const playerCameraId =
    mode === "detail" ? selectedCamera : (focusCameraId ?? cameras[0]?.id ?? "");
  const playerCamera = useMemo(
    () => cameras.find((c) => c.id === playerCameraId),
    [cameras, playerCameraId],
  );

  // ---- URL: persistent ?camera=&day=, one-shot ?ts= ---------------------

  // Sync in. ts is consumed once (sets day + cursor) then rewritten
  // out; camera/day are authoritative when present.
  const consumedTsRef = useRef<string | null>(null);
  useEffect(() => {
    const cam = searchParams.get("camera");
    const day = searchParams.get("day");
    const tsStr = searchParams.get("ts");
    if (cam && cam !== selectedCamera && (cam === ALL || cameras.some((c) => c.id === cam))) {
      setSelectedCamera(cam);
    }
    if (day && /^\d{4}-\d{2}-\d{2}$/.test(day) && day !== dayKey) setDayKey(day);
    if (tsStr && consumedTsRef.current !== tsStr) {
      consumedTsRef.current = tsStr;
      const ts = new Date(tsStr);
      if (!Number.isNaN(ts.getTime())) {
        const key = dayKeyFrom(ts);
        setDayKey(key);
        const { from: dayStart } = dayRange(key);
        // Day change resets the cursor via the effect below; defer the
        // deeplink cursor one tick so it wins.
        const ms = ts.getTime() - dayStart.getTime();
        setTimeout(() => setCursorMs(Math.max(0, Math.floor(ms / 1000) * 1000)), 0);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, cameras]);

  // Sync out (replace-state, loop-guarded; drops any consumed ts).
  useEffect(() => {
    const want = new URLSearchParams();
    want.set("camera", selectedCamera);
    want.set("day", dayKey);
    if (searchParams.get("camera") !== selectedCamera || searchParams.get("day") !== dayKey ||
        searchParams.has("ts")) {
      setSearchParams(want, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCamera, dayKey]);

  const { from, to } = useMemo(() => dayRange(dayKey), [dayKey]);
  const dayMs = dayRangeMs(from, to);

  const [zoom, setZoom] = useState<{ from: number; to: number }>({ from: 0, to: 1 });
  const resetZoom = () => setZoom({ from: 0, to: 1 });
  const zoomed = zoom.from > 0 || zoom.to < 1;

  // Only a DAY change resets zoom + cursor — fractions of one day mean
  // nothing on another. Camera/mode switches deliberately preserve the
  // moment: viewing the same instant from another angle is the point.
  useEffect(() => {
    setZoom({ from: 0, to: 1 });
    setCursorMs(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayKey]);

  const visFromAbs = from.getTime() + zoom.from * dayMs;
  const visToAbs = from.getTime() + zoom.to * dayMs;
  const runView = visToAbs - visFromAbs <= RUN_VIEW_MAX_MS;

  // ---- detail-mode data --------------------------------------------------

  const detail = mode === "detail";
  const detailCam = detail ? selectedCamera : "";
  const { data: segments = [] } = useSegments(detailCam, dayKey);
  const { data: incidents = [] } = useIncidents(detailCam, dayKey);
  const { data: summary } = useDetectionSummary(
    detailCam,
    new Date(visFromAbs),
    new Date(visToAbs),
    dayKey,
  );
  const { data: windowDetections } = useWindowDetections(
    detailCam,
    visFromAbs,
    visToAbs,
    dayKey,
    detail && runView,
  );

  // ---- overview-mode data ------------------------------------------------

  const overview = mode === "overview";
  const cameraIds = useMemo(() => cameras.map((c) => c.id), [cameras]);
  const { data: segmentsByCamera = new Map() } = useAllSegments(dayKey, overview);
  const { data: fleetIncidents = [] } = useAllIncidents(dayKey, overview);
  const summariesByCamera = useAllCameraSummaries(
    cameraIds,
    new Date(visFromAbs),
    new Date(visToAbs),
    dayKey,
    overview,
  );
  const notables = useNotableDetections(dayKey, overview);
  const collapsedNotables = useMemo(() => collapseNotables(notables), [notables]);
  const digestRows = useMemo(() => {
    if (!overview) return [];
    return buildDigest(
      fleetIncidents,
      collapsedNotables,
      from.getTime(),
      visFromAbs - from.getTime(),
      visToAbs - from.getTime(),
      hourTicks(from, to),
    );
  }, [overview, fleetIncidents, collapsedNotables, from, to, visFromAbs, visToAbs]);

  const cameraName = (id: string | null) =>
    (id && cameras.find((c) => c.id === id)?.name) || id || "system";

  const ack = useMutation({
    mutationFn: (id: string) => api.ackIncident(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["incidents"] }),
  });

  // ---- overlay -------------------------------------------------------------

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
    playerCameraId,
    cursorAbs != null ? cursorAbs - 10_000 : 0,
    cursorAbs != null ? cursorAbs + playbackWindowSec() * 1000 + 10_000 : 0,
    dayKey,
    showOverlay && cursorAbs != null,
    5000,
  );

  const handleClipEnded = () => {
    if (cursorMs == null) return;
    const next = cursorMs + playbackWindowSec() * 1000;
    if (next >= dayMs) return;
    if (from.getTime() + next > Date.now()) return;
    setCursorMs(next);
  };

  // ---- seeking + event navigation -----------------------------------------

  const seekTo = (ms: number) => {
    setCursorMs(Math.max(0, Math.min(dayMs - 1000, Math.floor(ms / 1000) * 1000)));
  };
  const laneSeek = (cameraId: string, ms: number) => {
    setFocusCameraId(cameraId);
    seekTo(ms);
  };
  const drillToCamera = (cameraId: string) => {
    setFocusCameraId(cameraId);
    setSelectedCamera(cameraId);
  };
  // Entering overview keeps the player on the camera you were watching.
  const selectCamera = (value: string) => {
    if (value === ALL && mode === "detail") setFocusCameraId(selectedCamera);
    setSelectedCamera(value);
  };

  // The stepper walks whichever incident list the mode shows.
  const navIncidents = mode === "overview" ? fleetIncidents : incidents;
  const goToIncident = (inc: Incident) => {
    if (mode === "overview" && inc.camera_id) setFocusCameraId(inc.camera_id);
    seekTo(new Date(inc.started_at).getTime() - from.getTime());
  };
  const prevIncident = () => {
    const t = cursorAbs ?? Infinity;
    for (let i = navIncidents.length - 1; i >= 0; i--) {
      if (new Date(navIncidents[i].started_at).getTime() < t - 500) {
        goToIncident(navIncidents[i]);
        return;
      }
    }
  };
  const nextIncident = () => {
    const t = cursorAbs ?? -Infinity;
    for (const inc of navIncidents) {
      if (new Date(inc.started_at).getTime() > t + 500) {
        goToIncident(inc);
        return;
      }
    }
  };
  const hasPrev = navIncidents.some(
    (i) => new Date(i.started_at).getTime() < (cursorAbs ?? Infinity) - 500,
  );
  const hasNext = navIncidents.some(
    (i) => new Date(i.started_at).getTime() > (cursorAbs ?? -Infinity) + 500,
  );
  const currentIdx = cursorAbs == null
    ? 0
    : navIncidents.filter((i) => new Date(i.started_at).getTime() <= cursorAbs + 500).length;

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

  // ---- header legend numbers ----------------------------------------------

  const activityTotal = useMemo(() => {
    if (mode === "detail") return (summary?.buckets ?? []).reduce((a, b) => a + b.count, 0);
    let sum = 0;
    for (const s of summariesByCamera.values()) {
      for (const b of s?.buckets ?? []) sum += b.count;
    }
    return sum;
  }, [mode, summary, summariesByCamera]);

  const severityCounts = useMemo(() => {
    const c = { critical: 0, warning: 0, info: 0 } as Record<string, number>;
    for (const inc of fleetIncidents) c[inc.severity] = (c[inc.severity] ?? 0) + 1;
    return c;
  }, [fleetIncidents]);

  const laneCount = useMemo(
    () => [...segmentsByCamera.values()].filter((v) => (v as unknown[]).length > 0).length,
    [segmentsByCamera],
  );

  // Digest → ruler selection.
  const selectIncidentFromDigest = (inc: Incident) => {
    goToIncident(inc);
  };
  const selectNotable = (cameraId: string, msInDay: number) => {
    setFocusCameraId(cameraId);
    seekTo(msInDay);
  };

  return (
    <div className="p-4 grid grid-rows-[auto_1fr_auto] gap-3 h-full min-h-0">
      <header className="flex items-center gap-3 flex-wrap">
        <h2 className="text-lg font-semibold">Timeline</h2>
        <select
          className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm"
          value={selectedCamera}
          onChange={(e) => selectCamera(e.target.value)}
        >
          <option value={ALL}>All cameras</option>
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
        {/* event stepper — also on ←/→ or k/j; fleet-wide in overview */}
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
            event {currentIdx > 0 ? currentIdx : "–"} / {navIncidents.length}
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
          {mode === "detail" ? (
            <>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block w-3 h-2 bg-blue-600/60 rounded-sm" />
                recording ({segments.length})
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block w-3 h-2 bg-red-500/70 rounded-sm" />
                events ({incidents.length})
              </span>
            </>
          ) : (
            <>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block w-3 h-2 bg-blue-600/40 rounded-sm" />
                recording ({laneCount}/{cameras.length})
              </span>
              {(["critical", "warning", "info"] as const).map((s) =>
                severityCounts[s] > 0 ? (
                  <span key={s} className={`inline-flex items-center gap-1 ${severityColor(s)}`}>
                    ● {severityCounts[s]}
                  </span>
                ) : null,
              )}
            </>
          )}
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

      <div
        className={`min-h-0 ${
          overview ? "grid gap-3 grid-rows-[2fr_1fr] xl:grid-rows-1 xl:grid-cols-[1fr_20rem]" : ""
        }`}
      >
        <div className="rounded bg-neutral-900 overflow-hidden relative min-h-0">
          <Player
            startDate={cursorAbs != null ? new Date(cursorAbs) : null}
            onEnded={handleClipEnded}
            detections={showOverlay ? overlayDetections ?? [] : undefined}
            cameraId={playerCameraId}
            cameraEnabled={playerCamera?.enabled}
            cameraEnabledDetectors={playerCamera?.enabled_detectors ?? []}
            isAdmin={admin}
          />
          {overview && playerCamera && (
            <div className="absolute top-2 left-2 text-[11px] bg-neutral-900/80 text-neutral-200 rounded px-1.5 py-0.5 pointer-events-none z-10">
              ▶ {playerCamera.name}
            </div>
          )}
        </div>
        {overview && (
          <EventsDigest
            rows={digestRows}
            cameraName={cameraName}
            hoveredIncidentId={hoveredIncidentId}
            isAdmin={admin}
            onSelectIncident={selectIncidentFromDigest}
            onSelectNotable={selectNotable}
            onHoverIncident={setHoveredIncidentId}
            onAck={(id) => ack.mutate(id)}
          />
        )}
      </div>

      {mode === "detail" ? (
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
          cameraId={selectedCamera}
        />
      ) : (
        <OverviewRuler
          from={from}
          to={to}
          cameras={cameras}
          segmentsByCamera={segmentsByCamera}
          incidents={fleetIncidents}
          summariesByCamera={summariesByCamera}
          focusCameraId={playerCameraId || null}
          cursorMs={cursorMs}
          zoom={zoom}
          hoveredIncidentId={hoveredIncidentId}
          onZoom={setZoom}
          onResetZoom={resetZoom}
          onLaneSeek={laneSeek}
          onDrillToCamera={drillToCamera}
          onSelectIncident={(inc) => goToIncident(inc)}
          onHoverIncident={setHoveredIncidentId}
        />
      )}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api } from "@/lib/api";
import { useRecentDetections, DetectionEvent } from "@/lib/events";
import { useMe } from "@/lib/me";
import { CameraTile, TileDrag } from "./CameraTile";
import { EnlargedCameraModal } from "./EnlargedCameraModal";
import { useLivePrefs } from "./useLivePrefs";
import { useLiveKeyboard } from "./useLiveKeyboard";
import { applyOrder, gridColCount, gridColsForCount, moveId, visibleCameras } from "./layouts";

// The Live mosaic. Three layouts (Auto grid / Focus / Wall), tile
// drag-reorder + hide, keyboard nav, and a per-camera enlarged modal —
// all preferences persisted per browser (useLivePrefs).

export function Live() {
  const { data: me } = useMe();
  const isAdmin = !!me?.is_admin;
  const { data: cameras = [] } = useQuery({
    queryKey: ["cameras"],
    queryFn: api.listCameras,
    refetchInterval: 3_000,
  });

  const {
    prefs, setShowStats, setLayout, setOrder, toggleHidden, showAllHidden,
    setFocusCam, setFocusQuality, setModalQuality,
  } = useLivePrefs();

  // ?camera=<id> — from Timeline's "now" click. Scroll + briefly
  // highlight that tile so the user sees where they landed.
  const [searchParams] = useSearchParams();
  const deeplinkCameraId = searchParams.get("camera") ?? "";

  // Larger buffer so the FPS overlay has enough history for a smooth
  // rolling rate (~5s at 30fps worst case).
  const events = useRecentDetections(400);

  // Group detections by camera, keeping only the freshest few per cam so
  // stale bboxes don't pile up. The SSE stream is already filtered to
  // recent-only, but we additionally time-gate to the last 2s.
  //
  // The filter depends on `Date.now()`, which useMemo can't observe
  // on its own — the 500ms tick below re-runs it so an idle scene
  // prunes its last boxes instead of freezing them on screen.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => (t + 1) & 0xffff), 500);
    return () => clearInterval(id);
  }, []);
  const boxesByCamera = useMemo(() => {
    const now = Date.now();
    const m = new Map<string, DetectionEvent[]>();
    for (const e of events) {
      // Age out bboxes 2s after we saw them on the SSE stream. Falls
      // back to source `ts` for events that predate arrived_at_ms.
      const age = e.arrived_at_ms != null
        ? now - e.arrived_at_ms
        : now - new Date(e.ts).getTime();
      if (age > 2000) continue;
      const arr = m.get(e.camera_id) ?? [];
      arr.push(e);
      m.set(e.camera_id, arr);
    }
    return m;
    // `tick` in deps is deliberate — see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, tick]);

  // Inference FPS per camera. Unique-timestamps-per-5s-window heuristic:
  // one inference frame publishes N events sharing the same ts, so the
  // count of distinct timestamps in the last 5s ≈ frames/s × 5. Used
  // only as the fallback when the pipeline metrics endpoint has no
  // fresh row for a camera.
  const fpsByCamera = useMemo(() => {
    const now = Date.now();
    const WINDOW_MS = 5000;
    const perCam = new Map<string, Set<string>>();
    for (const e of events) {
      const at = Number.isFinite(e.arrived_at_ms)
        ? (e.arrived_at_ms as number)
        : Date.parse(e.ts);
      if (!Number.isFinite(at) || now - at > WINDOW_MS) continue;
      let s = perCam.get(e.camera_id);
      if (!s) { s = new Set(); perCam.set(e.camera_id, s); }
      s.add(e.ts);
    }
    const out = new Map<string, number>();
    for (const [cam, set] of perCam) {
      out.set(cam, set.size / (WINDOW_MS / 1000));
    }
    return out;
    // Same reason as boxesByCamera: needs the timer tick so idle
    // cameras drop to 0 fps instead of freezing on their last value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, tick]);

  // Single-camera enlarged view. Null = no modal; the mosaic keeps
  // streaming behind it so closing feels instant.
  const [enlargedCamId, setEnlargedCamId] = useState<string | null>(null);
  const enlargedCam = enlargedCamId
    ? cameras.find((c) => c.id === enlargedCamId) ?? null
    : null;

  // Real per-camera fps — polled only while someone is looking at
  // numbers (stats overlay or the modal).
  const { data: pipeMetrics } = useQuery({
    queryKey: ["pipeline-metrics"],
    queryFn: api.pipelineMetrics,
    refetchInterval: 5_000,
    enabled: prefs.showStats || !!enlargedCamId,
  });
  const metricsFor = (id: string) => pipeMetrics?.cameras?.[id] ?? null;

  // Ordering + visibility.
  const ordered = useMemo(() => applyOrder(cameras, prefs.order), [cameras, prefs.order]);
  const visible = useMemo(
    () => visibleCameras(ordered, prefs.hidden),
    [ordered, prefs.hidden],
  );
  const visibleIds = useMemo(() => visible.map((c) => c.id), [visible]);
  const cols = gridColCount(visible.length);

  const focusCamId =
    prefs.layout === "focus"
      ? (visibleIds.includes(prefs.focusCam) ? prefs.focusCam : visibleIds[0] ?? "")
      : "";

  // Keyboard nav.
  const [kbFocusId, setKbFocusId] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [gridFs, setGridFs] = useState(false);
  useEffect(() => {
    const onChange = () => setGridFs(document.fullscreenElement === gridRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleGridFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => { /* ignore */ });
    } else {
      gridRef.current?.requestFullscreen().catch(() => { /* ignore */ });
    }
  };
  useLiveKeyboard({
    enabled: !enlargedCamId,
    visibleIds,
    cols,
    kbFocusId,
    setKbFocusId,
    focusLayout: prefs.layout === "focus",
    setFocusCam,
    onEnlarge: setEnlargedCamId,
    onToggleStats: () => setShowStats(!prefs.showStats),
    onFullscreen: prefs.layout === "wall" ? toggleGridFullscreen : undefined,
  });

  // Drag-to-reorder (Auto layout only). The grip arms draggable so
  // click-to-enlarge and draw-mode mouse handlers stay unaffected.
  const [dragArmedId, setDragArmedId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string; before: boolean } | null>(null);
  const dragFor = (id: string): TileDrag | undefined => {
    if (prefs.layout !== "auto") return undefined;
    return {
      armed: dragArmedId === id,
      dragging: draggingId === id,
      hint: dropHint?.id === id ? (dropHint.before ? "before" : "after") : null,
      onGripDown: () => setDragArmedId(id),
      onGripUp: () => setDragArmedId(null),
      onDragStart: (e) => {
        e.dataTransfer.setData("text/fnvr-camera", id);
        e.dataTransfer.effectAllowed = "move";
        setDraggingId(id);
      },
      onDragEnd: () => {
        setDraggingId(null);
        setDragArmedId(null);
        setDropHint(null);
      },
      onDragOver: (e) => {
        if (!draggingId || draggingId === id) return;
        e.preventDefault();
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setDropHint({ id, before: e.clientX - rect.left < rect.width / 2 });
      },
      onDrop: (e) => {
        e.preventDefault();
        const dragged = e.dataTransfer.getData("text/fnvr-camera") || draggingId;
        if (dragged && dragged !== id) {
          // Order over ALL cameras (hidden ones keep their slots).
          setOrder(moveId(ordered.map((c) => c.id), dragged, id, dropHint?.before ?? true));
        }
        setDraggingId(null);
        setDropHint(null);
      },
    };
  };

  const tileFor = (c: (typeof visible)[number], variant: "auto" | "focus" | "thumb" | "wall", style?: React.CSSProperties) => (
    <CameraTile
      key={c.id}
      camera={c}
      detections={boxesByCamera.get(c.id) ?? []}
      inferenceFps={fpsByCamera.get(c.id) ?? 0}
      metrics={metricsFor(c.id)}
      showStats={prefs.showStats}
      deeplink={deeplinkCameraId === c.id}
      kbFocused={kbFocusId === c.id}
      isAdmin={isAdmin}
      variant={variant}
      quality={
        variant === "focus" && prefs.focusQuality === "full" ? "auto" : "proxy"
      }
      style={style}
      onEnlarge={() => setEnlargedCamId(c.id)}
      onSelect={variant === "thumb" ? () => setFocusCam(c.id) : undefined}
      onHide={() => toggleHidden(c.id)}
      hqOn={variant === "focus" ? prefs.focusQuality === "full" : undefined}
      onToggleHq={
        variant === "focus"
          ? () => setFocusQuality(prefs.focusQuality === "full" ? "proxy" : "full")
          : undefined
      }
      drag={dragFor(c.id)}
    />
  );

  const wall = prefs.layout === "wall";

  return (
    <div className={`h-full flex flex-col ${wall ? "p-0 gap-0" : "p-4 gap-2"}`}>
      {/* Toolbar. */}
      <div className={`flex items-center justify-between gap-2 ${wall ? "px-2 py-1" : ""}`}>
        <div>
          {prefs.hidden.length > 0 && (
            <button
              className="text-xs text-neutral-400 hover:text-white"
              onClick={showAllHidden}
            >
              {prefs.hidden.length} hidden · restore all
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border border-neutral-800 overflow-hidden">
            {(["auto", "focus", "wall"] as const).map((l) => (
              <button
                key={l}
                onClick={() => setLayout(l)}
                className={`px-2.5 py-1 text-xs capitalize ${
                  prefs.layout === l
                    ? "bg-neutral-800 text-white"
                    : "bg-neutral-900 text-neutral-400 hover:text-white"
                }`}
                title={
                  l === "auto"
                    ? "Grid of all cameras"
                    : l === "focus"
                      ? "One large camera + thumbnail rail"
                      : "Chromeless wall for a dedicated monitor"
                }
              >
                {l}
              </button>
            ))}
          </div>
          {wall && (
            <button
              onClick={toggleGridFullscreen}
              className="text-xs px-2 py-1 rounded bg-neutral-900 text-neutral-400 hover:text-white"
              title="Browser fullscreen on the wall (f)"
            >
              {gridFs ? "exit fullscreen" : "⛶ fullscreen"}
            </button>
          )}
          <button
            onClick={() => setShowStats(!prefs.showStats)}
            className={`text-xs px-2 py-1 rounded ${
              prefs.showStats
                ? "bg-neutral-800 text-white"
                : "bg-neutral-900 text-neutral-400 hover:text-white"
            }`}
            title="Toggle the per-tile fps overlay (s)"
          >
            {prefs.showStats ? "hide stats" : "show stats"}
          </button>
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState anyHidden={prefs.hidden.length > 0} onRestore={showAllHidden} />
      ) : prefs.layout === "focus" ? (
        <div
          className="flex-1 min-h-0 grid gap-2"
          style={{
            gridTemplateColumns: "minmax(0,1fr) 13rem",
            gridTemplateRows: `repeat(${Math.max(1, visible.length - 1)}, minmax(0,1fr))`,
          }}
        >
          {visible.map((c) =>
            tileFor(
              c,
              c.id === focusCamId ? "focus" : "thumb",
              c.id === focusCamId
                ? { gridColumn: 1, gridRow: `1 / span ${Math.max(1, visible.length - 1)}` }
                : { gridColumn: 2 },
            ),
          )}
        </div>
      ) : (
        <div
          ref={gridRef}
          className={`flex-1 min-h-0 overflow-y-auto ${wall ? "bg-black" : ""}`}
        >
          <div
            className={`grid ${wall ? "gap-px" : "gap-2"} auto-rows-max ${gridColsForCount(visible.length)}`}
          >
            {visible.map((c) => tileFor(c, wall ? "wall" : "auto"))}
          </div>
        </div>
      )}

      {enlargedCam && (
        <EnlargedCameraModal
          camera={enlargedCam}
          detections={boxesByCamera.get(enlargedCam.id) ?? []}
          metrics={metricsFor(enlargedCam.id)}
          showStats={prefs.showStats}
          isAdmin={isAdmin}
          quality={prefs.modalQuality}
          onQualityChange={setModalQuality}
          onClose={() => setEnlargedCamId(null)}
        />
      )}
    </div>
  );
}

function EmptyState({ anyHidden, onRestore }: { anyHidden: boolean; onRestore: () => void }) {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-center space-y-2">
        <div className="text-lg">{anyHidden ? "All cameras hidden." : "No cameras yet."}</div>
        <div className="text-neutral-500 text-sm">
          {anyHidden ? (
            <button className="underline" onClick={onRestore}>Restore hidden cameras</button>
          ) : (
            <>Add one from the <a className="underline" href="/cameras">Cameras</a> tab.</>
          )}
        </div>
      </div>
    </div>
  );
}

// Compatibility re-exports — Timeline's PlayerOverlay (and any other
// consumer) imports these from "@/routes/live/Live".
export { BBox, FlagPopover, ManualLabelPopover } from "./overlays";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api, fetchDetectionClasses } from "@/lib/api";
import { useRecentDetections, DetectionEvent } from "@/lib/events";
import { useMe } from "@/lib/me";
import { CameraToggle } from "@/components/CameraToggle";
import { CameraDetectorChips } from "@/components/CameraDetectorChips";
import { CameraContent } from "./CameraContent";
import { EnlargedCameraModal } from "./EnlargedCameraModal";

export function Live() {
  const { data: me } = useMe();
  const isAdmin = !!me?.is_admin;
  const { data: cameras = [] } = useQuery({
    queryKey: ["cameras"],
    queryFn: api.listCameras,
    refetchInterval: 3_000,
  });

  // ?camera=<id> — from Timeline's "now" click. Scroll + briefly
  // highlight that tile so the user sees where they landed.
  const [searchParams] = useSearchParams();
  const focusCameraId = searchParams.get("camera") ?? "";
  // Larger buffer so the FPS overlay has enough history for a smooth
  // rolling rate (~5s at 30fps worst case).
  const events = useRecentDetections(400);

  // Persisted overlay toggle — localStorage so it survives reloads.
  const [showStats, setShowStats] = useState<boolean>(() => {
    try { return localStorage.getItem("fnvr.live.showStats") === "1"; }
    catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("fnvr.live.showStats", showStats ? "1" : "0"); }
    catch { /* sandboxed iframe, no-op */ }
  }, [showStats]);

  // Group detections by camera, keeping only the freshest few per cam so
  // stale bboxes don't pile up. The SSE stream is already filtered to
  // recent-only, but we additionally time-gate to the last 2s.
  //
  // The filter depends on `Date.now()`, which useMemo can't observe
  // on its own. Without the tick below, when the scene goes idle
  // events stops changing, the memo never re-runs, and the last
  // batch of boxes sits on screen until a new event arrives —
  // which on an empty scene is never. Ticking every 500 ms is
  // enough: the filter wakes up, finds every detection older than
  // 2 s, and prunes them before render.
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
      // back to source `ts` for events that predate the
      // arrived_at_ms field (e.g. a build mismatch between web and
      // pipeline).
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
  // count of distinct timestamps in the last 5s ≈ frames/s × 5.
  const fpsByCamera = useMemo(() => {
    const now = Date.now();
    const WINDOW_MS = 5000;
    const perCam = new Map<string, Set<string>>();
    for (const e of events) {
      // Window is in arrival time so an idle camera correctly drops
      // to 0 fps. We still de-dup on source `ts` because one frame
      // emits N events sharing the same ts (1 per detected object) —
      // counting unique `ts` values approximates frames/sec.
      if (now - e.arrived_at_ms > WINDOW_MS) continue;
      let s = perCam.get(e.camera_id);
      if (!s) { s = new Set(); perCam.set(e.camera_id, s); }
      s.add(e.ts);
    }
    const out = new Map<string, number>();
    for (const [cam, set] of perCam) {
      out.set(cam, set.size / (WINDOW_MS / 1000));
    }
    return out;
    // Same reason as boxesByCamera: needs a timer tick so idle
    // cameras drop to 0 fps instead of freezing on their last value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, tick]);

  const grid =
    cameras.length <= 1 ? "grid-cols-1" :
    cameras.length <= 4 ? "grid-cols-2" :
    cameras.length <= 9 ? "grid-cols-3" :
    "grid-cols-4";

  // Single-camera enlarged view. Null = no modal; a camera id renders
  // the EnlargedCameraModal on top of the mosaic. The mosaic continues
  // streaming behind it so closing the modal feels instant.
  const [enlargedCamId, setEnlargedCamId] = useState<string | null>(null);
  const enlargedCam = enlargedCamId
    ? cameras.find((c) => c.id === enlargedCamId) ?? null
    : null;

  return (
    <div className="p-4 h-full flex flex-col gap-2">
      <div className="flex justify-end">
        <button
          onClick={() => setShowStats((v) => !v)}
          className={`text-xs px-2 py-1 rounded ${
            showStats
              ? "bg-neutral-800 text-white"
              : "bg-neutral-900 text-neutral-400 hover:text-white"
          }`}
          title="Toggle detection-FPS overlay on each tile"
        >
          {showStats ? "hide stats" : "show stats"}
        </button>
      </div>
      {cameras.length === 0 ? (
        <EmptyState />
      ) : (
        <div className={`grid gap-2 ${grid} flex-1 min-h-0`}>
          {cameras.map((c) => (
            <CameraTile
              key={c.id}
              id={c.id}
              name={c.name}
              enabled={c.enabled}
              enabledDetectors={c.enabled_detectors ?? []}
              state={c.state}
              lastHeartbeatAt={c.last_heartbeat_at ?? null}
              detections={boxesByCamera.get(c.id) ?? []}
              inferenceFps={fpsByCamera.get(c.id) ?? 0}
              showStats={showStats}
              focus={focusCameraId === c.id}
              isAdmin={isAdmin}
              onEnlarge={() => setEnlargedCamId(c.id)}
            />
          ))}
        </div>
      )}
      {enlargedCam && (
        <EnlargedCameraModal
          cameraId={enlargedCam.id}
          cameraName={enlargedCam.name}
          enabled={enlargedCam.enabled}
          enabledDetectors={enlargedCam.enabled_detectors ?? []}
          state={enlargedCam.state}
          lastHeartbeatAt={enlargedCam.last_heartbeat_at ?? null}
          detections={boxesByCamera.get(enlargedCam.id) ?? []}
          isAdmin={isAdmin}
          onClose={() => setEnlargedCamId(null)}
        />
      )}
    </div>
  );
}

function CameraTile({ id, name, enabled, enabledDetectors, state, lastHeartbeatAt, detections, inferenceFps, showStats, focus, isAdmin, onEnlarge }: {
  id: string;
  name: string;
  enabled: boolean;
  enabledDetectors: string[];
  state?: "starting" | "running" | "failed" | "unknown";
  lastHeartbeatAt?: string | null;
  detections: DetectionEvent[];
  inferenceFps: number;
  showStats: boolean;
  focus?: boolean;
  isAdmin: boolean;
  onEnlarge: () => void;
}) {
  // When opened from Timeline's "now" click, scroll this tile into
  // view and run a short highlight animation so the user sees where
  // they landed without hunting the grid.
  const tileRef = useRef<HTMLDivElement>(null);
  const [highlight, setHighlight] = useState(false);
  useEffect(() => {
    if (!focus) return;
    tileRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setHighlight(true);
    const t = setTimeout(() => setHighlight(false), 2500);
    return () => clearTimeout(t);
  }, [focus]);

  // Manual-label drawer toggle. The CameraContent below handles the
  // mousedown→mouseup math; we just own the on/off button up here.
  const [drawing, setDrawing] = useState(false);

  // Stats overlay — CameraContent samples its own preview-FPS and
  // pushes via the callback.
  const [previewFps, setPreviewFps] = useState(0);

  const latest = detections[0];

  return (
    <div
      ref={tileRef}
      className={`group bg-neutral-900 rounded aspect-video relative overflow-hidden flex items-center justify-center transition-shadow ${
        highlight ? "ring-2 ring-emerald-400 shadow-[0_0_24px_rgba(52,211,153,0.55)]" : ""
      }`}
    >
      <CameraContent
        cameraId={id}
        name={name}
        detections={detections}
        isAdmin={isAdmin}
        drawing={drawing}
        onDrawingChange={setDrawing}
        onClickEmpty={onEnlarge}
        fitTo="video"
        onPreviewFps={setPreviewFps}
      />

      <div className="absolute bottom-2 left-2 flex items-center gap-1">
        <div className="text-xs bg-black/60 px-2 py-0.5 rounded">
          {name}
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onEnlarge();
          }}
          className="text-xs bg-black/60 hover:bg-black/80 px-2 py-0.5 rounded leading-none"
          title="Open in enlarged view"
          aria-label={`Enlarge ${name}`}
        >
          ⛶
        </button>
      </div>
      {isAdmin && (
        <div className="absolute top-2 left-2 z-10 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <CameraToggle cameraId={id} enabled={enabled} variant="overlay" />
          <CameraDetectorChips
            cameraId={id}
            enabledDetectors={enabledDetectors}
            disabled={!enabled}
            variant="overlay"
          />
          <button
            className={`text-xs px-2 py-0.5 rounded ${
              drawing
                ? "bg-emerald-700 hover:bg-emerald-600"
                : "bg-neutral-800/80 hover:bg-neutral-700"
            } border border-neutral-700`}
            title="Draw a label box on this tile to add a YOLO training sample"
            onClick={(e) => {
              e.stopPropagation();
              setDrawing((d) => !d);
            }}
          >
            {drawing ? "cancel draw" : "+ label"}
          </button>
        </div>
      )}
      {latest && (
        <div className="absolute top-2 right-2 text-xs bg-blue-600/80 px-2 py-0.5 rounded">
          {latest.class_name} {(latest.confidence * 100).toFixed(0)}%
        </div>
      )}
      {state && state !== "running" && (
        <StateBadge state={state} lastHeartbeatAt={lastHeartbeatAt} />
      )}
      {showStats && (
        <div className="absolute bottom-2 right-2 text-[10px] font-mono bg-black/70 text-neutral-200 px-2 py-0.5 rounded space-x-2">
          <span title="Preview refresh (JPEG img onLoad or WebRTC rVFC)">
            preview {previewFps.toFixed(1)} fps
          </span>
          <span className="opacity-60">·</span>
          <span title="Inference frames per second (unique detection timestamps /s)">
            infer {inferenceFps.toFixed(1)} fps
          </span>
        </div>
      )}
    </div>
  );
}

function StateBadge({ state, lastHeartbeatAt }: {
  state: "starting" | "failed" | "unknown" | string;
  lastHeartbeatAt?: string | null;
}) {
  // "unknown" really means one of two things — never heard from this
  // camera, or heartbeat expired. Surfacing the age lets the operator
  // tell a never-started worker from a long-stuck one without digging
  // in the logs.
  const ageSuffix =
    state === "unknown" && lastHeartbeatAt
      ? ` · last heartbeat ${formatRelativeAge(new Date(lastHeartbeatAt))}`
      : "";
  const label =
    state === "starting" ? "starting…" :
    state === "failed"   ? "pipeline failed" :
                           "pipeline offline" + ageSuffix;
  const color =
    state === "starting" ? "bg-amber-600/85" :
    state === "failed"   ? "bg-red-600/85" :
                           "bg-neutral-600/85";
  return (
    <div className={`absolute top-2 left-2 text-xs ${color} px-2 py-0.5 rounded flex items-center gap-1.5`}>
      {state === "starting" && (
        <span className="w-2 h-2 rounded-full bg-amber-200 animate-pulse" />
      )}
      {label}
    </div>
  );
}

function formatRelativeAge(d: Date): string {
  const secs = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (secs < 60) return `${Math.round(secs)}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

export function BBox({
  d,
  highlighted,
  onPick,
}: {
  d: DetectionEvent;
  highlighted?: boolean;
  /** Non-nullable enables pointer events + hover + click-to-flag. */
  onPick?: () => void;
}) {
  const isPlate = d.kind === "anpr";
  const isFace = d.kind === "face";
  const person = isFace ? d.attributes?.person : undefined;
  // Fixed-colour boxes for the special detectors so they stand apart
  // from the COCO palette: green for plates, sky-blue for matched
  // faces. Unmatched faces fall back to the class-palette "face".
  // Highlighted box (operator clicked it) gets an amber border so it
  // stands out above everything else.
  const color = highlighted
    ? "#fbbf24"
    : isPlate
    ? "#22c55e"
    : person
    ? "#38bdf8"
    : colorForClass(d.class_name);
  const style: React.CSSProperties = {
    position: "absolute",
    left: `${d.bbox.x * 100}%`,
    top: `${d.bbox.y * 100}%`,
    width: `${d.bbox.w * 100}%`,
    height: `${d.bbox.h * 100}%`,
    border: `${highlighted ? 3 : 2}px solid ${color}`,
    boxShadow: `0 0 0 1px rgba(0,0,0,0.5)`,
    // Only bboxes an operator can act on accept pointer events.
    // Everything else stays click-through so WHEP gestures reach the
    // video underneath.
    pointerEvents: onPick ? "auto" : "none",
    cursor: onPick ? "pointer" : "default",
  };
  // Label priority: plate text → matched-person name + similarity →
  // class + detection confidence.
  let label: string;
  if (isPlate) {
    label = d.attributes?.plate ?? "plate";
  } else if (person) {
    const sim = d.attributes?.similarity;
    label = sim
      ? `${person} ${Math.round(Number(sim) * 100)}%`
      : person;
  } else {
    label = `${d.class_name} ${(d.confidence * 100).toFixed(0)}%`;
  }
  return (
    <div
      style={style}
      onClick={onPick ? (e) => { e.stopPropagation(); onPick(); } : undefined}
      title={onPick ? "Flag this detection" : undefined}
    >
      <div
        className="absolute top-0 left-0 text-[10px] px-1 font-medium leading-tight tabular-nums"
        style={{ background: color, color: "#000", transform: "translateY(-100%)" }}
      >
        {label}
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

// FlagPopover floats near the clicked bbox inside the CameraTile and
// lets the operator mark the detection as a false positive or relabel
// it. Either choice hits `POST /detections/{event_id}/flag` via the
// api client; on success the popover closes and the caller's state
// unfreezes the bbox overlay.
export function FlagPopover({
  detection,
  onClose,
}: {
  detection: DetectionEvent;
  onClose: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Close on Escape. Mouse-outside is handled by a full-tile
  // invisible overlay behind the popover so the main Live click
  // handlers on the video layer aren't disturbed.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Auto-close after 15 s so an abandoned popover doesn't wedge the
  // tile forever.
  useEffect(() => {
    const t = setTimeout(onClose, 15000);
    return () => clearTimeout(t);
  }, [onClose]);

  async function submit(classCorrected: string | null) {
    setSubmitting(true);
    setError(null);
    try {
      // Prefer pg_id — unambiguous and avoids the event_id→row race
      // on freshly-published detections. Fall back to event_id for
      // builds that haven't shipped pg_id yet on the SSE stream.
      const key = detection.pg_id != null ? String(detection.pg_id) : detection.id;
      await api.flagDetection(key, classCorrected);
      onClose();
    } catch (e) {
      setError((e as Error).message || "flag failed");
    } finally {
      setSubmitting(false);
    }
  }

  // Position relative to the bbox: anchor the popover just below the
  // box, clamped to the tile. Popover uses absolute% so it scales
  // with the tile.
  const left = `${Math.max(0, Math.min(70, detection.bbox.x * 100))}%`;
  const top = `${Math.min(90, (detection.bbox.y + detection.bbox.h) * 100)}%`;

  return (
    <>
      {/* Click-outside overlay. Captures the click so it doesn't
          reach the WHEP video. */}
      <div
        className="absolute inset-0 z-10"
        style={{ background: "rgba(0,0,0,0.25)" }}
        onClick={onClose}
      />
      <div
        className="absolute z-20 bg-neutral-900 border border-neutral-700 rounded p-2 text-xs shadow-xl min-w-[14rem]"
        style={{ left, top, transform: "translate(0, 0.25rem)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-neutral-400 mb-2">
          Flag <span className="font-medium text-neutral-200">{detection.class_name}</span> on this camera?
        </div>
        <div className="space-y-1">
          <button
            className="w-full text-left px-2 py-1 rounded bg-red-900/60 hover:bg-red-800 disabled:opacity-50"
            disabled={submitting}
            onClick={() => submit(null)}
          >
            False positive — suppress future matches
          </button>
          <RelabelPicker
            currentClass={detection.class_name}
            disabled={submitting}
            onPick={submit}
          />
        </div>
        {error && <div className="text-red-400 mt-2">{error}</div>}
        <div className="text-neutral-500 text-[10px] mt-2">
          Esc or click outside to cancel.
        </div>
      </div>
    </>
  );
}

// RelabelPicker fetches the enabled detection_classes list and renders
// a clickable grid. Disabled / unknown classes are filtered out so the
// user can't relabel into a class the trained model wouldn't emit.
function RelabelPicker({
  currentClass,
  disabled,
  onPick,
}: {
  currentClass: string;
  disabled: boolean;
  onPick: (slug: string) => void;
}) {
  const { data: classes = [], isLoading } = useQuery({
    queryKey: ["detection-classes"],
    queryFn: fetchDetectionClasses,
  });
  const options = classes
    .filter((c) => c.enabled && c.slug !== currentClass)
    .sort((a, b) => a.display_name.localeCompare(b.display_name));
  return (
    <details className="px-1">
      <summary className="cursor-pointer text-neutral-400 hover:text-neutral-200 py-1">
        Relabel as…
      </summary>
      <div className="max-h-40 overflow-auto mt-1 grid grid-cols-2 gap-1">
        {isLoading && <div className="text-neutral-500">loading…</div>}
        {!isLoading && options.length === 0 && (
          <div className="text-neutral-500 col-span-2">
            no other enabled classes — manage in Settings → Classes
          </div>
        )}
        {options.map((c) => (
          <button
            key={c.slug}
            className="text-left px-1 py-0.5 rounded hover:bg-neutral-800 disabled:opacity-50"
            disabled={disabled}
            onClick={() => onPick(c.slug)}
          >
            {c.display_name}
          </button>
        ))}
      </div>
    </details>
  );
}

// ManualLabelPopover anchors below the user-drawn rect and asks for a
// class. On submit it POSTs to /api/v1/flags/manual which captures the
// camera's most recent live JPEG and writes a YOLO training row.
export function ManualLabelPopover({
  cameraId,
  bbox,
  onClose,
}: {
  cameraId: string;
  bbox: { x: number; y: number; w: number; h: number };
  onClose: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: classes = [], isLoading } = useQuery({
    queryKey: ["detection-classes"],
    queryFn: fetchDetectionClasses,
  });
  const enabled = classes
    .filter((c) => c.enabled)
    .sort((a, b) => a.display_name.localeCompare(b.display_name));

  // Esc / click-outside cancel — same affordance as FlagPopover.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(slug: string) {
    setSubmitting(true);
    setError(null);
    try {
      await api.flagManual({ camera_id: cameraId, bbox, class: slug });
      onClose();
    } catch (e) {
      setError((e as Error).message || "manual label failed");
    } finally {
      setSubmitting(false);
    }
  }

  // Anchor the popover just under the drawn box, clamped inside the
  // tile so it never escapes off the right edge.
  const left = `${Math.max(0, Math.min(70, bbox.x * 100))}%`;
  const top = `${Math.min(90, (bbox.y + bbox.h) * 100)}%`;

  return (
    <>
      <div
        className="absolute inset-0 z-10"
        style={{ background: "rgba(0,0,0,0.25)" }}
        onClick={onClose}
      />
      {/* Re-render the locked rect so it stays visible while choosing. */}
      <div
        className="absolute pointer-events-none border-2 border-emerald-400 bg-emerald-400/10 z-10"
        style={{
          left: `${bbox.x * 100}%`,
          top: `${bbox.y * 100}%`,
          width: `${bbox.w * 100}%`,
          height: `${bbox.h * 100}%`,
        }}
      />
      <div
        className="absolute z-20 bg-neutral-900 border border-neutral-700 rounded p-2 text-xs shadow-xl min-w-[14rem]"
        style={{ left, top, transform: "translate(0, 0.25rem)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-neutral-400 mb-2">
          Label this box as…
        </div>
        <div className="max-h-56 overflow-auto grid grid-cols-2 gap-1">
          {isLoading && <div className="text-neutral-500">loading…</div>}
          {!isLoading && enabled.length === 0 && (
            <div className="text-neutral-500 col-span-2">
              no enabled classes — add one in Settings → Detection classes
            </div>
          )}
          {enabled.map((c) => (
            <button
              key={c.slug}
              className="text-left px-1 py-0.5 rounded hover:bg-neutral-800 disabled:opacity-50"
              disabled={submitting}
              onClick={() => submit(c.slug)}
            >
              {c.display_name}
            </button>
          ))}
        </div>
        {error && <div className="text-red-400 mt-2">{error}</div>}
        <div className="text-neutral-500 text-[10px] mt-2">
          Esc or click outside to cancel.
        </div>
      </div>
    </>
  );
}

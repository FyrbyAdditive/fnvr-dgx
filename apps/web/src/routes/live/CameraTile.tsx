import { useCallback, useEffect, useRef, useState } from "react";
import type { Camera, PipelineCameraMetrics } from "@/lib/api";
import { DetectionEvent } from "@/lib/events";
import { hasProxyStream } from "@/lib/streams";
import { CameraToggle } from "@/components/CameraToggle";
import { CameraDetectorChips } from "@/components/CameraDetectorChips";
import { CameraContent } from "./CameraContent";
import { StatusDot } from "./StatusChrome";
import { formatRelativeAge } from "@/lib/format";
import type { ConnectionStatus } from "./useWhepStream";

export type TileVariant = "auto" | "focus" | "thumb" | "wall";

export type TileDrag = {
  armed: boolean;
  dragging: boolean;
  hint: "before" | "after" | null;
  onGripDown: () => void;
  onGripUp: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
};

// One camera cell. All four layout variants share the same DOM shape
// (only chrome density changes) so React never remounts a tile — and
// its WHEP session — when the layout or focus changes.
export function CameraTile({
  camera,
  detections,
  inferenceFps,
  metrics,
  showStats,
  deeplink,
  kbFocused,
  isAdmin,
  variant,
  quality,
  style,
  onEnlarge,
  onSelect,
  onHide,
  hqOn,
  onToggleHq,
  drag,
}: {
  camera: Camera;
  detections: DetectionEvent[];
  /** SSE-derived inference fps heuristic (fallback when no real metrics). */
  inferenceFps: number;
  /** Real per-camera fps from the pipeline metrics endpoint, if fresh. */
  metrics?: PipelineCameraMetrics | null;
  showStats: boolean;
  /** Deeplink target (?camera=) — scroll into view + emerald ring. */
  deeplink: boolean;
  kbFocused: boolean;
  isAdmin: boolean;
  variant: TileVariant;
  quality: "auto" | "full" | "proxy";
  style?: React.CSSProperties;
  onEnlarge: () => void;
  /** Thumb click in the Focus layout — swap focus instead of enlarging. */
  onSelect?: () => void;
  onHide?: () => void;
  hqOn?: boolean;
  onToggleHq?: () => void;
  drag?: TileDrag;
}) {
  const tileRef = useRef<HTMLDivElement>(null);
  const [highlight, setHighlight] = useState(false);
  useEffect(() => {
    if (!deeplink) return;
    tileRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setHighlight(true);
    const t = setTimeout(() => setHighlight(false), 2500);
    return () => clearTimeout(t);
  }, [deeplink]);
  useEffect(() => {
    if (kbFocused) tileRef.current?.scrollIntoView({ block: "nearest" });
  }, [kbFocused]);

  const [drawing, setDrawing] = useState(false);
  const [previewFps, setPreviewFps] = useState(0);
  const [conn, setConn] = useState<{ status: ConnectionStatus; lastError: string | null }>({
    status: "connecting",
    lastError: null,
  });
  // Stable identity + bail-out on unchanged values: CameraContent's
  // status effect depends on this callback, so an inline handler that
  // stores a fresh object would re-render in a loop.
  const handleStatusChange = useCallback(
    (status: ConnectionStatus, lastError: string | null) => {
      setConn((prev) =>
        prev.status === status && prev.lastError === lastError ? prev : { status, lastError },
      );
    },
    [],
  );

  const latest = detections[0];
  const active = detections.length > 0;
  const thumb = variant === "thumb";
  const wall = variant === "wall";

  const camState = camera.state;
  const offline =
    !camera.enabled ||
    camState === "failed" ||
    camState === "unknown" ||
    conn.status === "failed";
  const offlineLabel = !camera.enabled
    ? "Camera disabled"
    : camState === "failed"
      ? "Pipeline failed"
      : camState === "unknown"
        ? "Pipeline offline"
        : "No connection";

  // Ring precedence: deeplink > activity > keyboard focus.
  const ring = highlight
    ? "ring-2 ring-emerald-400 shadow-[0_0_24px_rgba(52,211,153,0.55)]"
    : active
      ? "ring-1 ring-amber-400/70 shadow-[0_0_16px_rgba(251,191,36,0.25)]"
      : kbFocused
        ? "ring-2 ring-sky-400"
        : "";

  // Real metrics beat the SSE heuristic when fresh (<45s).
  const metricsFresh =
    metrics && Date.now() - new Date(metrics.updated_at).getTime() < 45_000;
  const statsLine = metricsFresh
    ? `in ${metrics!.input_fps.toFixed(1)} · infer ${metrics!.infer_fps.toFixed(1)} · push ${metrics!.push_fps.toFixed(1)}`
    : `view ${previewFps.toFixed(1)} · infer ~${inferenceFps.toFixed(1)}`;

  const dropHint =
    drag?.hint === "before"
      ? "border-l-2 border-l-emerald-400"
      : drag?.hint === "after"
        ? "border-r-2 border-r-emerald-400"
        : "";

  const chromeVisibility = wall
    ? "opacity-0 group-hover:opacity-100 transition-opacity"
    : "";

  return (
    <div
      ref={tileRef}
      style={style}
      draggable={drag?.armed ?? false}
      onDragStart={drag?.onDragStart}
      onDragEnd={drag?.onDragEnd}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
      className={`group relative overflow-hidden bg-neutral-950 transition-shadow ${
        wall ? "rounded-none border-0" : "rounded-lg border border-neutral-800"
      } ${variant === "auto" || variant === "wall" ? "aspect-video" : ""} ${ring} ${dropHint} ${
        drag?.dragging ? "opacity-50" : ""
      }`}
    >
      <CameraContent
        cameraId={camera.id}
        name={camera.name}
        detections={detections}
        isAdmin={isAdmin && !thumb}
        drawing={drawing}
        onDrawingChange={setDrawing}
        onClickEmpty={onSelect ?? onEnlarge}
        onPreviewFps={showStats && !thumb ? setPreviewFps : undefined}
        quality={quality}
        hasProxy={hasProxyStream(camera)}
        onStatusChange={handleStatusChange}
      />

      {/* Offline / failed treatment — dimmed grayscale poster with a
          centered explanation, unmissable even on a big wall. */}
      {offline && (
        <div className="absolute inset-0 z-[5] backdrop-grayscale bg-neutral-950/70 flex flex-col items-center justify-center gap-1 pointer-events-none">
          <svg
            className={`${thumb ? "w-4 h-4" : "w-6 h-6"} text-neutral-500`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m3.5 0H14a2 2 0 0 1 2 2v3.5l7-4v11l-3-1.714" />
            <line x1="2" y1="2" x2="22" y2="22" />
          </svg>
          {!thumb && (
            <>
              <div className="text-sm text-neutral-300">{offlineLabel}</div>
              {camState === "unknown" && camera.last_heartbeat_at && (
                <div className="text-xs text-neutral-500">
                  last heartbeat {formatRelativeAge(new Date(camera.last_heartbeat_at))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Latest-detection chip. */}
      {latest && !thumb && (
        <div className="absolute top-2 right-2 z-10 text-[11px] px-2 py-0.5 rounded-full bg-sky-500/20 text-sky-200 border border-sky-400/30 backdrop-blur-sm tabular-nums">
          {latest.class_name} {(latest.confidence * 100).toFixed(0)}%
        </div>
      )}

      {/* Bottom gradient bar — the one chrome strip. */}
      <div
        className={`absolute inset-x-0 bottom-0 z-10 flex items-end justify-between gap-2 ${
          thumb ? "px-1.5 pb-1 pt-4" : "px-2.5 pb-1.5 pt-8"
        } bg-gradient-to-t from-black/80 via-black/35 to-transparent pointer-events-none ${chromeVisibility}`}
      >
        <div className="flex items-center gap-2 min-w-0 pointer-events-auto">
          <StatusDot status={conn.status} lastError={conn.lastError} />
          <span className={`${thumb ? "text-[11px]" : "text-xs"} font-medium truncate`}>
            {camera.name}
          </span>
          {camState === "starting" && !thumb && (
            <span className="text-[10px] text-amber-300 whitespace-nowrap">starting…</span>
          )}
          {drawing && !thumb && (
            <button
              className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-700 hover:bg-emerald-600 whitespace-nowrap"
              onClick={(e) => {
                e.stopPropagation();
                setDrawing(false);
              }}
            >
              cancel draw
            </button>
          )}
          {showStats && !thumb && (
            <span
              className="text-[10px] font-mono text-neutral-300 tabular-nums whitespace-nowrap"
              title={
                metricsFresh
                  ? "Pipeline-reported fps: camera input · inference · MediaMTX push"
                  : "view = painted frames/s here · infer ~= detection-event heuristic"
              }
            >
              {statsLine}
            </span>
          )}
          {variant === "focus" && onToggleHq && (
            <button
              className={`text-[10px] px-1.5 py-0.5 rounded border whitespace-nowrap ${
                hqOn
                  ? "bg-sky-600/80 border-sky-500 text-white"
                  : "bg-black/50 border-neutral-600 text-neutral-300 hover:text-white"
              }`}
              title="Full-quality passthrough for the focused camera (falls back to proxy on failure)"
              onClick={(e) => {
                e.stopPropagation();
                onToggleHq();
              }}
            >
              HQ
            </button>
          )}
        </div>
        {!thumb && (
          <div className="flex items-center gap-1 pointer-events-auto">
            {drag && (
              <button
                className="text-xs px-1 py-0.5 rounded bg-black/50 hover:bg-black/80 cursor-grab text-neutral-400"
                title="Drag to reorder"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  drag.onGripDown();
                }}
                onPointerUp={drag.onGripUp}
                onClick={(e) => e.stopPropagation()}
              >
                ⠿
              </button>
            )}
            {isAdmin && (
              <AdminMenu
                camera={camera}
                drawing={drawing}
                onStartDraw={() => setDrawing(true)}
                onHide={onHide}
              />
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onEnlarge();
              }}
              className="text-xs px-1.5 py-0.5 rounded bg-black/50 hover:bg-black/80"
              title="Open in enlarged view"
              aria-label={`Enlarge ${camera.name}`}
            >
              ⛶
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Always-visible ⋯ menu replacing the old hover-only admin cluster —
// usable on touch, discoverable by everyone. Outside-click close per
// the AlarmPill pattern.
function AdminMenu({
  camera,
  drawing,
  onStartDraw,
  onHide,
}: {
  camera: Camera;
  drawing: boolean;
  onStartDraw: () => void;
  onHide?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className="text-xs px-1.5 py-0.5 rounded bg-black/50 hover:bg-black/80"
        title="Camera controls"
        aria-label={`Controls for ${camera.name}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        ⋯
      </button>
      {open && (
        <div
          className="absolute bottom-8 right-0 z-30 w-60 rounded-lg border border-neutral-700 bg-neutral-900 shadow-xl p-2 space-y-2 text-left"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between gap-2 py-1">
            <span className="text-xs text-neutral-400">Camera</span>
            <CameraToggle cameraId={camera.id} enabled={camera.enabled} variant="inline" />
          </div>
          <div className="flex items-start justify-between gap-2 py-1">
            <span className="text-xs text-neutral-400">Detectors</span>
            <CameraDetectorChips
              cameraId={camera.id}
              enabledDetectors={camera.enabled_detectors ?? []}
              disabled={!camera.enabled}
              variant="inline"
            />
          </div>
          {!drawing && (
            <button
              className="w-full text-left text-xs py-2 px-1 rounded hover:bg-neutral-800 text-neutral-200"
              title="Draw a label box on this tile to add a YOLO training sample"
              onClick={() => {
                onStartDraw();
                setOpen(false);
              }}
            >
              + Label box
            </button>
          )}
          {onHide && (
            <button
              className="w-full text-left text-xs py-2 px-1 rounded hover:bg-neutral-800 text-neutral-200"
              onClick={() => {
                onHide();
                setOpen(false);
              }}
            >
              Hide from grid
            </button>
          )}
        </div>
      )}
    </div>
  );
}

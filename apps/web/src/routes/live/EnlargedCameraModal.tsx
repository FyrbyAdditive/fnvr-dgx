import { useEffect, useRef, useState } from "react";
import { CameraContent } from "./CameraContent";
import { CameraToggle } from "@/components/CameraToggle";
import { CameraDetectorChips } from "@/components/CameraDetectorChips";
import { DetectionEvent } from "@/lib/events";

// EnlargedCameraModal opens a single camera filling most of the viewport
// on top of the Live mosaic. Same interactivity as a tile — bbox click
// to flag, draw button to label new boxes — just bigger. The tile keeps
// streaming behind the modal so close feels instant.
//
// Affordances:
// - Click backdrop or press Esc → close.
// - ⛶ button → browser fullscreen on the video container.
// - + label / cancel draw → admin-only manual-label drawer.
// - bbox click → flag popover (handled inside CameraContent).
//
// iOS Safari fallback: webkitEnterFullscreen() on the <video> when
// Element.requestFullscreen isn't available.
export function EnlargedCameraModal({
  cameraId,
  cameraName,
  enabled,
  enabledDetectors,
  state,
  lastHeartbeatAt,
  detections,
  isAdmin,
  onClose,
}: {
  cameraId: string;
  cameraName: string;
  enabled: boolean;
  enabledDetectors: string[];
  state?: "starting" | "running" | "failed" | "unknown";
  lastHeartbeatAt?: string | null;
  detections: DetectionEvent[];
  isAdmin: boolean;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFs, setIsFs] = useState(false);
  const [drawing, setDrawing] = useState(false);

  // Esc closes. (Browsers eat the first Esc to leave fullscreen, so a
  // user inside fullscreen needs two presses — that's intuitive.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (document.fullscreenElement) return;
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Body scroll lock while open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Track fullscreen state via the standard event so user-initiated
  // exits (Esc / browser controls) re-sync the icon.
  useEffect(() => {
    const onChange = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Make sure we exit fullscreen on unmount — Chrome otherwise leaves
  // the page in a stale fullscreen state.
  useEffect(() => {
    return () => {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => { /* ignore */ });
      }
    };
  }, []);

  async function toggleFullscreen() {
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => { /* ignore */ });
      return;
    }
    const container = containerRef.current;
    if (container?.requestFullscreen) {
      await container.requestFullscreen().catch(() => { /* ignore */ });
      return;
    }
    // iOS Safari: only the <video> supports the legacy webkit
    // fullscreen API. Reach into the CameraContent's first <video>
    // child via DOM query — there's exactly one.
    const v = container?.querySelector("video") as (HTMLVideoElement & {
      webkitEnterFullscreen?: () => void;
    }) | null;
    v?.webkitEnterFullscreen?.();
  }

  const latest = detections[0];

  return (
    <div
      className="fixed inset-0 bg-black/85 z-50 flex items-center justify-center p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Enlarged view: ${cameraName}`}
    >
      <div
        ref={containerRef}
        onClick={(e) => e.stopPropagation()}
        className="relative w-[min(95vw,90rem)] h-[min(90vh,55rem)] bg-black rounded shadow-2xl overflow-hidden flex items-center justify-center"
      >
        <CameraContent
          cameraId={cameraId}
          name={cameraName}
          detections={detections}
          isAdmin={isAdmin}
          drawing={drawing}
          onDrawingChange={setDrawing}
          fitTo="container"
        />

        <header className="absolute top-0 inset-x-0 z-10 flex items-center justify-between px-3 py-2 bg-gradient-to-b from-black/70 to-transparent text-sm">
          <div className="flex items-center gap-2">
            <span className="font-medium">{cameraName}</span>
            {isAdmin && (
              <>
                <CameraToggle cameraId={cameraId} enabled={enabled} variant="overlay" />
                <CameraDetectorChips
                  cameraId={cameraId}
                  enabledDetectors={enabledDetectors}
                  disabled={!enabled}
                  variant="overlay"
                />
                <button
                  type="button"
                  onClick={() => setDrawing((d) => !d)}
                  className={`text-xs px-2 py-0.5 rounded ${
                    drawing
                      ? "bg-emerald-700 hover:bg-emerald-600"
                      : "bg-neutral-800/80 hover:bg-neutral-700"
                  } border border-neutral-700`}
                  title="Draw a label box to add a YOLO training sample"
                >
                  {drawing ? "cancel draw" : "+ label"}
                </button>
              </>
            )}
          </div>
          <div className="flex items-center gap-1">
            {latest && (
              <div className="text-xs bg-blue-600/80 px-2 py-0.5 rounded mr-2">
                {latest.class_name} {(latest.confidence * 100).toFixed(0)}%
              </div>
            )}
            <button
              type="button"
              onClick={toggleFullscreen}
              className="px-2 py-1 rounded bg-neutral-800/80 hover:bg-neutral-700 text-neutral-200"
              title={isFs ? "Exit fullscreen" : "Fullscreen"}
              aria-label={isFs ? "Exit fullscreen" : "Enter fullscreen"}
            >
              {isFs ? "⤡" : "⛶"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-2 py-1 rounded bg-neutral-800/80 hover:bg-neutral-700 text-neutral-200"
              title="Close"
              aria-label="Close enlarged view"
            >
              ✕
            </button>
          </div>
        </header>

        {state && state !== "running" && (
          <div className="absolute top-12 left-3 z-10">
            <StateBadgeMini state={state} lastHeartbeatAt={lastHeartbeatAt} />
          </div>
        )}
      </div>
    </div>
  );
}

// Local copy of the StateBadge styling — Live.tsx's StateBadge is
// tile-positioned with absolute top-2 left-2 which would clash with
// the modal header. Keep the same colours and pulse animation.
function StateBadgeMini({ state, lastHeartbeatAt }: {
  state: "starting" | "failed" | "unknown" | string;
  lastHeartbeatAt?: string | null;
}) {
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
    <div className={`text-xs ${color} px-2 py-0.5 rounded flex items-center gap-1.5`}>
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

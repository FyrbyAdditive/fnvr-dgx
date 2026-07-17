import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Dialog } from "@/components/ui/Dialog";
import { CameraToggle } from "@/components/CameraToggle";
import { CameraDetectorChips } from "@/components/CameraDetectorChips";
import type { Camera, PipelineCameraMetrics } from "@/lib/api";
import { DetectionEvent } from "@/lib/events";
import { hasProxyStream } from "@/lib/streams";
import { CameraContent } from "./CameraContent";
import { QualityPill, StateBadge } from "./StatusChrome";
import type { ModalQuality } from "./useLivePrefs";
import type { ConnectionStatus } from "./useWhepStream";

// EnlargedCameraModal opens a single camera filling most of the viewport
// on top of the Live mosaic. Same interactivity as a tile — bbox click
// to flag, draw button to label new boxes — just bigger, and at full
// passthrough quality by default.
//
// Quality: [Auto | Full | Proxy]. Auto starts on the passthrough and
// automatically drops to the NVENC proxy on hard failure (H.265
// B-frame cameras can't ride WebRTC at all on the passthrough path) —
// visibly, via the amber pill, and reversibly. Full never falls back.
//
// Extras vs a tile: browser fullscreen (f), rewind deeplinks into the
// Timeline, and full-resolution snapshot download.
export function EnlargedCameraModal({
  camera,
  detections,
  metrics,
  showStats,
  isAdmin,
  quality,
  onQualityChange,
  onClose,
}: {
  camera: Camera;
  detections: DetectionEvent[];
  metrics?: PipelineCameraMetrics | null;
  showStats: boolean;
  isAdmin: boolean;
  quality: ModalQuality;
  onQualityChange: (q: ModalQuality) => void;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const [isFs, setIsFs] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const [conn, setConn] = useState<ConnectionStatus>("connecting");
  const [previewFps, setPreviewFps] = useState(0);
  // Bumping the key remounts CameraContent, which resets the sticky
  // auto-degrade — the "retry full quality" mechanism.
  const [contentKey, setContentKey] = useState(0);

  const proxyAvailable = hasProxyStream(camera);

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

  // f toggles fullscreen while the modal is open (inert while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "f" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && t.closest("input,textarea,select,[contenteditable=true]")) return;
      toggleFullscreen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  async function saveSnapshot() {
    const stamp = new Date()
      .toISOString()
      .replace(/[:T]/g, "-")
      .slice(0, 19);
    const filename = `${camera.name.replace(/[^\w-]+/g, "_")}-${stamp}.jpg`;
    let blob: Blob | null = null;
    const video = containerRef.current?.querySelector("video") ?? null;
    if (conn === "live" && video && video.videoWidth) {
      // Full-quality current frame straight off the decoder.
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")?.drawImage(video, 0, 0);
      blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.92),
      );
    }
    if (!blob) {
      try {
        const res = await fetch(
          `/api/v1/cameras/${encodeURIComponent(camera.id)}/snapshot.jpg`,
          { credentials: "include" },
        );
        if (res.ok) blob = await res.blob();
      } catch {
        /* fall through */
      }
    }
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  const rewind = (secs: number) => {
    navigate(
      `/timeline?camera=${encodeURIComponent(camera.id)}&ts=${new Date(Date.now() - secs * 1000).toISOString()}`,
    );
  };

  const latest = detections[0];
  const metricsFresh =
    metrics && Date.now() - new Date(metrics.updated_at).getTime() < 45_000;

  const qualities: { key: ModalQuality; label: string; disabled?: boolean }[] = [
    { key: "auto", label: "Auto" },
    { key: "full", label: "Full" },
    { key: "proxy", label: "Proxy", disabled: !proxyAvailable },
  ];

  return (
    <Dialog
      open
      onClose={() => {
        // Browsers eat the first Esc to leave fullscreen; a user inside
        // fullscreen needs two presses — that's intuitive.
        if (document.fullscreenElement) return;
        onClose();
      }}
      ariaLabel={`Enlarged view: ${camera.name}`}
      panelClassName="relative w-[min(95vw,90rem)] h-[min(90vh,55rem)] bg-black rounded-lg shadow-2xl overflow-hidden p-0"
      panelRef={containerRef}
    >
      <CameraContent
        key={contentKey}
        cameraId={camera.id}
        name={camera.name}
        detections={detections}
        isAdmin={isAdmin}
        drawing={drawing}
        onDrawingChange={setDrawing}
        onPreviewFps={showStats ? setPreviewFps : undefined}
        quality={quality}
        hasProxy={proxyAvailable}
        onStatusChange={(s) => setConn(s)}
        onDegradedChange={setDegraded}
      />

      <header className="absolute top-0 inset-x-0 z-10 flex items-center justify-between px-3 py-2 bg-gradient-to-b from-black/70 to-transparent text-sm">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium truncate">{camera.name}</span>
          {isAdmin && (
            <>
              <CameraToggle cameraId={camera.id} enabled={camera.enabled} variant="overlay" />
              <CameraDetectorChips
                cameraId={camera.id}
                enabledDetectors={camera.enabled_detectors ?? []}
                disabled={!camera.enabled}
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
          {degraded && (
            <QualityPill onRetry={() => setContentKey((k) => k + 1)} />
          )}
        </div>
        <div className="flex items-center gap-1">
          {latest && (
            <div className="text-[11px] px-2 py-0.5 rounded-full bg-sky-500/20 text-sky-200 border border-sky-400/30 backdrop-blur-sm tabular-nums mr-1">
              {latest.class_name} {(latest.confidence * 100).toFixed(0)}%
            </div>
          )}
          {/* Quality selector. */}
          <div className="inline-flex rounded-md border border-neutral-700 overflow-hidden mr-1">
            {qualities.map((q) => (
              <button
                key={q.key}
                type="button"
                disabled={q.disabled}
                title={
                  q.disabled
                    ? "No proxy stream for this camera"
                    : q.key === "auto"
                      ? "Full quality, automatic proxy fallback on failure"
                      : q.key === "full"
                        ? "Full-quality passthrough, never falls back"
                        : "NVENC proxy (≤540p, instant join)"
                }
                onClick={() => onQualityChange(q.key)}
                className={`px-2 py-0.5 text-[11px] ${
                  quality === q.key
                    ? "bg-neutral-700 text-white"
                    : "bg-neutral-900/70 text-neutral-400 hover:text-neutral-200"
                } ${q.disabled ? "opacity-40 cursor-not-allowed" : ""}`}
              >
                {q.label}
              </button>
            ))}
          </div>
          {/* Rewind into the Timeline at now-N. */}
          <button
            type="button"
            onClick={() => rewind(30)}
            className="px-2 py-1 rounded bg-neutral-800/80 hover:bg-neutral-700 text-neutral-200 text-xs"
            title="Open the Timeline 30 seconds ago"
          >
            ⏪ 30s
          </button>
          <button
            type="button"
            onClick={() => rewind(120)}
            className="px-2 py-1 rounded bg-neutral-800/80 hover:bg-neutral-700 text-neutral-200 text-xs"
            title="Open the Timeline 2 minutes ago"
          >
            ⏪ 2m
          </button>
          <button
            type="button"
            onClick={saveSnapshot}
            className="px-2 py-1 rounded bg-neutral-800/80 hover:bg-neutral-700 text-neutral-200"
            title="Save a snapshot of the current frame"
            aria-label="Save snapshot"
          >
            ⬇
          </button>
          <button
            type="button"
            onClick={toggleFullscreen}
            className="px-2 py-1 rounded bg-neutral-800/80 hover:bg-neutral-700 text-neutral-200"
            title={isFs ? "Exit fullscreen (f)" : "Fullscreen (f)"}
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

      {camera.state && camera.state !== "running" && (
        <div className="absolute top-12 left-3 z-10">
          <StateBadge state={camera.state} lastHeartbeatAt={camera.last_heartbeat_at} />
        </div>
      )}

      {showStats && (
        <div className="absolute bottom-2 right-2 z-10 text-[10px] font-mono bg-black/70 text-neutral-200 px-2 py-0.5 rounded space-x-2 tabular-nums">
          {metricsFresh ? (
            <span title="Pipeline-reported fps: camera input · inference · MediaMTX push">
              in {metrics!.input_fps.toFixed(1)} · infer {metrics!.infer_fps.toFixed(1)} · push {metrics!.push_fps.toFixed(1)}
            </span>
          ) : (
            <span title="Painted frames/s in this view">view {previewFps.toFixed(1)} fps</span>
          )}
          <span className="opacity-60">·</span>
          <span>{degraded || quality === "proxy" ? "proxy" : "passthrough"}</span>
          <span className="opacity-60">·</span>
          <span>{conn}</span>
        </div>
      )}
    </Dialog>
  );
}

import { useEffect, useRef, useState } from "react";
import { useWhepStream } from "./useWhepStream";

// EnlargedCameraModal opens a single camera's WebRTC stream filling most
// of the viewport, on top of the Live mosaic. The mosaic keeps streaming
// behind the modal — closing the modal returns to it instantly. A second
// MediaMTX WHEP subscriber per camera is fine; MediaMTX serves multiple
// readers cheaply.
//
// Affordances:
// - Click the dim backdrop or press Esc to close.
// - The ⛶ button toggles browser fullscreen on the video container.
//   Esc inside fullscreen drops out of fullscreen first, second Esc
//   closes the modal (browsers handle the first Esc themselves).
// - iOS Safari fallback: if Element.requestFullscreen isn't available,
//   we call <video>.webkitEnterFullscreen() so the user still gets a
//   full-screen video. The modal chrome is invisible during that;
//   the user exits via Safari's own controls.
export function EnlargedCameraModal({
  cameraId,
  cameraName,
  onClose,
}: {
  cameraId: string;
  cameraName: string;
  onClose: () => void;
}) {
  const { videoRef, rtcLive } = useWhepStream(cameraId);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFs, setIsFs] = useState(false);

  // Esc closes. (Browsers eat the first Esc to leave fullscreen, so a
  // user inside fullscreen needs two presses — that's intuitive.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // If we're still in fullscreen, the browser is going to handle
        // this Esc itself — don't also close the modal.
        if (document.fullscreenElement) return;
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Body scroll lock while the modal is open.
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
  // the page in a stale fullscreen state where the next click does
  // nothing.
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
    // iOS Safari fallback — only the <video> element supports the
    // legacy webkit fullscreen API.
    const v = videoRef.current as HTMLVideoElement & {
      webkitEnterFullscreen?: () => void;
    } | null;
    v?.webkitEnterFullscreen?.();
  }

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
        className="relative w-[min(95vw,80rem)] aspect-video bg-black rounded shadow-2xl overflow-hidden"
      >
        {rtcLive ? (
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="absolute inset-0 w-full h-full object-contain"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-neutral-500">
            connecting…
          </div>
        )}

        <header className="absolute top-0 inset-x-0 flex items-center justify-between px-3 py-2 bg-gradient-to-b from-black/70 to-transparent text-sm">
          <span className="font-medium">{cameraName}</span>
          <div className="flex items-center gap-1">
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
      </div>
    </div>
  );
}

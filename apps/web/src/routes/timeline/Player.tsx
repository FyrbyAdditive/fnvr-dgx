import { useEffect, useRef, useState } from "react";
import { api, HistoricDetection } from "@/lib/api";
import { CameraToggle } from "@/components/CameraToggle";
import { CameraDetectorChips } from "@/components/CameraDetectorChips";
import { PlayerOverlay } from "./PlayerOverlay";

const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
const isFirefox = /Firefox\//.test(ua);
const isSafari = !isFirefox && /^((?!chrome|android).)*safari/i.test(ua);

/** Per-browser playback window — the single source of truth shared by
 *  the Player's fetch and Timeline's auto-advance (they used to
 *  disagree: Player asked Safari for 60s while auto-advance skipped
 *  ahead a whole hour, silently dropping 59 minutes per clip).
 *
 *  Chrome streams the chunked fMP4 as it arrives; Firefox does the
 *  same via MSE — both can ask for a long window cheaply. Safari
 *  downloads the whole response as a Blob before showing the first
 *  frame (the only way it'll play chunked-without-Range MP4), so a
 *  1-hour window means a 1-hour buffered download. Keep its window
 *  short; auto-advance chains the next clip on demand. */
export function playbackWindowSec(): number {
  return isSafari ? 60 : 3600;
}

// Downloads stream straight to disk — Blob buffering doesn't apply —
// so every browser saves the full hour regardless of playback window.
const DOWNLOAD_WINDOW_SEC = 3600;

export function Player({
  startDate,
  onEnded,
  detections,
  cameraId,
  cameraEnabled,
  cameraEnabledDetectors,
  isAdmin,
  startOffsetMs = 0,
  matchWindowMs = 250,
}: {
  /** Wall-clock instant the user clicked. Player asks MediaMTX for a
   *  window starting here; the returned fMP4 begins at this moment, so
   *  there's no loadedmetadata-seek dance. (Measured 2026-07-17: /get
   *  honors sub-second starts to within one frame — no snapping.) */
  startDate: Date | null;
  onEnded: () => void;
  /** If provided, draw bounding boxes + class labels on the player
   *  using detections whose ts is near the current video frame. If
   *  undefined, overlay is disabled (default). */
  detections?: HistoricDetection[];
  cameraId: string;
  cameraEnabled?: boolean;
  cameraEnabledDetectors?: string[];
  isAdmin: boolean;
  /** Compensation added to the wall-clock base if playback ever turns
   *  out to start earlier/later than requested. Measured 0 for
   *  MediaMTX /get (see startDate doc); kept as a knob. */
  startOffsetMs?: number;
  /** Half-width of the overlay's "current detections" window. ±250ms
   *  covers ~15 fps detection rates and keeps latest boxes visible
   *  across skipped frames. */
  matchWindowMs?: number;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const url = startDate
    ? api.playbackUrl(cameraId, startDate, playbackWindowSec())
    : "";

  // Per-browser playback strategy. MediaMTX's `/get` returns a
  // single chunked fMP4 stream with `Accept-Ranges: none` — each
  // browser handles that differently:
  //
  //  Chrome  bare <video src=URL> works (buffers and plays
  //          forward as bytes arrive).
  //  Firefox refuses chunked-without-Range; needs MediaSource
  //          Extensions feeding fragments to a SourceBuffer.
  //  Safari  refuses chunked-without-Range AND its MSE is too
  //          strict about codec strings to feed sniffed fMP4
  //          reliably. We fetch the whole response as a Blob and
  //          hand the resulting object URL to <video> — Safari
  //          plays Blob URLs cleanly because they have a known
  //          size. Tradeoff: viewer waits for the full window to
  //          download before the first frame; we keep the window
  //          short to make this acceptable.
  useEffect(() => {
    if (!url || !ref.current) return;
    const v = ref.current;
    if (isSafari) {
      // Fetch as Blob so Safari's <video> sees a known-size
      // resource. AbortController cancels the fetch on segment
      // change so we don't waste bandwidth.
      const ctrl = new AbortController();
      let blobUrl: string | null = null;
      (async () => {
        try {
          const res = await fetch(url, { signal: ctrl.signal });
          if (!res.ok) {
            v.removeAttribute("src");
            return;
          }
          const blob = await res.blob();
          if (ctrl.signal.aborted) return;
          blobUrl = URL.createObjectURL(blob);
          v.src = blobUrl;
        } catch {
          /* aborted or network failure */
        }
      })();
      return () => {
        ctrl.abort();
        if (blobUrl) URL.revokeObjectURL(blobUrl);
      };
    }
    if (!isFirefox || typeof MediaSource === "undefined") {
      v.src = url;
      return;
    }
    const ms = new MediaSource();
    const objectUrl = URL.createObjectURL(ms);
    v.src = objectUrl;
    let cancelled = false;
    let abortCtrl: AbortController | null = null;
    const onSourceOpen = async () => {
      if (cancelled) return;
      try {
        abortCtrl = new AbortController();
        const res = await fetch(url, { signal: abortCtrl.signal });
        if (!res.ok || !res.body) {
          ms.endOfStream("network");
          return;
        }
        // Sniff the first chunk for the codec marker. fMP4 starts
        // with `ftyp` then `moov`; `moov.trak.mdia.minf.stbl.stsd`
        // contains either `avc1` (H.264) or `hvc1` (H.265). We do a
        // crude byte-search for the four-CC; good enough for our
        // single-codec recordings.
        const reader = res.body.getReader();
        const probe = await reader.read();
        if (!probe.value || probe.done) {
          ms.endOfStream("network");
          return;
        }
        const head = probe.value;
        const codec = sniffCodec(head);
        if (!codec) {
          ms.endOfStream("decode");
          return;
        }
        const sb = ms.addSourceBuffer(`video/mp4; codecs="${codec}"`);
        const queue: Uint8Array[] = [head];
        let writing = false;
        const drain = () => {
          if (cancelled || writing || queue.length === 0 || sb.updating) return;
          writing = true;
          try {
            const next = queue.shift()!;
            // TS narrows Uint8Array to ArrayBufferLike-backed which
            // doesn't structurally match `BufferSource` in some lib
            // versions. Cast through ArrayBuffer to satisfy the
            // checker; the runtime call is identical.
            sb.appendBuffer(next as unknown as ArrayBuffer);
          } catch {
            writing = false;
          }
        };
        sb.addEventListener("updateend", () => {
          writing = false;
          drain();
        });
        drain();
        // Keep reading until the server closes.
        for (;;) {
          if (cancelled) break;
          const { value, done } = await reader.read();
          if (done) {
            // Wait for queue to drain, then close.
            const waitDrain = () => {
              if (cancelled) return;
              if (!writing && queue.length === 0 && !sb.updating) {
                try { ms.endOfStream(); } catch { /* state race */ }
              } else {
                setTimeout(waitDrain, 100);
              }
            };
            waitDrain();
            break;
          }
          if (value) {
            queue.push(value);
            drain();
          }
        }
      } catch {
        if (!cancelled) {
          try { ms.endOfStream("network"); } catch { /* ignore */ }
        }
      }
    };
    ms.addEventListener("sourceopen", onSourceOpen);
    return () => {
      cancelled = true;
      if (abortCtrl) abortCtrl.abort();
      try { URL.revokeObjectURL(objectUrl); } catch { /* ignore */ }
    };
  }, [url]);

  // Track the video's wall-clock timestamp while it plays so the
  // overlay below can redraw boxes as frames advance. rVFC fires per
  // decoded frame when supported; fallback to a 10Hz rAF-ish timer.
  // Wall-clock = startDate + video.currentTime — MediaMTX /get returns
  // a clip that starts AT startDate, so the offset is just currentTime.
  const [wallMs, setWallMs] = useState<number | null>(null);
  const [videoSize, setVideoSize] = useState<{ w: number; h: number }>({ w: 16, h: 9 });
  useEffect(() => {
    if (!startDate || detections === undefined || !ref.current) {
      setWallMs(null);
      return;
    }
    const v = ref.current as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    const startMs = startDate.getTime() + startOffsetMs;
    let cancelled = false;
    const push = () => {
      if (cancelled) return;
      setWallMs(startMs + v.currentTime * 1000);
    };
    if (typeof v.requestVideoFrameCallback === "function") {
      const step = () => {
        if (cancelled) return;
        push();
        v.requestVideoFrameCallback!(step);
      };
      v.requestVideoFrameCallback!(step);
    } else {
      const h = setInterval(push, 100);
      return () => { cancelled = true; clearInterval(h); };
    }
    return () => { cancelled = true; };
  }, [startDate, detections, startOffsetMs]);

  // Observe intrinsic video size so the overlay can size a matching
  // letterboxed inner frame (same trick Live tiles use).
  useEffect(() => {
    if (!ref.current) return;
    const v = ref.current;
    const update = () => {
      if (v.videoWidth && v.videoHeight) {
        setVideoSize({ w: v.videoWidth, h: v.videoHeight });
      }
    };
    v.addEventListener("loadedmetadata", update);
    update();
    return () => v.removeEventListener("loadedmetadata", update);
  }, [startDate]);

  if (!startDate) {
    return (
      <div className="h-full flex items-center justify-center text-neutral-500 text-sm">
        Click the timeline to play
      </div>
    );
  }
  // Don't hide the player on onError — MediaMTX's /get returns
  // chunked transfer without Range support, which makes <video> fire
  // onError on some browsers even when bytes are flowing. Log the
  // reason for debugging instead and let the element keep trying.
  // If the URL is genuinely 404, the element shows the browser's
  // native unplayable state and the operator can pick a different
  // moment on the timeline.

  // When overlay is on, compute which detections are "current" for
  // the active video frame.
  let active: HistoricDetection[] = [];
  if (detections && wallMs != null) {
    const lo = wallMs - matchWindowMs;
    const hi = wallMs + matchWindowMs;
    for (const d of detections) {
      const t = new Date(d.ts).getTime();
      if (t >= lo && t <= hi) active.push(d);
    }
  }

  // Use the requested start instant as the React key — when the
  // operator clicks a new spot on the timeline, this changes and the
  // <video> re-mounts with the fresh URL (without that, srcObject /
  // src may not switch cleanly mid-playback).
  const playerKey = `${cameraId}@${startDate.toISOString()}`;
  // Download button: ask MediaMTX for a full hour as a progressive
  // MP4 (format=mp4 stitches fMP4 fragments into a single moov-at-end
  // file) and let the browser save it. Filename comes from MediaMTX's
  // Content-Disposition.
  const downloadUrl = api.playbackUrl(cameraId, startDate, DOWNLOAD_WINDOW_SEC, {
    download: true,
  });

  return (
    <div className="group relative w-full h-full flex items-center justify-center">
      <video
        ref={ref}
        key={playerKey}
        controls
        autoPlay
        playsInline
        onEnded={onEnded}
        className="w-full h-full object-contain bg-black"
      />
      {/* Overlay container mirrors the video's letterboxed content box
          so bbox coords (0..1 of source) land on the actual visible
          pixels, not on the black bars. */}
      {detections !== undefined && active.length > 0 && (
        <PlayerOverlay
          videoRef={ref}
          videoSize={videoSize}
          detections={active}
          isAdmin={isAdmin}
        />
      )}
      <div className="absolute top-2 right-2 z-10 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {isAdmin && cameraId && cameraEnabled !== undefined && (
          <>
            <CameraToggle cameraId={cameraId} enabled={cameraEnabled} variant="overlay" />
            <CameraDetectorChips
              cameraId={cameraId}
              enabledDetectors={cameraEnabledDetectors ?? []}
              disabled={!cameraEnabled}
              variant="overlay"
            />
          </>
        )}
        {/* Download is available to admins and viewers — these are
            clips the user is already allowed to watch; gating download
            would just be theatre. */}
        <a
          href={downloadUrl}
          download
          className="text-xs px-2 py-1 rounded border bg-neutral-900/80 border-neutral-700 text-neutral-300 hover:text-white"
          title="Download this hour as MP4"
        >
          ↓ download
        </a>
      </div>
    </div>
  );
}

// Sniff the MP4 codec from the first chunk of an fMP4 stream. We
// look for the standard sample-description four-CCs and pull out
// the AVC config or HEVC config bytes that immediately follow, so
// MSE's addSourceBuffer gets a precise codec string (Firefox is
// strict — `avc1` or `hvc1` alone won't match).
function sniffCodec(buf: Uint8Array): string | null {
  // ASCII for the box names we care about.
  const find = (needle: string, from = 0) => {
    const a = needle.charCodeAt(0);
    const b = needle.charCodeAt(1);
    const c = needle.charCodeAt(2);
    const d = needle.charCodeAt(3);
    for (let i = from; i + 3 < buf.length; i++) {
      if (buf[i] === a && buf[i + 1] === b && buf[i + 2] === c && buf[i + 3] === d) {
        return i;
      }
    }
    return -1;
  };
  // H.264 — `avc1` four-CC, then 78 bytes of VisualSampleEntry,
  // then `avcC` config box. Profile/level live in the avcC payload
  // at offset +1, +2, +3 (profile_idc, profile_compat, level_idc).
  let i = find("avc1");
  if (i >= 0) {
    const cfg = find("avcC", i);
    if (cfg >= 0 && cfg + 12 < buf.length) {
      const profile = buf[cfg + 5];
      const compat = buf[cfg + 6];
      const level = buf[cfg + 7];
      const hex = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
      return `avc1.${hex(profile)}${hex(compat)}${hex(level)}`;
    }
    return "avc1.42E01E"; // fallback: baseline 3.0
  }
  // H.265 — `hvc1` four-CC, then `hvcC` config. Spec is detailed;
  // for MSE the codec string format is hvc1.{profileSpace
  // }{profile}.{compat}.{tier}{level}.{constraintFlags}. We
  // construct the safe Apple-flavoured default which Safari +
  // Chrome on Apple Silicon both accept; Firefox doesn't decode
  // HEVC at all so a precise string here doesn't help it.
  i = find("hvc1");
  if (i >= 0) return "hvc1.1.6.L93.B0";
  return null;
}

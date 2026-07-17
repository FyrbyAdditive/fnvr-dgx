import { useEffect, useRef, useState } from "react";
import { mtxWhepUrl, StreamPrefix } from "@/lib/streams";

// useWhepStream subscribes to a camera's MediaMTX WHEP endpoint and
// exposes the resulting MediaStream attached to a <video> ref, plus a
// real connection status the UI can render.
//
// Connection lifecycle:
// - On mount (and whenever `cameraId`/`pathPrefix` change), open a
//   MediaMTXWebRTCReader from the vendored public/mtx-reader.js.
//   Closes on unmount. The reader self-retries failed negotiations
//   every ~2 s and reports each failure via onError.
// - Frame-stall watchdog (see the watchdog effect). This catches the
//   "MediaMTX discarded a slow reader's frames, decoder lost I-frame
//   reference, <video> stuck on last good frame" failure mode — but ONLY
//   once the session has painted at least one frame. A reader that joins
//   mid-GOP legitimately paints NOTHING until the camera's next IDR, and
//   these are passthrough streams: the camera dictates the GOP (a real
//   fleet camera measured 34 s between IDRs). Re-negotiating during that
//   wait RESETS the IDR wait, so an eager watchdog turns a slow join
//   into an infinite reconnect loop. Pre-first-frame we therefore allow
//   a 60 s grace; post-first-frame a 10 s stall forces re-negotiation.
// - 10s retry while the WHEP session is down (no track yet) so a tile
//   whose pipeline wasn't ready at mount time recovers without a page
//   refresh. Established sessions are owned by the frame-stall watchdog
//   only.
//
// Status semantics (what the UI binds):
//   connecting    — negotiating; no track yet
//   waiting_frame — track attached, waiting for the first painted frame
//                   (mid-GOP join on passthrough streams)
//   live          — painting frames
//   reconnecting  — was live, lost frames/errored; renegotiating
//   failed        — repeated hard errors (e.g. MediaMTX rejects
//                   H.265+B-frame readers) or first-frame grace expired;
//                   retries continue underneath
// The JPEG-fallback display state is derived by the consumer — this
// hook only knows about WebRTC.
export type WhepStatus =
  | "connecting"
  | "waiting_frame"
  | "live"
  | "reconnecting"
  | "failed";

export type ConnectionStatus = WhepStatus | "fallback_jpeg";

const FIRST_FRAME_GRACE_MS = 60_000;
const STALL_MS = 10_000;
// Consecutive onError count that flips a never-painted session to
// "failed". The vendored reader retries every ~2 s, so 5 ≈ 10 s of a
// hard-failing camera (B-frame rejection) — distinct from a slow GOP
// join, which produces no errors at all.
const HARD_FAIL_ERRORS = 5;

export function useWhepStream(
  cameraId: string,
  opts?: { pathPrefix?: StreamPrefix },
) {
  const pathPrefix: StreamPrefix = opts?.pathPrefix ?? "live_";
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<WhepStatus>("connecting");
  const [lastError, setLastError] = useState<string | null>(null);
  const [streamObj, setStreamObj] = useState<MediaStream | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  // errorCount/everLive are state (not just refs) so consumers like
  // useStreamQuality can react to them; the refs mirror them for the
  // event handlers.
  const [errorCount, setErrorCount] = useState(0);
  const [everLive, setEverLive] = useState(false);

  // Per-session state for the watchdog + status machine.
  const sessionStartRef = useRef<number>(Date.now());
  const gotFrameRef = useRef(false);
  const everLiveRef = useRef(false);
  const errorCountRef = useRef(0);
  const statusRef = useRef<WhepStatus>("connecting");
  const set = (s: WhepStatus) => {
    if (statusRef.current !== s) {
      statusRef.current = s;
      setStatus(s);
    }
  };
  const bumpErrors = () => {
    errorCountRef.current += 1;
    setErrorCount(errorCountRef.current);
  };
  const clearErrors = () => {
    if (errorCountRef.current !== 0) {
      errorCountRef.current = 0;
      setErrorCount(0);
    }
  };

  useEffect(() => {
    let cancelled = false;
    sessionStartRef.current = Date.now();
    gotFrameRef.current = false;
    // everLive/errorCount persist across renegotiations of the SAME
    // camera+prefix (a stalled reconnect shouldn't reset the failure
    // memory) — they reset only when the target stream changes.
    const Reader = (window as unknown as {
      MediaMTXWebRTCReader?: new (conf: {
        url: string;
        onError?: (e: string) => void;
        onTrack?: (e: RTCTrackEvent) => void;
      }) => { close: () => void };
    }).MediaMTXWebRTCReader;
    if (!Reader) {
      set("failed");
      setLastError("mtx-reader.js not loaded");
      return;
    }
    const url = mtxWhepUrl(`${pathPrefix}${encodeURIComponent(cameraId)}`);
    const reader = new Reader({
      url,
      onTrack: (e) => {
        if (cancelled) return;
        const stream = e.streams[0] ?? new MediaStream([e.track]);
        setStreamObj(stream);
        // Track ≠ frames: promote reconnecting→live only on a painted
        // frame so the dot doesn't flap green during a stuck rejoin.
        if (statusRef.current !== "reconnecting") set("waiting_frame");
      },
      onError: (msg) => {
        if (cancelled) return;
        bumpErrors();
        setLastError(msg || "connection error");
        if (statusRef.current === "live") {
          set("reconnecting");
        } else if (
          !everLiveRef.current &&
          errorCountRef.current >= HARD_FAIL_ERRORS
        ) {
          set("failed");
        }
      },
    });
    return () => {
      cancelled = true;
      try {
        reader.close();
      } catch {
        // ignore
      }
    };
  }, [cameraId, pathPrefix, retryTick]);

  // Target stream changed → full reset (a different camera/prefix
  // must not inherit failure memory).
  useEffect(() => {
    everLiveRef.current = false;
    setEverLive(false);
    clearErrors();
    setLastError(null);
    set("connecting");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraId, pathPrefix]);

  // Attach captured stream once the <video> exists. Setting srcObject
  // during onTrack didn't work because videoRef.current is null on the
  // first render before the status flips.
  useEffect(() => {
    if (streamObj && videoRef.current) {
      videoRef.current.srcObject = streamObj;
    }
  }, [streamObj, status]);

  // Preview-tick window — last few seconds of frame timestamps. The
  // consumer pushes via tickPreview(); the watchdog reads it.
  const previewTicksRef = useRef<number[]>([]);
  const tickPreview = () => {
    const now = Date.now();
    previewTicksRef.current.push(now);
    while (previewTicksRef.current.length > 0 &&
           now - previewTicksRef.current[0] > 5000) {
      previewTicksRef.current.shift();
    }
  };

  // Hook rVFC for WebRTC frames so the watchdog has a real signal even
  // when the consumer doesn't care about preview-FPS readouts.
  const attached = streamObj !== null;
  useEffect(() => {
    if (!attached || !videoRef.current) return;
    const v = videoRef.current as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    if (!v.requestVideoFrameCallback) return;
    let cancelled = false;
    const step = () => {
      if (cancelled) return;
      // Only REAL painted video frames count as "session has decoded"
      // — JPEG-fallback ticks also flow through tickPreview() and must
      // not trick the watchdog into treating a still-waiting-for-IDR
      // session as one that stalled mid-play.
      gotFrameRef.current = true;
      if (!everLiveRef.current) {
        everLiveRef.current = true;
        setEverLive(true);
      }
      clearErrors();
      set("live");
      tickPreview();
      v.requestVideoFrameCallback!(step);
    };
    v.requestVideoFrameCallback(step);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attached, retryTick]);

  // Frame-stall watchdog. See file header for the why. Two regimes:
  // - Session hasn't painted yet: it is (legitimately) waiting for the
  //   camera's next IDR — only give up after the 60 s grace.
  // - Session has painted: a 10 s gap in painted frames means the
  //   decoder is genuinely stuck (or MediaMTX dropped us) — reconnect.
  useEffect(() => {
    if (!attached) return;
    const h = setInterval(() => {
      const now = Date.now();
      let stalled = false;
      if (!gotFrameRef.current) {
        stalled = now - sessionStartRef.current > FIRST_FRAME_GRACE_MS;
      } else {
        const arr = previewTicksRef.current;
        const last = arr.length > 0 ? arr[arr.length - 1] : 0;
        stalled = now - last > STALL_MS;
      }
      if (stalled) {
        set(gotFrameRef.current || everLiveRef.current ? "reconnecting" : "failed");
        setStreamObj(null);
        setRetryTick((v) => v + 1);
      }
    }, 2000);
    return () => clearInterval(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attached, retryTick]);

  // 10s retry while the WHEP session is down entirely (no track). An
  // ESTABLISHED session must never be blind-retried here — it may be
  // waiting out a long GOP for its first IDR (the frame-stall watchdog
  // above owns established-session health).
  useEffect(() => {
    if (attached) return;
    const h = setInterval(() => {
      setRetryTick((v) => v + 1);
    }, 10_000);
    return () => clearInterval(h);
  }, [attached]);

  return {
    videoRef,
    status,
    lastError,
    errorCount,
    everLive,
    tickPreview,
    previewTicksRef,
  };
}

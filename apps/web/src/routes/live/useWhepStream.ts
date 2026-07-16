import { useEffect, useRef, useState } from "react";

// useWhepStream subscribes to a camera's MediaMTX WHEP endpoint and exposes
// the resulting MediaStream attached to a <video> ref. Returns the bits a
// caller needs to render: a video ref to attach, an `rtcLive` boolean, and
// a `tickPreview` callback the consumer should invoke when a frame is
// painted (rVFC) or a fallback JPEG loads, so the frame-stall watchdog
// has a recent timestamp to compare against.
//
// Connection lifecycle:
// - On mount (and whenever `cameraId` changes), open a MediaMTXWebRTCReader
//   from the vendored public/mtx-reader.js. Closes on unmount.
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
//   only. (The JPEG path lives in the consumer — Tile or modal — and
//   reports via `imgOk`, used purely as a UI signal.)
//
// Caller responsibility:
// - Pass `imgOk = true` when no fallback is in use, otherwise the retry
//   loop won't fire while WebRTC is broken AND the JPEG path is happy.
// - Call `tickPreview()` once per painted frame so the watchdog stays
//   accurate.
export function useWhepStream(cameraId: string, opts?: { imgOk?: boolean }) {
  const imgOk = opts?.imgOk ?? true;
  const videoRef = useRef<HTMLVideoElement>(null);
  const [rtcLive, setRtcLive] = useState(false);
  const [streamObj, setStreamObj] = useState<MediaStream | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  // Per-session state for the watchdog: when the current reader was
  // created, and whether it has painted a frame yet.
  const sessionStartRef = useRef<number>(Date.now());
  const gotFrameRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    sessionStartRef.current = Date.now();
    gotFrameRef.current = false;
    const Reader = (window as unknown as {
      MediaMTXWebRTCReader?: new (conf: {
        url: string;
        onError?: (e: string) => void;
        onTrack?: (e: RTCTrackEvent) => void;
      }) => { close: () => void };
    }).MediaMTXWebRTCReader;
    if (!Reader) {
      setRtcLive(false);
      return;
    }
    const mtxOrigin = `${window.location.protocol}//${window.location.hostname}:8889`;
    const url = `${mtxOrigin}/live_${encodeURIComponent(cameraId)}/whep`;
    const reader = new Reader({
      url,
      onTrack: (e) => {
        if (cancelled) return;
        const stream = e.streams[0] ?? new MediaStream([e.track]);
        setStreamObj(stream);
        setRtcLive(true);
      },
      onError: () => {
        if (!cancelled) setRtcLive(false);
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
  }, [cameraId, retryTick]);

  // Attach captured stream once the <video> exists. Setting srcObject
  // during onTrack didn't work because videoRef.current is null on the
  // first render before rtcLive flips true.
  useEffect(() => {
    if (rtcLive && streamObj && videoRef.current) {
      videoRef.current.srcObject = streamObj;
    }
  }, [rtcLive, streamObj]);

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
  useEffect(() => {
    if (!rtcLive || !videoRef.current) return;
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
      tickPreview();
      v.requestVideoFrameCallback!(step);
    };
    v.requestVideoFrameCallback(step);
    return () => { cancelled = true; };
  }, [rtcLive]);

  // Frame-stall watchdog. See file header for the why. Two regimes:
  // - Session hasn't painted yet: it is (legitimately) waiting for the
  //   camera's next IDR — passthrough streams can take a full GOP
  //   (measured up to ~34 s on real cameras). Re-negotiating resets
  //   that wait, so only give up after a 60 s grace.
  // - Session has painted: a 10 s gap in painted frames means the
  //   decoder is genuinely stuck (or MediaMTX dropped us) — reconnect.
  const FIRST_FRAME_GRACE_MS = 60_000;
  const STALL_MS = 10_000;
  useEffect(() => {
    if (!rtcLive) return;
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
        setRtcLive(false);
        setStreamObj(null);
        setRetryTick((v) => v + 1);
      }
    }, 2000);
    return () => clearInterval(h);
  }, [rtcLive]);

  // 10s retry while the WHEP session is down entirely (no track). An
  // ESTABLISHED session must never be blind-retried here — it may be
  // waiting out a long GOP for its first IDR (the frame-stall watchdog
  // above owns established-session health), and record-only cameras
  // have no JPEG path at all so `imgOk` says nothing about the video.
  useEffect(() => {
    if (rtcLive) return;
    const h = setInterval(() => {
      setRetryTick((v) => v + 1);
    }, 10_000);
    return () => clearInterval(h);
  }, [rtcLive, imgOk]);

  return {
    videoRef,
    rtcLive,
    streamObj,
    retryTick,
    tickPreview,
    previewTicksRef,
  };
}

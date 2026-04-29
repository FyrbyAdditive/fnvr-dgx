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
// - 4s without a fresh frame in the rolling preview-tick window forces a
//   re-negotiation (see the watchdog effect). This catches the "MediaMTX
//   discarded a slow reader's frames, decoder lost I-frame reference,
//   <video> stuck on last good frame" failure mode.
// - 10s while neither the WHEP nor the JPEG path is producing also bumps
//   the retry counter so a tile whose pipeline wasn't ready at mount time
//   recovers without a page refresh. (The JPEG path lives in the consumer
//   — Tile or modal — but it tells us via `imgOk` so we can include that
//   in the retry trigger condition.)
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

  useEffect(() => {
    let cancelled = false;
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
      tickPreview();
      v.requestVideoFrameCallback!(step);
    };
    v.requestVideoFrameCallback(step);
    return () => { cancelled = true; };
  }, [rtcLive]);

  // Frame-stall watchdog. See file header for the why. 4s ceiling chosen
  // because it's longer than any GOP we expect (typical is 2s) but short
  // enough that the user notices "frozen" before they reach for refresh.
  useEffect(() => {
    if (!rtcLive) return;
    const h = setInterval(() => {
      const arr = previewTicksRef.current;
      const last = arr.length > 0 ? arr[arr.length - 1] : 0;
      if (Date.now() - last > 4000) {
        setRtcLive(false);
        setStreamObj(null);
        setRetryTick((v) => v + 1);
      }
    }, 2000);
    return () => clearInterval(h);
  }, [rtcLive]);

  // 10s retry while no path is producing.
  useEffect(() => {
    if (rtcLive && imgOk) return;
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

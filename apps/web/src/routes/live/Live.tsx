import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api } from "@/lib/api";
import { useRecentDetections, DetectionEvent } from "@/lib/events";

export function Live() {
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
  const boxesByCamera = useMemo(() => {
    const now = Date.now();
    const m = new Map<string, DetectionEvent[]>();
    for (const e of events) {
      if (now - new Date(e.ts).getTime() > 2000) continue;
      const arr = m.get(e.camera_id) ?? [];
      arr.push(e);
      m.set(e.camera_id, arr);
    }
    return m;
  }, [events]);

  // Inference FPS per camera. Unique-timestamps-per-5s-window heuristic:
  // one inference frame publishes N events sharing the same ts, so the
  // count of distinct timestamps in the last 5s ≈ frames/s × 5.
  const fpsByCamera = useMemo(() => {
    const now = Date.now();
    const WINDOW_MS = 5000;
    const perCam = new Map<string, Set<string>>();
    for (const e of events) {
      const t = new Date(e.ts).getTime();
      if (now - t > WINDOW_MS) continue;
      let s = perCam.get(e.camera_id);
      if (!s) { s = new Set(); perCam.set(e.camera_id, s); }
      s.add(e.ts);
    }
    const out = new Map<string, number>();
    for (const [cam, set] of perCam) {
      out.set(cam, set.size / (WINDOW_MS / 1000));
    }
    return out;
  }, [events]);

  const grid =
    cameras.length <= 1 ? "grid-cols-1" :
    cameras.length <= 4 ? "grid-cols-2" :
    cameras.length <= 9 ? "grid-cols-3" :
    "grid-cols-4";

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
              state={c.state}
              detections={boxesByCamera.get(c.id) ?? []}
              inferenceFps={fpsByCamera.get(c.id) ?? 0}
              showStats={showStats}
              focus={focusCameraId === c.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CameraTile({ id, name, state, detections, inferenceFps, showStats, focus }: {
  id: string;
  name: string;
  state?: "starting" | "running" | "failed" | "unknown";
  detections: DetectionEvent[];
  inferenceFps: number;
  showStats: boolean;
  focus?: boolean;
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
  // WebRTC live view. Falls back to the 1-fps JPEG snapshot below if the
  // peer connection can't be established (camera not streaming, browser
  // blocks insecure getUserMedia, etc.).
  const videoRef = useRef<HTMLVideoElement>(null);
  const [rtcLive, setRtcLive] = useState(false);

  useEffect(() => {
    let pc: RTCPeerConnection | null = null;
    let cancelled = false;

    (async () => {
      try {
        pc = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });
        pc.addTransceiver("video", { direction: "recvonly" });

        pc.ontrack = (e) => {
          if (!cancelled && videoRef.current && e.streams[0]) {
            videoRef.current.srcObject = e.streams[0];
            setRtcLive(true);
          }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        // Wait for ICE gathering to complete so the offer contains candidates.
        await new Promise<void>((resolve) => {
          if (pc!.iceGatheringState === "complete") return resolve();
          const h = () => {
            if (pc!.iceGatheringState === "complete") {
              pc!.removeEventListener("icegatheringstatechange", h);
              resolve();
            }
          };
          pc!.addEventListener("icegatheringstatechange", h);
          setTimeout(() => resolve(), 3000);
        });

        const res = await fetch(`/api/v1/cameras/${encodeURIComponent(id)}/whep`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/sdp" },
          body: pc.localDescription!.sdp,
        });
        if (!res.ok) throw new Error(`whep ${res.status}`);
        const answer = await res.text();
        if (cancelled) return;
        await pc.setRemoteDescription({ type: "answer", sdp: answer });
      } catch {
        setRtcLive(false);
      }
    })();

    return () => {
      cancelled = true;
      if (pc) pc.close();
    };
  }, [id]);

  // Snapshot fallback refresh.
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    const h = setInterval(() => setT(Date.now()), 1000);
    return () => clearInterval(h);
  }, []);
  const src = `/api/v1/cameras/${encodeURIComponent(id)}/snapshot.jpg?t=${t}`;

  const [imgOk, setImgOk] = useState(true);
  useEffect(() => { setImgOk(true); }, [id]);

  // Preview FPS — tracked by counting successful image loads in the last
  // 5s. For WebRTC we register a requestVideoFrameCallback. Both feed
  // the same displayed number ("preview fps") so the user sees the
  // effective on-screen refresh rate regardless of which path renders.
  const previewTicksRef = useRef<number[]>([]);
  const [previewFps, setPreviewFps] = useState(0);
  const tickPreview = () => {
    const now = Date.now();
    previewTicksRef.current.push(now);
    // Keep only last 5s.
    while (previewTicksRef.current.length > 0 &&
           now - previewTicksRef.current[0] > 5000) {
      previewTicksRef.current.shift();
    }
  };
  useEffect(() => {
    const h = setInterval(() => {
      const arr = previewTicksRef.current;
      setPreviewFps(arr.length / 5);
    }, 500);
    return () => clearInterval(h);
  }, []);

  // Hook rVFC for WebRTC frames when the track is live.
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

  const latest = detections[0];

  // Source aspect ratio — starts at 16:9 and refines once the media loads
  // its real dimensions. The inner frame always matches this so non-16:9
  // cameras letterbox inside the tile and bbox overlays stay aligned to
  // the visible pixels (not to the empty letterbox area).
  const [aspect, setAspect] = useState(16 / 9);

  return (
    <div
      ref={tileRef}
      className={`bg-neutral-900 rounded aspect-video relative overflow-hidden flex items-center justify-center transition-shadow ${
        highlight ? "ring-2 ring-emerald-400 shadow-[0_0_24px_rgba(52,211,153,0.55)]" : ""
      }`}
    >
      <div
        className="relative max-w-full max-h-full"
        style={{ aspectRatio: aspect, width: aspect >= 16 / 9 ? "100%" : "auto", height: aspect < 16 / 9 ? "100%" : "auto" }}
      >
        {rtcLive ? (
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              if (v.videoWidth && v.videoHeight) setAspect(v.videoWidth / v.videoHeight);
            }}
            className="absolute inset-0 w-full h-full"
          />
        ) : imgOk ? (
          <img
            src={src}
            alt={name}
            onLoad={(e) => {
              tickPreview();
              const im = e.currentTarget;
              if (im.naturalWidth && im.naturalHeight) setAspect(im.naturalWidth / im.naturalHeight);
            }}
            className="absolute inset-0 w-full h-full"
            onError={() => setImgOk(false)}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-neutral-600 text-sm">
            No recording yet
          </div>
        )}

        {/* bbox overlay — coords are normalised 0..1 of the source frame */}
        {detections.map((d) => (
          <BBox key={d.id} d={d} />
        ))}
      </div>

      <div className="absolute bottom-2 left-2 text-xs bg-black/60 px-2 py-0.5 rounded">
        {name}
      </div>
      {latest && (
        <div className="absolute top-2 right-2 text-xs bg-blue-600/80 px-2 py-0.5 rounded">
          {latest.class_name} {(latest.confidence * 100).toFixed(0)}%
        </div>
      )}
      {state && state !== "running" && <StateBadge state={state} />}
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

function StateBadge({ state }: { state: "starting" | "failed" | "unknown" | string }) {
  const label =
    state === "starting" ? "starting (building inference engine)" :
    state === "failed"   ? "pipeline failed" :
                           "pipeline offline";
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

function BBox({ d }: { d: DetectionEvent }) {
  const isPlate = d.kind === "anpr";
  // Plates get a fixed green border + the decoded text as label so
  // they visually stand apart from the busy COCO palette.
  const color = isPlate ? "#22c55e" : colorForClass(d.class_name);
  const style: React.CSSProperties = {
    position: "absolute",
    left: `${d.bbox.x * 100}%`,
    top: `${d.bbox.y * 100}%`,
    width: `${d.bbox.w * 100}%`,
    height: `${d.bbox.h * 100}%`,
    border: `2px solid ${color}`,
    boxShadow: `0 0 0 1px rgba(0,0,0,0.5)`,
    pointerEvents: "none",
  };
  const label = isPlate
    ? d.attributes?.plate ?? "plate"
    : `${d.class_name} ${(d.confidence * 100).toFixed(0)}%`;
  return (
    <div style={style}>
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

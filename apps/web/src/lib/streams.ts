import type { Camera } from "@/lib/api";

// Stream-endpoint helpers shared by the Live page and anything else
// that talks to MediaMTX directly.

// MediaMTX WHEP (LAN, no auth). Same host as the web UI.
export const MTX_WHEP_PORT = 8889;

export function mtxWhepUrl(path: string): string {
  return `${window.location.protocol}//${window.location.hostname}:${MTX_WHEP_PORT}/${path}/whep`;
}

// "live_" = full-res passthrough (the recorded path); "lp_" = the
// NVENC live-proxy the grid uses (H.264, ≤540p, 1 s IDR, no B-frames —
// WebRTC-clean and near-instant to join).
export type StreamPrefix = "lp_" | "live_";

// A camera has an NVENC live-proxy stream (lp_<id>) when its worker
// decodes frames for inference: detectors not "none", and not the
// bespoke rotation/mtx_proxy transcode shape (whose passthrough stream
// is already grid-friendly H.264). Must mirror the proxy_leg logic in
// pipeline.cpp BuildPipeline.
export function hasProxyStream(c: Camera): boolean {
  const det = c.enabled_detectors ?? [];
  const none = det.length === 1 && det[0] === "none";
  return !none && (c.rotation ?? 0) === 0 && !c.mtx_proxy;
}

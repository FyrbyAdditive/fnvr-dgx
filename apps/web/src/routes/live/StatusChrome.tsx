import { formatRelativeAge } from "@/lib/format";
import type { ConnectionStatus } from "./useWhepStream";

// Shared status chrome for the Live page: the per-tile connection dot,
// the pipeline-state badge (single copy — used by tile overlay and the
// enlarged modal), and the quality pill.

export function StatusDot({
  status,
  lastError,
}: {
  status: ConnectionStatus;
  lastError?: string | null;
}) {
  let dot: string;
  let ping = false;
  let pulse = false;
  let title: string;
  switch (status) {
    case "live":
      dot = "bg-emerald-400";
      ping = true;
      title = "Live (WebRTC)";
      break;
    case "fallback_jpeg":
      dot = "bg-sky-400";
      title = "Snapshot preview — WebRTC unavailable";
      break;
    case "connecting":
    case "waiting_frame":
      dot = "bg-amber-400";
      pulse = true;
      title = status === "connecting" ? "Connecting…" : "Waiting for first frame…";
      break;
    case "reconnecting":
      dot = "bg-amber-500";
      pulse = true;
      title = `Reconnecting…${lastError ? ` (${lastError})` : ""}`;
      break;
    default:
      dot = "bg-red-500";
      title = `No connection${lastError ? ` (${lastError})` : ""}`;
  }
  return (
    <span className="relative inline-flex w-2 h-2 shrink-0" title={title}>
      {ping && (
        <span className="absolute inline-flex w-full h-full rounded-full bg-emerald-400/60 animate-ping" />
      )}
      <span
        className={`relative inline-flex w-2 h-2 rounded-full ${dot} ${pulse ? "animate-pulse" : ""}`}
      />
    </span>
  );
}

// Pipeline-state badge (positionless — callers own placement).
// "unknown" really means one of two things — never heard from this
// camera, or heartbeat expired. Surfacing the age lets the operator
// tell a never-started worker from a long-stuck one without digging
// in the logs.
export function StateBadge({ state, lastHeartbeatAt }: {
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

// Amber "running degraded" pill for the enlarged modal's auto-quality
// fallback.
export function QualityPill({ onRetry }: { onRetry: () => void }) {
  return (
    <button
      type="button"
      onClick={onRetry}
      className="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-200 border border-amber-400/40 hover:bg-amber-500/30"
      title="The full-quality stream failed (e.g. H.265 B-frames aren't WebRTC-compatible); showing the proxy. Click to retry full quality."
    >
      proxy quality — tap to retry full
    </button>
  );
}

import { useEffect, useState } from "react";
import type { StreamPrefix } from "@/lib/streams";
import type { WhepStatus } from "./useWhepStream";

// useStreamQuality maps a quality preference to a stream prefix, with
// the auto path's resilience: start on the full-quality passthrough
// and fall back to the NVENC proxy only on HARD failure (repeated
// reader errors or grace expiry with zero painted frames — e.g.
// MediaMTX rejecting H.265+B-frame readers). A legitimately slow GOP
// join produces no errors and is never treated as failure.
//
// Quality is a standing user constraint: "full" NEVER falls back; the
// automatic downgrade exists only under "auto" and is surfaced to the
// UI via `degraded` so it's always visible + reversible (retryFull).
export function useStreamQuality(
  pref: "auto" | "full" | "proxy",
  hasProxy: boolean,
  health: { status: WhepStatus; everLive: boolean },
): { prefix: StreamPrefix; degraded: boolean; retryFull: () => void } {
  const [degraded, setDegraded] = useState(false);

  // Preference change resets the sticky downgrade.
  useEffect(() => {
    setDegraded(false);
  }, [pref]);

  useEffect(() => {
    if (pref !== "auto" || degraded || !hasProxy) return;
    // "failed" covers both trigger paths: HARD_FAIL_ERRORS consecutive
    // reader errors and the 60s first-frame grace expiry.
    if (health.status === "failed" && !health.everLive) {
      setDegraded(true);
    }
  }, [pref, degraded, hasProxy, health.status, health.everLive]);

  const prefix: StreamPrefix =
    pref === "proxy"
      ? hasProxy ? "lp_" : "live_"
      : pref === "full"
        ? "live_"
        : degraded && hasProxy
          ? "lp_"
          : "live_";

  return {
    prefix,
    degraded: pref === "auto" && degraded && hasProxy,
    retryFull: () => setDegraded(false),
  };
}

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { dayRange, todayKey } from "./timeMath";

// Data hooks for the Timeline page. A past day's segments, incidents
// and detections are immutable, so we only poll (10s) when the
// selected day is today — otherwise every refetch would re-scan
// rec.jsonl sidecars server-side for no reason.

function pollFor(dayKey: string): number | false {
  return dayKey === todayKey() ? 10_000 : false;
}

export function useSegments(cameraId: string, dayKey: string) {
  const { from, to } = dayRange(dayKey);
  return useQuery({
    queryKey: ["segments", cameraId, dayKey],
    queryFn: () => api.listSegments({ cameraId, from, to, limit: 1000 }),
    enabled: !!cameraId,
    refetchInterval: pollFor(dayKey),
    refetchIntervalInBackground: false,
  });
}

/** Incidents overlapping the day, sorted ascending by started_at so
 *  prev/next navigation can binary-walk them. */
export function useIncidents(cameraId: string, dayKey: string) {
  const { from, to } = dayRange(dayKey);
  return useQuery({
    queryKey: ["incidents", cameraId, dayKey],
    queryFn: () => api.listIncidents(500, { cameraId, from, to }),
    select: (incidents) =>
      [...incidents].sort(
        (a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime(),
      ),
    enabled: !!cameraId,
    refetchInterval: pollFor(dayKey),
    refetchIntervalInBackground: false,
  });
}

/** Server-aggregated activity buckets for an arbitrary window (the
 *  full day, or the zoomed view). The window is debounced 250ms so a
 *  drag-zoom doesn't fire a request per mousemove. */
export function useDetectionSummary(
  cameraId: string,
  from: Date,
  to: Date,
  dayKey: string,
  buckets = 288,
) {
  const win = useDebounced({ fromMs: from.getTime(), toMs: to.getTime() }, 250);
  return useQuery({
    queryKey: ["detection-summary", cameraId, win.fromMs, win.toMs, buckets],
    queryFn: () =>
      api.detectionSummary({
        cameraId,
        from: new Date(win.fromMs),
        to: new Date(win.toMs),
        buckets,
      }),
    enabled: !!cameraId && win.toMs > win.fromMs,
    refetchInterval: pollFor(dayKey),
    refetchIntervalInBackground: false,
  });
}

/** Raw detection rows for a bounded window. Used for the zoomed-in
 *  activity band (track runs) and the player overlay — never for a
 *  whole busy day, where a row limit would silently truncate. */
export function useWindowDetections(
  cameraId: string,
  fromMs: number,
  toMs: number,
  dayKey: string,
  enabled: boolean,
  limit = 2000,
) {
  return useQuery({
    queryKey: ["detections-window", cameraId, fromMs, toMs, limit],
    queryFn: () =>
      api.listDetectionsHistoric({
        cameraId,
        from: new Date(fromMs),
        to: new Date(toMs),
        limit,
      }),
    enabled: enabled && !!cameraId && toMs > fromMs,
    refetchInterval: pollFor(dayKey),
    refetchIntervalInBackground: false,
  });
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  const key = JSON.stringify(value);
  useEffect(() => {
    const h = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ms]);
  return debounced;
}

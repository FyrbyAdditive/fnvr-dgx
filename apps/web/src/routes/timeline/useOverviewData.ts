import { useEffect, useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { api, DetectionSummary, HistoricDetection, Incident, Segment } from "@/lib/api";
import { dayRange, todayKey } from "./timeMath";
import { Notable, toNotable } from "./overviewLogic";

// Data hooks for the all-cameras overview. Segments and incidents are
// single fleet calls (both endpoints already accept "no camera").
// Density is a per-camera fan-out over the existing /detections/summary
// — keyed EXACTLY like the detail-mode hook so drilling into a camera
// is a cache hit and lanes render progressively as responses land.

function pollFor(dayKey: string): number | false {
  return dayKey === todayKey() ? 10_000 : false;
}

export function useAllSegments(dayKey: string, enabled: boolean) {
  const { from, to } = dayRange(dayKey);
  return useQuery({
    queryKey: ["segments", "all", dayKey],
    queryFn: () => api.listSegments({ from, to, limit: 2000 }),
    select: (segments: Segment[]) => {
      const by = new Map<string, Segment[]>();
      for (const s of segments) {
        const list = by.get(s.camera_id);
        if (list) list.push(s);
        else by.set(s.camera_id, [s]);
      }
      return by;
    },
    enabled,
    refetchInterval: pollFor(dayKey),
    refetchIntervalInBackground: false,
  });
}

/** Fleet incidents for the day, ascending (stepper + digest order). */
export function useAllIncidents(dayKey: string, enabled: boolean) {
  const { from, to } = dayRange(dayKey);
  return useQuery({
    queryKey: ["incidents", "all", dayKey],
    queryFn: () => api.listIncidents(500, { from, to }),
    select: (incidents: Incident[]) =>
      [...incidents].sort(
        (a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime(),
      ),
    enabled,
    refetchInterval: pollFor(dayKey),
    refetchIntervalInBackground: false,
  });
}

/** Per-camera density fan-out. One shared debounce so all lanes settle
 *  together; keys match useDetectionSummary byte-for-byte. */
export function useAllCameraSummaries(
  cameraIds: string[],
  from: Date,
  to: Date,
  dayKey: string,
  enabled: boolean,
  buckets = 288,
) {
  const win = useDebounced({ fromMs: from.getTime(), toMs: to.getTime() }, 250);
  const results = useQueries({
    queries: cameraIds.map((id) => ({
      queryKey: ["detection-summary", id, win.fromMs, win.toMs, buckets],
      queryFn: () =>
        api.detectionSummary({
          cameraId: id,
          from: new Date(win.fromMs),
          to: new Date(win.toMs),
          buckets,
        }),
      enabled: enabled && !!id && win.toMs > win.fromMs,
      refetchInterval: pollFor(dayKey),
      refetchIntervalInBackground: false,
    })),
  });
  return useMemo(() => {
    const by = new Map<string, DetectionSummary | undefined>();
    cameraIds.forEach((id, i) => by.set(id, results[i]?.data));
    return by;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraIds.join(","), ...results.map((r) => r.dataUpdatedAt)]);
}

const NOTABLE_KINDS = ["face", "anpr", "print_defect"] as const;

/** Digest-worthy detections across all cameras: matched faces, plate
 *  reads, print-defect sightings. Low-volume kinds — safe under the
 *  2000-row cap each. Returns raw Notables (uncollapsed). */
export function useNotableDetections(dayKey: string, enabled: boolean) {
  const { from, to } = dayRange(dayKey);
  const dayFromMs = from.getTime();
  const results = useQueries({
    queries: NOTABLE_KINDS.map((kind) => ({
      queryKey: ["notable", kind, "all", dayKey],
      queryFn: () =>
        api.listDetectionsHistoric({ kind, from, to, limit: 2000 }),
      enabled,
      refetchInterval: pollFor(dayKey),
      refetchIntervalInBackground: false,
    })),
  });
  return useMemo(() => {
    const out: Notable[] = [];
    for (const r of results) {
      for (const d of (r.data ?? []) as HistoricDetection[]) {
        const n = toNotable(d, dayFromMs);
        if (n) out.push(n);
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayFromMs, ...results.map((r) => r.dataUpdatedAt)]);
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

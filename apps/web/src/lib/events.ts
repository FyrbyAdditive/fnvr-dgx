import { useEffect, useState, useRef } from "react";

export type DetectionEvent = {
  /** Pipeline's event_id (short hex). Stable identity for client-side
   *  de-dup; also a fallback URL key for the flag endpoint on
   *  pre-pg_id builds. */
  id: string;
  /** PG row id. Present when the SSE payload comes from the
   *  accepted-detections subject (event-processor republishes after
   *  INSERT). New clients should prefer this for flag URLs to close
   *  the race where the row hadn't landed yet at click time. */
  pg_id?: number;
  camera_id: string;
  /** Source-side timestamp (ISO seconds resolution) — when the
   *  pipeline emitted the detection. May lag wall-clock by up to a
   *  few seconds under broker / queue back-pressure. */
  ts: string;
  /** Client-side wall-clock (ms since epoch) at the moment this
   *  event arrived on the SSE stream. Used by the Live overlay to
   *  decide how long to keep the bbox on screen — `ts` alone is too
   *  coarse (1-second resolution) and lags real time when broker
   *  inference is slow, which previously made bboxes vanish despite
   *  the object still being there. */
  arrived_at_ms: number;
  class_name: string;
  /** "object" | "anpr" | "face" | "print_defect". Absent on legacy payloads (treat as "object"). */
  kind?: "object" | "anpr" | "face" | "print_defect";
  confidence: number;
  bbox: { x: number; y: number; w: number; h: number };
  track_id?: string;
  attributes?: Record<string, string>;
};

/**
 * Subscribe to the live detection SSE stream from api-server.
 * Auto-reconnects on drop (EventSource has native retry, but we poke it after
 * auth expiry by re-mounting the component with a new key).
 */
export function useDetectionStream(onEvent: (d: DetectionEvent) => void) {
  const cbRef = useRef(onEvent);
  cbRef.current = onEvent;

  useEffect(() => {
    const es = new EventSource("/api/v1/events/stream", { withCredentials: true });
    const h = (ev: MessageEvent) => {
      try {
        const d = JSON.parse(ev.data) as DetectionEvent;
        // Stamp arrival time so the overlay can age bboxes off based
        // on when we saw them, not when the pipeline thinks the
        // detection happened. Source-side `ts` has 1-second resolution
        // and can lag actual wall-clock when the broker is busy.
        d.arrived_at_ms = Date.now();
        cbRef.current(d);
      } catch {}
    };
    es.addEventListener("detection", h as EventListener);
    return () => {
      es.removeEventListener("detection", h as EventListener);
      es.close();
    };
  }, []);
}

/**
 * Ring buffer of the most-recent N detection events — used by the Events
 * tab feed and the Live mosaic's overlay.
 */
export function useRecentDetections(limit = 100) {
  const [events, setEvents] = useState<DetectionEvent[]>([]);
  // Coalesce SSE bursts into one state flush per animation frame: one
  // inference frame publishes N messages across cameras, and flushing
  // per message re-renders every consumer N times for the same paint.
  const pendingRef = useRef<DetectionEvent[]>([]);
  const rafRef = useRef<number | null>(null);
  useDetectionStream((d) => {
    const pending = pendingRef.current;
    pending.push(d);
    // Bound the staging buffer (rAF doesn't fire in hidden tabs);
    // only the newest `limit` can survive the flush anyway.
    if (pending.length > limit) pending.splice(0, pending.length - limit);
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const batch = pendingRef.current;
      pendingRef.current = [];
      setEvents((prev) => {
        // Batch arrived oldest→newest; the buffer is newest-first.
        const next = [...batch.reverse(), ...prev];
        return next.length > limit ? next.slice(0, limit) : next;
      });
    });
  });
  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );
  return events;
}

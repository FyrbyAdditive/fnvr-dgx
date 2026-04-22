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
  ts: string;
  class_name: string;
  /** "object" | "anpr" | "face". Absent on legacy payloads (treat as "object"). */
  kind?: "object" | "anpr" | "face";
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
      try { cbRef.current(JSON.parse(ev.data) as DetectionEvent); } catch {}
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
  useDetectionStream((d) => {
    setEvents((prev) => {
      const next = [d, ...prev];
      return next.length > limit ? next.slice(0, limit) : next;
    });
  });
  return events;
}

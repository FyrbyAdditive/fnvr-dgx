import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api, Incident } from "@/lib/api";
import { useRecentDetections } from "@/lib/events";
import { useMe } from "@/lib/me";

export function Events() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: me } = useMe();
  const isAdmin = !!me?.is_admin;
  // Ring buffer cap — keeps the tab responsive on long sessions since
  // each event renders a row. At ~30 detections/sec this is ~30s of
  // history; older events drop off the bottom.
  const LIVE_LIMIT = 1000;
  const detections = useRecentDetections(LIVE_LIMIT);
  const { data: incidents = [] } = useQuery({
    queryKey: ["incidents"],
    queryFn: () => api.listIncidents(50),
    refetchInterval: 5_000,
  });
  const ack = useMutation({
    mutationFn: api.ackIncident,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["incidents"] }),
  });
  const del = useMutation({
    mutationFn: api.deleteIncident,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["incidents"] }),
  });

  const openInTimeline = (cameraId: string, startedAt: string) =>
    navigate(
      `/timeline?camera=${encodeURIComponent(cameraId)}&ts=${encodeURIComponent(startedAt)}`,
    );

  return (
    <div className="p-4 grid gap-6 md:grid-cols-2">
      <section>
        <h2 className="text-lg font-semibold mb-2">
          Incidents <span className="text-neutral-500 text-sm">({incidents.length})</span>
        </h2>
        {incidents.length === 0 ? (
          <p className="text-neutral-500 text-sm">
            No incidents yet. Add a rule on the <a className="underline" href="/rules">Rules</a> tab.
          </p>
        ) : (
          <ul className="divide-y divide-neutral-800 rounded border border-neutral-800 text-sm">
            {incidents.map((i) => (
              <li key={i.id} className={`grid grid-cols-[12rem_1fr_9rem] gap-2 items-center
                ${i.acknowledged ? "opacity-50" : ""}`}>
                <button
                  type="button"
                  className={`col-span-2 grid grid-cols-[12rem_1fr] gap-2 items-start text-left p-2 rounded-l ${
                    i.camera_id ? "hover:bg-neutral-900" : "cursor-default"
                  }`}
                  onClick={() => {
                    if (i.camera_id) openInTimeline(i.camera_id, i.started_at);
                  }}
                  disabled={!i.camera_id}
                  title={
                    i.camera_id
                      ? "Open the recording at this moment"
                      : "System-scope incident — no clip to open"
                  }
                >
                  <span className="text-neutral-500 tabular-nums">
                    {formatIncidentTimestamp(i.started_at)}
                  </span>
                  <IncidentSummary i={i} />
                </button>
                {isAdmin ? (
                  <div className="flex items-center justify-end gap-3 pr-2 text-xs">
                    <button
                      className={i.acknowledged ? "text-neutral-600" : "text-blue-400 hover:underline"}
                      onClick={() => !i.acknowledged && ack.mutate(i.id)}
                      disabled={i.acknowledged}
                    >
                      {i.acknowledged ? "ack'd" : "acknowledge"}
                    </button>
                    <button
                      className="text-red-400 hover:underline"
                      onClick={() => del.mutate(i.id)}
                      disabled={del.isPending}
                      title="Delete this incident"
                    >
                      delete
                    </button>
                  </div>
                ) : (
                  <span className="text-xs text-neutral-600 text-right pr-2">
                    {i.acknowledged ? "ack'd" : ""}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-2">
          Live detections{" "}
          <span className="text-neutral-500 text-sm">
            (last {LIVE_LIMIT} · showing {detections.length})
          </span>
        </h2>
        {detections.length === 0 ? (
          <p className="text-neutral-500 text-sm">Listening on SSE…</p>
        ) : (
          <ul className="divide-y divide-neutral-800 rounded border border-neutral-800 text-sm max-h-[70vh] overflow-auto">
            {detections.map((e) => {
              const isPlate = e.kind === "anpr";
              const isFace = e.kind === "face";
              const person = isFace ? e.attributes?.person : undefined;
              // Primary label: plate text for ANPR, matched-person name
              // for face detections (falls back to "face" when the
              // embedding didn't cross the match threshold), otherwise
              // the raw class name.
              const primary = isPlate
                ? e.attributes?.plate ?? "plate"
                : person ?? e.class_name;
              const similarity = isFace ? e.attributes?.similarity : undefined;
              return (
                <li key={e.id} className="p-2 grid grid-cols-[8rem_1fr_6rem] gap-2">
                  <span className="text-neutral-500 tabular-nums">
                    {new Date(e.ts).toLocaleTimeString()}
                  </span>
                  <span>
                    <span
                      className={`font-medium ${
                        isPlate
                          ? "text-emerald-400"
                          : person
                          ? "text-sky-400"
                          : ""
                      }`}
                    >
                      {primary}
                    </span>
                    {similarity && (
                      <span className="text-neutral-500 text-xs">
                        {" "}({Math.round(Number(similarity) * 100)}%)
                      </span>
                    )}
                    <span className="text-neutral-500"> · {e.camera_id}</span>
                  </span>
                  <span className="text-right tabular-nums text-neutral-400">
                    {(e.confidence * 100).toFixed(0)}%
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function severityColor(s: string) {
  if (s === "critical") return "text-red-400";
  if (s === "warning") return "text-amber-400";
  return "text-blue-400";
}

// IncidentSummary renders the two-line description of a (possibly
// merged) incident. Line 1 is the human-friendly classes-on-camera
// label ("person + car at house-side"); line 2 is the duration +
// detection count ("4m32s · ×14") so the operator can see at a
// glance how busy / sustained the event was.
function IncidentSummary({ i }: { i: Incident }) {
  const classes = i.classes && i.classes.length > 0 ? i.classes : null;
  const camera = i.camera_id ?? "system";
  const headline = classes
    ? `${classes.join(" + ")} at ${camera}`
    : i.summary; // fall back to legacy single-class summary
  const duration = formatIncidentDuration(i);
  return (
    <span className="grid gap-0.5">
      <span>
        <span className={`font-medium ${severityColor(i.severity)}`}>
          {i.severity}
        </span>
        <span className="text-neutral-300"> · {headline}</span>
      </span>
      {(duration || i.detection_count > 1) && (
        <span className="text-xs text-neutral-500">
          {duration && <>{duration}</>}
          {duration && i.detection_count > 1 && <> · </>}
          {i.detection_count > 1 && <>×{i.detection_count}</>}
        </span>
      )}
    </span>
  );
}

// formatIncidentTimestamp renders a short date+time the operator can
// scan — incidents persist long enough that a bare time-of-day is
// ambiguous once you scroll past today.
function formatIncidentTimestamp(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString();
  return `${date} ${time}`;
}

// formatIncidentDuration returns a "4m 32s" / "12s" style string, or
// empty when the incident is a single instantaneous firing
// (last_detection_at == started_at). Uses last_detection_at as the
// end of the activity window — ended_at is set to the same value
// today, but if we ever add a "manual close" feature they could
// diverge and we'd want the activity window, not the lifetime.
function formatIncidentDuration(i: Incident): string {
  if (!i.last_detection_at) return "";
  const start = new Date(i.started_at).getTime();
  const last = new Date(i.last_detection_at).getTime();
  const secs = Math.floor((last - start) / 1000);
  if (secs <= 0) return "";
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h ${mm}m` : `${h}h`;
}

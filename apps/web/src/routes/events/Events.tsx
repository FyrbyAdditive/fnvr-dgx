import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { useRecentDetections } from "@/lib/events";

export function Events() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const detections = useRecentDetections(200);
  const { data: incidents = [] } = useQuery({
    queryKey: ["incidents"],
    queryFn: () => api.listIncidents(50),
    refetchInterval: 5_000,
  });
  const ack = useMutation({
    mutationFn: api.ackIncident,
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
              <li key={i.id} className={`grid grid-cols-[8rem_1fr_6rem] gap-2 items-center
                ${i.acknowledged ? "opacity-50" : ""}`}>
                <button
                  type="button"
                  className="col-span-2 grid grid-cols-[8rem_1fr] gap-2 items-center text-left p-2 hover:bg-neutral-900 rounded-l"
                  onClick={() => openInTimeline(i.camera_id, i.started_at)}
                  title="Open the recording at this moment"
                >
                  <span className="text-neutral-500 tabular-nums">
                    {new Date(i.started_at).toLocaleTimeString()}
                  </span>
                  <span>
                    <span className={`font-medium ${severityColor(i.severity)}`}>{i.severity}</span>
                    <span className="text-neutral-400"> · {i.summary}</span>
                  </span>
                </button>
                <button className={`text-xs px-2 py-2 text-right ${i.acknowledged ? "text-neutral-600" : "text-blue-400 hover:underline"}`}
                  onClick={() => !i.acknowledged && ack.mutate(i.id)}
                  disabled={i.acknowledged}>
                  {i.acknowledged ? "ack'd" : "acknowledge"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-2">
          Live detections <span className="text-neutral-500 text-sm">({detections.length})</span>
        </h2>
        {detections.length === 0 ? (
          <p className="text-neutral-500 text-sm">Listening on SSE…</p>
        ) : (
          <ul className="divide-y divide-neutral-800 rounded border border-neutral-800 text-sm max-h-[70vh] overflow-auto">
            {detections.map((e) => {
              const isPlate = e.kind === "anpr";
              const primary = isPlate
                ? e.attributes?.plate ?? "plate"
                : e.class_name;
              return (
                <li key={e.id} className="p-2 grid grid-cols-[8rem_1fr_6rem] gap-2">
                  <span className="text-neutral-500 tabular-nums">
                    {new Date(e.ts).toLocaleTimeString()}
                  </span>
                  <span>
                    <span className={`font-medium ${isPlate ? "text-emerald-400" : ""}`}>
                      {primary}
                    </span>
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

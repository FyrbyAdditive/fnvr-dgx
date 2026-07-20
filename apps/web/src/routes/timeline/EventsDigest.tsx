import { Incident } from "@/lib/api";
import { severityColor } from "@/lib/severity";
import { msToHHMMSS } from "./timeMath";
import { DigestRow } from "./overviewLogic";

// Global events digest: a chronological (ascending) day-log of the
// visible window across all cameras — rule incidents plus notable
// detections (matched faces, plate reads, print-defect sightings).
// Follows the ruler's zoom; hover syncs with the lane markers; click
// focuses the camera and seeks the player. The Events page keeps its
// separate job (newest-first triage feed).

export function EventsDigest({
  rows,
  cameraName,
  hoveredIncidentId,
  isAdmin,
  onSelectIncident,
  onSelectNotable,
  onHoverIncident,
  onAck,
}: {
  rows: DigestRow[];
  cameraName: (id: string | null) => string;
  hoveredIncidentId: string | null;
  isAdmin: boolean;
  onSelectIncident: (inc: Incident) => void;
  onSelectNotable: (cameraId: string, msInDay: number) => void;
  onHoverIncident: (id: string | null) => void;
  onAck: (id: string) => void;
}) {
  const nEvents = rows.filter((r) => r.type !== "hour").length;
  return (
    <div className="bg-neutral-900 rounded flex flex-col min-h-0 overflow-hidden">
      <div className="px-3 py-2 text-xs uppercase tracking-wide text-neutral-500 border-b border-neutral-800 shrink-0">
        Events — all cameras
        <span className="normal-case tracking-normal ml-2 text-neutral-600">
          {nEvents} in view
        </span>
      </div>
      <div className="overflow-y-auto min-h-0 text-xs divide-y divide-neutral-800/60">
        {nEvents === 0 && (
          <p className="p-3 text-neutral-500">
            Nothing in this window — zoom out, pick another day, or add
            rules to turn detections into events.
          </p>
        )}
        {rows.map((row, i) => {
          if (row.type === "hour") {
            return (
              <div
                key={`h${row.ms}`}
                className="px-3 py-1 text-[10px] uppercase tracking-wide text-neutral-600 bg-neutral-950/40 sticky top-0"
              >
                {row.label}
              </div>
            );
          }
          if (row.type === "incident") {
            const inc = row.inc;
            const durS = Math.max(
              0,
              Math.round(
                (new Date(inc.last_detection_at).getTime() -
                  new Date(inc.started_at).getTime()) /
                  1000,
              ),
            );
            return (
              <div
                key={inc.id}
                className={`px-3 py-1.5 flex items-start gap-2 cursor-pointer hover:bg-neutral-800 ${
                  hoveredIncidentId === inc.id ? "bg-neutral-800" : ""
                } ${inc.acknowledged ? "opacity-50" : ""}`}
                onMouseEnter={() => onHoverIncident(inc.id)}
                onMouseLeave={() => onHoverIncident(null)}
                onClick={() => onSelectIncident(inc)}
              >
                <span className={`${severityColor(inc.severity)} leading-4`}>●</span>
                <span className="text-neutral-500 tabular-nums shrink-0">
                  {msToHHMMSS(row.msInDay)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="text-neutral-200">
                    {inc.classes.join(" + ")} ×{inc.detection_count}
                  </span>
                  <span className="text-neutral-500"> · {cameraName(inc.camera_id)}</span>
                  {durS > 0 && <span className="text-neutral-600"> · {durS}s</span>}
                </span>
                {isAdmin && !inc.acknowledged && (
                  <button
                    type="button"
                    className="text-neutral-500 hover:text-white shrink-0"
                    title="Acknowledge"
                    onClick={(e) => {
                      e.stopPropagation();
                      onAck(inc.id);
                    }}
                  >
                    ack
                  </button>
                )}
              </div>
            );
          }
          const n = row.n;
          return (
            <div
              key={`n${i}`}
              className="px-3 py-1.5 flex items-start gap-2 cursor-pointer hover:bg-neutral-800"
              onClick={() => onSelectNotable(n.d.camera_id, n.msInDay)}
            >
              <span
                className={`leading-4 ${
                  n.d.kind === "anpr"
                    ? "text-emerald-400"
                    : n.d.kind === "print_defect"
                      ? "text-orange-400"
                      : "text-sky-400"
                }`}
              >
                ◆
              </span>
              <span className="text-neutral-500 tabular-nums shrink-0">
                {msToHHMMSS(n.msInDay)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-neutral-200">
                  {n.label}
                  {n.count > 1 ? ` ×${n.count}` : ""}
                </span>
                <span className="text-neutral-500">
                  {" "}
                  · {n.detail} · {cameraName(n.d.camera_id)}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

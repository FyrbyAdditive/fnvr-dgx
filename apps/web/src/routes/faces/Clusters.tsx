import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, Cluster, ClusterMember, DriftStatus, Person } from "@/lib/api";

// ClustersPanel: unknown-face review surface.
//
// The ml-worker runs HDBSCAN nightly over the last week's unmatched
// face embeddings and writes results into face_clusters. Operators
// see recurring strangers here and name whole clusters in one click.
//
// "Find clusters now" triggers an on-demand batch on the worker; the
// nightly cron handles the unattended case.
export function ClustersPanel({
  isAdmin,
  onEnrolled: _onEnrolled,
}: {
  isAdmin: boolean;
  onEnrolled: () => void;
}) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(null);
  const { data: clusters = [], refetch } = useQuery({
    queryKey: ["clusters"],
    queryFn: () => api.clustersList(true),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
  const status = useQuery({
    queryKey: ["cluster-status"],
    queryFn: api.clusterStatus,
    // Poll only while a job looks in-flight; otherwise keep it
    // cheap. We don't have a running flag on the status response
    // so just always poll at 5s — single-row SELECT, negligible.
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  });
  const runNow = useMutation({
    mutationFn: api.clusterRunNow,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cluster-status"] });
      // Refetch clusters shortly after the job would likely have
      // written new rows; the 15s poll picks up the rest.
      setTimeout(() => qc.invalidateQueries({ queryKey: ["clusters"] }), 5_000);
    },
  });

  const statePayload = (status.data?.last_run_state as
    | { state?: string; at?: string; clusters_written?: number; members_written?: number; new_clusters?: number; preserved_clusters?: number; noise?: number }
    | null
    | undefined) ?? undefined;

  return (
    <section>
      <div className="flex items-baseline gap-3 mb-2 flex-wrap">
        <h2 className="text-lg font-semibold">Unknown-face clusters</h2>
        <span className="text-xs text-neutral-500">
          strangers seen ≥3 times in the last 7 days
        </span>
        {isAdmin && (
          <button
            className="text-blue-400 hover:underline text-sm disabled:opacity-50"
            onClick={() => runNow.mutate()}
            disabled={runNow.isPending || statePayload?.state === "running"}
          >
            {statePayload?.state === "running" ? "clustering…" : "find clusters now"}
          </button>
        )}
        <DriftPill />
      </div>
      {statePayload && statePayload.state && statePayload.state !== "running" && (
        <div
          className={`mb-3 text-xs rounded p-2 ${
            statePayload.state === "error"
              ? "bg-red-950/40 border border-red-900 text-red-200"
              : "bg-neutral-900/60 border border-neutral-800 text-neutral-400"
          }`}
        >
          {statePayload.state === "ok" && (
            <>
              Last run at {statePayload.at ? new Date(statePayload.at).toLocaleTimeString() : "?"}
              {" — "}
              {statePayload.clusters_written ?? 0} cluster
              {statePayload.clusters_written === 1 ? "" : "s"} written
              ({statePayload.new_clusters ?? 0} new, {statePayload.preserved_clusters ?? 0} updated),
              {" "}{statePayload.noise ?? 0} noise points.
            </>
          )}
          {statePayload.state === "error" && "Last run failed — see api logs."}
        </div>
      )}
      {clusters.length === 0 ? (
        <p className="text-neutral-500 text-sm">
          No unenrolled clusters yet.
          {isAdmin ? " Click “find clusters now” to scan the last week." : ""}
        </p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3">
          {clusters.map((c) => (
            <ClusterTile
              key={c.id}
              cluster={c}
              isAdmin={isAdmin}
              expanded={expanded === c.id}
              onToggle={() => setExpanded(expanded === c.id ? null : c.id)}
              onChanged={() => {
                refetch();
                qc.invalidateQueries({ queryKey: ["persons"] });
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ClusterTile({
  cluster,
  isAdmin,
  expanded,
  onToggle,
  onChanged,
}: {
  cluster: Cluster;
  isAdmin: boolean;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const { data: persons = [] } = useQuery({
    queryKey: ["persons"],
    queryFn: api.listPersons,
  });
  const members = useQuery({
    queryKey: ["cluster-members", cluster.id],
    queryFn: () => api.clusterMembers(cluster.id),
    enabled: expanded,
  });
  const [pickId, setPickId] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const enrol = useMutation({
    mutationFn: () => {
      if (pickId) {
        return api.clusterEnrol(cluster.id, { person_id: pickId });
      }
      return api.clusterEnrol(cluster.id, { new_label: newLabel.trim() });
    },
    onSuccess: () => {
      setPickId("");
      setNewLabel("");
      onChanged();
    },
  });
  const del = useMutation({
    mutationFn: () => api.clusterDelete(cluster.id),
    onSuccess: onChanged,
  });
  // "not a face" = dismiss + train. Every member's embedding lands
  // in face_dismissals(reason='not_a_face') so the next rules-engine
  // reload penalises future matches that look like this cluster.
  const notAFace = useMutation({
    mutationFn: () => api.clusterDismissNotAFace(cluster.id),
    onSuccess: onChanged,
  });

  return (
    <div className="border border-neutral-800 rounded overflow-hidden">
      <button
        className="aspect-square bg-neutral-900 flex items-center justify-center overflow-hidden relative w-full"
        onClick={onToggle}
        title={expanded ? "collapse" : "expand members"}
      >
        {cluster.representative_thumbnail_url ? (
          <img
            src={cluster.representative_thumbnail_url}
            alt=""
            className="w-full h-full object-cover"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        ) : (
          <span className="text-xs text-neutral-600">no preview</span>
        )}
        <span className="absolute top-1 right-1 bg-neutral-900/80 text-neutral-200 text-[10px] font-medium px-1.5 py-0.5 rounded">
          ×{cluster.member_count}
        </span>
      </button>
      {expanded && (
        <div className="p-2 text-xs space-y-2">
          <div className="text-neutral-500">
            {cluster.first_seen && cluster.last_seen && (
              <>
                {new Date(cluster.first_seen).toLocaleDateString()} →{" "}
                {new Date(cluster.last_seen).toLocaleDateString()}
              </>
            )}
          </div>
          <div className="grid grid-cols-4 gap-1 max-h-40 overflow-auto">
            {(members.data ?? []).map((m: ClusterMember) => (
              <img
                key={m.detection_id}
                src={m.thumbnail_url}
                alt=""
                className="aspect-square object-cover bg-neutral-900"
                title={`similarity ${(m.similarity_to_centroid * 100).toFixed(0)}%`}
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
            ))}
          </div>
          {isAdmin && (
            <div className="space-y-1">
              <select
                className="w-full bg-neutral-900 border border-neutral-700 rounded px-1 py-0.5"
                value={pickId}
                onChange={(e) => setPickId(e.target.value)}
              >
                <option value="">— new person —</option>
                {persons.map((p: Person) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
              {!pickId && (
                <input
                  className="w-full bg-neutral-900 border border-neutral-700 rounded px-1 py-0.5"
                  placeholder="new name"
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                />
              )}
              <div className="flex gap-1 items-center">
                <button
                  className="flex-1 bg-blue-600 hover:bg-blue-500 rounded px-1 py-0.5 disabled:opacity-50"
                  disabled={enrol.isPending || (!pickId && !newLabel.trim())}
                  onClick={() => enrol.mutate()}
                >
                  {enrol.isPending ? "enrolling…" : `enrol (×${cluster.member_count})`}
                </button>
                <button
                  className="text-amber-400 hover:text-amber-200 disabled:opacity-50"
                  disabled={notAFace.isPending}
                  title="Dismiss AND record every member as a negative so the matcher penalises similar detections in future."
                  onClick={() => {
                    if (
                      confirm(
                        `Mark all ${cluster.member_count} faces in this cluster as 'not a face'? ` +
                          `This trains the matcher to score similar detections down in future.`,
                      )
                    ) {
                      notAFace.mutate();
                    }
                  }}
                >
                  {notAFace.isPending ? "training…" : "not a face"}
                </button>
                <button
                  className="text-neutral-400 hover:text-neutral-200 disabled:opacity-50"
                  disabled={del.isPending}
                  title="Hide without training signal."
                  onClick={() => {
                    if (confirm(`Dismiss cluster of ${cluster.member_count} faces?`)) {
                      del.mutate();
                    }
                  }}
                >
                  dismiss
                </button>
              </div>
              {notAFace.isError && (
                <div className="text-red-400">
                  {String((notAFace.error as Error)?.message ?? "failed")}
                </div>
              )}
              {enrol.isError && (
                <div className="text-red-400">
                  {String((enrol.error as Error)?.message ?? "failed")}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// DriftPill is a compact indicator of the ml-worker's last
// face-embedding self-match check. The data is authored by drift.py
// on its weekly schedule + whenever someone invokes it manually; the
// api-server just reads two settings rows.
//
// Colour semantics:
//   green: |delta| < 2%            — noise-level, embedder stable
//   amber: 2% <= |delta| < 5%      — watch
//   red:   |delta| >= 5%           — drift alert territory (this is
//                                    the same threshold that fires an
//                                    incident + dispatches)
// Neutral when baseline or last-check are still absent.
function DriftPill() {
  const { data } = useQuery({
    queryKey: ["drift-status"],
    queryFn: api.driftStatus,
    // Status only changes when drift.py runs (weekly by default).
    // 60s is more than sufficient; cheap anyway (two settings reads).
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
  if (!data) return null;
  const d: DriftStatus = data;
  if (d.baseline === null || d.last_current === null) {
    return (
      <span className="text-xs text-neutral-500" title="drift check hasn't run yet">
        drift: —
      </span>
    );
  }
  const delta = d.last_delta ?? 0;
  const abs = Math.abs(delta);
  let tone = "bg-emerald-950/50 border-emerald-900 text-emerald-300";
  if (abs >= d.threshold) {
    tone = "bg-red-950/50 border-red-900 text-red-300";
  } else if (abs >= d.threshold * 0.4) {
    tone = "bg-amber-950/50 border-amber-900 text-amber-300";
  }
  const age = d.last_check_at
    ? formatAge(new Date(d.last_check_at))
    : null;
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded border ${tone}`}
      title={`baseline ${d.baseline.toFixed(3)} · current ${d.last_current.toFixed(3)}${age ? ` · ${age} ago` : ""}`}
    >
      drift: {d.last_current.toFixed(3)} ({delta >= 0 ? "−" : "+"}
      {(abs * 100).toFixed(1)}%)
    </span>
  );
}

function formatAge(d: Date): string {
  const secs = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (secs < 60) return `${Math.round(secs)}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h`;
  return `${Math.round(secs / 86400)}d`;
}

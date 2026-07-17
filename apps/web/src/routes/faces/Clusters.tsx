import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, DriftStatus } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { formatRelativeAge } from "@/lib/format";
import { parseClusterRunState } from "./reviewLogic";

// Cluster run controls + status shared by the Faces header: the
// "find clusters now" button and the last-run summary banner. The
// cluster tiles themselves live in the ReviewCard.

export function ClusterRunButton({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const status = useQuery({
    queryKey: ["cluster-status"],
    queryFn: api.clusterStatus,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  });
  const runNow = useMutation({
    mutationFn: api.clusterRunNow,
    onSuccess: () => {
      toast.info("Clustering started — new clusters appear when it finishes");
      qc.invalidateQueries({ queryKey: ["cluster-status"] });
      setTimeout(() => qc.invalidateQueries({ queryKey: ["clusters"] }), 5_000);
    },
    onError: (e) => toast.error(String((e as Error)?.message ?? "failed to start")),
  });
  if (!isAdmin) return null;
  const state = parseClusterRunState(status.data?.last_run_state);
  const running = state?.state === "running";
  return (
    <button
      className="rounded border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:text-white disabled:opacity-50 whitespace-nowrap"
      onClick={() => runNow.mutate()}
      disabled={runNow.isPending || running}
      title="Scan the last week's unmatched faces for recurring strangers"
    >
      {running ? "Clustering…" : "Find clusters now"}
    </button>
  );
}

export function ClusterRunBanner() {
  const status = useQuery({
    queryKey: ["cluster-status"],
    queryFn: api.clusterStatus,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  });
  const s = parseClusterRunState(status.data?.last_run_state);
  if (!s || s.state === "running") return null;
  if (s.state === "error") {
    return (
      <div className="text-xs rounded p-2 bg-red-950/40 border border-red-900 text-red-200">
        Last clustering run failed — see api logs.
      </div>
    );
  }
  return (
    <div className="text-xs rounded p-2 bg-neutral-900/60 border border-neutral-800 text-neutral-400">
      Last clustering run{s.at ? ` ${formatRelativeAge(new Date(s.at))}` : ""} —{" "}
      {s.clusters_written ?? 0} cluster{s.clusters_written === 1 ? "" : "s"}
      {" "}({s.new_clusters ?? 0} new, {s.preserved_clusters ?? 0} updated),
      {" "}{s.noise ?? 0} noise points.
    </div>
  );
}

// DriftPill: compact indicator of the ml-worker's last face-embedding
// self-match check (drift.py, weekly + manual). Green: |delta| below
// 40% of the alert threshold; amber: watch; red: alert territory.
export function DriftPill() {
  const { data } = useQuery({
    queryKey: ["drift-status"],
    queryFn: api.driftStatus,
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
  const age = d.last_check_at ? formatRelativeAge(new Date(d.last_check_at)) : null;
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded border ${tone}`}
      title={`baseline ${d.baseline.toFixed(3)} · current ${d.last_current.toFixed(3)}${age ? ` · ${age}` : ""}`}
    >
      drift: {d.last_current.toFixed(3)} ({delta >= 0 ? "−" : "+"}
      {(abs * 100).toFixed(1)}%)
    </span>
  );
}

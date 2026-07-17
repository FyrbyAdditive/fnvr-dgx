import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { FaceTile } from "./FaceTile";
import { ClusterTile } from "./ClusterTile";
import { PersonPicker } from "./PersonPicker";
import {
  buildDismissItems,
  buildEnrolVectors,
  DismissReason,
  nextLimit,
} from "./reviewLogic";

// The unified triage surface: recurring strangers (clusters) first —
// they're the aggregated signal worth naming — then recent sightings,
// with filters, pagination, and multi-select bulk actions.
export function ReviewCard({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  const [camera, setCamera] = useState("");
  const [hours, setHours] = useState(24);
  const [onlyUnmatched, setOnlyUnmatched] = useState(true);
  const [limit, setLimit] = useState(60);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [expandedCluster, setExpandedCluster] = useState<string | null>(null);
  const [showBulkEnrol, setShowBulkEnrol] = useState(false);

  const { data: cameras = [] } = useQuery({ queryKey: ["cameras"], queryFn: api.listCameras });
  const clusters = useQuery({
    queryKey: ["clusters"],
    queryFn: () => api.clustersList(true),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
  const recent = useQuery({
    queryKey: ["recent-faces", camera, hours, onlyUnmatched, limit],
    queryFn: () =>
      api.recentFaces({
        hours,
        limit,
        unmatched: onlyUnmatched,
        collapse: true, // always group near-duplicates — the flood backstop
        camera: camera || undefined,
      }),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
  const faces = recent.data ?? [];

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["recent-faces"] });
    qc.invalidateQueries({ queryKey: ["clusters"] });
    qc.invalidateQueries({ queryKey: ["persons"] });
    setSelected(new Set());
  };

  const toggleSelect = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const bulkTotal = buildDismissItems(faces, selected, "deleted").length;

  const bulkDismiss = useMutation({
    mutationFn: async (reason: DismissReason) => {
      const items = buildDismissItems(faces, selected, reason);
      if (items.length === 0) throw new Error("nothing selected with embeddings");
      await api.dismissFaces(items);
      return items.length;
    },
    onSuccess: (n, reason) => {
      invalidate();
      toast.success(
        reason === "not_a_face"
          ? `Marked ${n} samples as not-a-face negatives`
          : `Dismissed ${n} samples`,
      );
    },
    onError: (e) => toast.error(String((e as Error)?.message ?? "bulk action failed")),
  });

  const bulkEnrol = useMutation({
    mutationFn: async ({ personId, newLabel }: { personId: string; newLabel: string }) => {
      let pid = personId;
      if (!pid) {
        const p = await api.createPerson({ label: newLabel, alert_on_match: false });
        pid = p.id;
      }
      const vectors = buildEnrolVectors(faces, selected);
      if (vectors.length === 0) throw new Error("nothing selected with embeddings");
      await api.addPersonEmbeddingsBulk(pid, vectors);
      try {
        await api.dismissFaces(buildDismissItems(faces, selected, "enrolled"));
      } catch {
        /* best-effort autohide */
      }
      return vectors.length;
    },
    onSuccess: (n) => {
      setShowBulkEnrol(false);
      invalidate();
      toast.success(`Enrolled ${n} face samples`);
    },
    onError: (e) => toast.error(String((e as Error)?.message ?? "bulk enrol failed")),
  });

  const clusterList = clusters.data ?? [];

  return (
    <Card
      title="Review queue"
      description="Recurring strangers first, then recent sightings. Enrol, dismiss, or mark false positives."
      headerRight={
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <select
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-xs"
            value={camera}
            onChange={(e) => setCamera(e.target.value)}
          >
            <option value="">All cameras</option>
            {cameras.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <div className="inline-flex rounded-md border border-neutral-800 overflow-hidden">
            {[
              { h: 1, label: "1h" },
              { h: 24, label: "24h" },
              { h: 168, label: "7d" },
            ].map(({ h, label }) => (
              <button
                key={h}
                onClick={() => setHours(h)}
                className={`px-2 py-1 text-xs ${
                  hours === h
                    ? "bg-neutral-800 text-white"
                    : "bg-neutral-900 text-neutral-400 hover:text-white"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="text-xs inline-flex items-center gap-1 text-neutral-400">
            <input
              type="checkbox"
              checked={onlyUnmatched}
              onChange={(e) => setOnlyUnmatched(e.target.checked)}
            />
            only unmatched
          </label>
        </div>
      }
    >
      {/* Recurring strangers (clusters). Not camera-scoped — a person
          seen on several cameras clusters together. */}
      {clusterList.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs uppercase tracking-wide text-neutral-500">
            Recurring strangers
            <span className="normal-case tracking-normal ml-2">
              seen ≥3 times, last 7 days
            </span>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3">
            {clusterList.map((c) => (
              <ClusterTile
                key={c.id}
                cluster={c}
                isAdmin={isAdmin}
                expanded={expandedCluster === c.id}
                onToggle={() => setExpandedCluster(expandedCluster === c.id ? null : c.id)}
                onChanged={invalidate}
              />
            ))}
          </div>
        </div>
      )}

      {/* Recent sightings. */}
      <div className="space-y-2">
        {clusterList.length > 0 && (
          <div className="text-xs uppercase tracking-wide text-neutral-500">
            Recent sightings
          </div>
        )}
        {recent.isLoading ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="aspect-square rounded-lg bg-neutral-900 animate-pulse" />
            ))}
          </div>
        ) : faces.length === 0 ? (
          <p className="text-neutral-500 text-sm">
            {camera || hours !== 24 || !onlyUnmatched
              ? "No face detections match these filters."
              : "No face detections in this window. Enable Face ID in Settings → Detection if it's off."}
          </p>
        ) : (
          <>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
              {faces.map((f) => (
                <FaceTile
                  key={f.detection_id}
                  face={f}
                  isAdmin={isAdmin}
                  selected={selected.has(f.detection_id)}
                  onToggleSelect={() => toggleSelect(f.detection_id)}
                  onChanged={invalidate}
                />
              ))}
            </div>
            <div className="flex items-center gap-3 text-xs text-neutral-500">
              <span>showing {faces.length} group{faces.length === 1 ? "" : "s"}</span>
              {faces.length >= limit && limit < 480 && (
                <button
                  className="text-blue-400 hover:underline"
                  onClick={() => setLimit(nextLimit(limit))}
                >
                  Show more
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {/* Sticky bulk-action bar. */}
      {isAdmin && selected.size > 0 && (
        <div className="sticky bottom-2 bg-neutral-900/95 border border-neutral-700 rounded-lg p-2 text-sm flex items-center gap-3 shadow-lg backdrop-blur">
          <span className="tabular-nums">
            {selected.size} selected ({bulkTotal} samples)
          </span>
          <button
            className="text-neutral-400 hover:underline text-xs"
            onClick={() => setSelected(new Set())}
          >
            clear
          </button>
          <div className="ml-auto flex items-center gap-2">
            <button
              className="text-sm px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50"
              disabled={bulkEnrol.isPending}
              onClick={() => setShowBulkEnrol(true)}
            >
              Enrol to person…
            </button>
            <button
              className="text-sm px-3 py-1 rounded border border-red-800 text-red-300 hover:bg-red-950/50 disabled:opacity-50"
              disabled={bulkDismiss.isPending}
              onClick={async () => {
                const ok = await confirm({
                  title: `Mark ${bulkTotal} samples as "not a face"?`,
                  body: "Also trains the matcher to penalise similar detections.",
                  confirmLabel: "Not a face",
                });
                if (ok) bulkDismiss.mutate("not_a_face");
              }}
            >
              Not a face
            </button>
            <button
              className="text-sm px-3 py-1 rounded border border-neutral-700 text-neutral-300 hover:text-white disabled:opacity-50"
              disabled={bulkDismiss.isPending}
              title="Hide from the queue — no training impact"
              onClick={() => bulkDismiss.mutate("deleted")}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <PersonPicker
        open={showBulkEnrol}
        title={`Enrol ${bulkTotal} face samples`}
        submitLabel={`Enrol ×${bulkTotal}`}
        pending={bulkEnrol.isPending}
        onSubmit={(personId, newLabel) => bulkEnrol.mutate({ personId, newLabel })}
        onClose={() => setShowBulkEnrol(false)}
      />
    </Card>
  );
}

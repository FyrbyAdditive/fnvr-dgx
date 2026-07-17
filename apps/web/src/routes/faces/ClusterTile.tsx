import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, Cluster, ClusterMember } from "@/lib/api";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { PersonPicker } from "./PersonPicker";

// One unknown-face cluster (recurring stranger). Expand to see the
// member sightings; enrol the whole cluster in one action.
export function ClusterTile({
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
  const toast = useToast();
  const confirm = useConfirm();
  const members = useQuery({
    queryKey: ["cluster-members", cluster.id],
    queryFn: () => api.clusterMembers(cluster.id),
    enabled: expanded,
  });
  const [showEnrol, setShowEnrol] = useState(false);

  const enrol = useMutation({
    mutationFn: ({ personId, newLabel }: { personId: string; newLabel: string }) =>
      personId
        ? api.clusterEnrol(cluster.id, { person_id: personId })
        : api.clusterEnrol(cluster.id, { new_label: newLabel }),
    onSuccess: (res) => {
      setShowEnrol(false);
      onChanged();
      toast.success(
        `Enrolled cluster — ${res.added} embeddings added` +
          (res.retro_matched > 0
            ? ` · ${res.retro_matched} earlier sighting${res.retro_matched === 1 ? "" : "s"} auto-matched`
            : ""),
      );
    },
    onError: (e) => toast.error(String((e as Error)?.message ?? "enrol failed")),
  });
  const del = useMutation({
    mutationFn: () => api.clusterDelete(cluster.id),
    onSuccess: () => {
      onChanged();
      toast.success("Cluster dismissed");
    },
    onError: (e) => toast.error(String((e as Error)?.message ?? "dismiss failed")),
  });
  const notAFace = useMutation({
    mutationFn: () => api.clusterDismissNotAFace(cluster.id),
    onSuccess: (res) => {
      onChanged();
      toast.success(`Marked ${res.dismissed} samples as not-a-face negatives`);
    },
    onError: (e) => toast.error(String((e as Error)?.message ?? "failed")),
  });

  return (
    <div className="rounded-lg overflow-hidden border border-neutral-800 bg-neutral-950">
      <button
        className="aspect-square bg-neutral-900 flex items-center justify-center overflow-hidden relative w-full"
        onClick={onToggle}
        title={expanded ? "Collapse" : "Expand members"}
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
        <span className="absolute top-1 right-1 bg-black/70 text-neutral-200 text-[10px] font-medium px-1.5 py-0.5 rounded-full">
          ×{cluster.member_count}
        </span>
        <span className="absolute bottom-1 right-1 text-[10px] px-1.5 py-0.5 rounded-full bg-violet-900/80 text-violet-200">
          recurring
        </span>
      </button>
      {expanded && (
        <div className="p-2 text-xs space-y-2">
          {cluster.first_seen && cluster.last_seen && (
            <div className="text-neutral-500">
              {new Date(cluster.first_seen).toLocaleDateString()} →{" "}
              {new Date(cluster.last_seen).toLocaleDateString()}
            </div>
          )}
          <div className="grid grid-cols-4 gap-1 max-h-48 overflow-auto">
            {(members.data ?? []).map((m: ClusterMember) => (
              <img
                key={m.detection_id}
                src={m.thumbnail_url}
                alt=""
                className="aspect-square object-cover bg-neutral-900 rounded"
                title={`similarity ${(m.similarity_to_centroid * 100).toFixed(0)}%`}
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
            ))}
          </div>
          {isAdmin && (
            <div className="flex gap-2 flex-wrap">
              <button
                className="text-blue-400 hover:text-blue-300"
                onClick={() => setShowEnrol(true)}
              >
                enrol ×{cluster.member_count}
              </button>
              <button
                className="text-red-400 hover:text-red-300 disabled:opacity-50"
                disabled={notAFace.isPending}
                title="Dismiss AND record every member as a negative"
                onClick={async () => {
                  const ok = await confirm({
                    title: `Mark all ${cluster.member_count} faces as "not a face"?`,
                    body: "Trains the matcher to score similar detections down in future.",
                    confirmLabel: "Not a face",
                  });
                  if (ok) notAFace.mutate();
                }}
              >
                {notAFace.isPending ? "training…" : "not a face"}
              </button>
              <button
                className="text-neutral-400 hover:text-neutral-200 disabled:opacity-50"
                disabled={del.isPending}
                title="Hide without training signal"
                onClick={async () => {
                  const ok = await confirm({
                    title: `Dismiss cluster of ${cluster.member_count} faces?`,
                    confirmLabel: "Dismiss",
                    tone: "danger",
                  });
                  if (ok) del.mutate();
                }}
              >
                dismiss
              </button>
            </div>
          )}
        </div>
      )}
      <PersonPicker
        open={showEnrol}
        title={`Enrol cluster (${cluster.member_count} sightings)`}
        submitLabel={`Enrol ×${cluster.member_count}`}
        pending={enrol.isPending}
        onSubmit={(personId, newLabel) => enrol.mutate({ personId, newLabel })}
        onClose={() => setShowEnrol(false)}
      />
    </div>
  );
}

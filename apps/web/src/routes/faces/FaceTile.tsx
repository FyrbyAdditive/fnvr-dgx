import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, RecentFace } from "@/lib/api";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { formatRelativeAge } from "@/lib/format";
import { PersonPicker } from "./PersonPicker";
import {
  buildDismissItems,
  buildEnrolVectors,
  DismissReason,
  enrolToastMessage,
} from "./reviewLogic";

// One face group in the review queue (or the person-matches grid).
// Touch-first: actions always visible, confirms via dialog, results
// via toast. A tile represents its representative detection plus any
// collapsed near-duplicate members (×N badge).
export function FaceTile({
  face,
  isAdmin,
  selected,
  onToggleSelect,
  onChanged,
}: {
  face: RecentFace;
  isAdmin: boolean;
  /** Present when the parent grid supports multi-select. */
  selected?: boolean;
  onToggleSelect?: () => void;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [showEnrol, setShowEnrol] = useState(false);

  const all = new Set([face.detection_id]);

  const dismissAs = async (reason: DismissReason) => {
    const items = buildDismissItems([face], all, reason);
    if (items.length === 0) throw new Error("no embedding on this detection");
    await api.dismissFaces(items);
  };

  const enrol = useMutation({
    mutationFn: async ({ personId, newLabel }: { personId: string; newLabel: string }) => {
      let pid = personId;
      if (!pid) {
        const p = await api.createPerson({ label: newLabel, alert_on_match: false });
        pid = p.id;
      }
      const vectors = buildEnrolVectors([face], all);
      if (vectors.length === 0) throw new Error("no embedding on this detection");
      const res = await api.addPersonEmbeddingsBulk(pid, vectors);
      // Best-effort autohide — the enrolment itself has committed.
      try { await dismissAs("enrolled"); } catch { /* ignore */ }
      return res;
    },
    onSuccess: (res) => {
      setShowEnrol(false);
      qc.invalidateQueries({ queryKey: ["persons"] });
      qc.invalidateQueries({ queryKey: ["recent-faces"] });
      onChanged();
      toast.success(enrolToastMessage(res));
    },
    onError: (e) => toast.error(String((e as Error)?.message ?? "enrol failed")),
  });

  const dismiss = useMutation({
    mutationFn: (reason: DismissReason) => dismissAs(reason),
    onSuccess: (_, reason) => {
      onChanged();
      if (reason === "not_a_face") toast.success("Marked as not a face — matcher will penalise similar detections");
    },
    onError: (e) => toast.error(String((e as Error)?.message ?? "dismiss failed")),
  });

  const matched = !!face.person;
  const count = face.count && face.count > 1 ? face.count : 0;
  const border = matched
    ? "border-emerald-700 ring-1 ring-emerald-500/30"
    : selected
      ? "border-blue-500 ring-1 ring-blue-500/40"
      : "border-neutral-800";

  return (
    <div className={`rounded-lg overflow-hidden border relative bg-neutral-950 ${border}`}>
      <div className="aspect-square bg-neutral-900 flex items-center justify-center overflow-hidden relative">
        {face.thumbnail_url ? (
          <img
            src={face.thumbnail_url}
            alt=""
            className="w-full h-full object-cover"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        ) : (
          <span className="text-xs text-neutral-600">no preview</span>
        )}
        {/* Selectable only when the row carries a current-space
            embedding — a tile with no vector has nothing to enrol or
            train on, and counting it would make the bulk bar lie. */}
        {onToggleSelect && isAdmin && !!face.vector && (
          <label
            className="absolute top-1 left-1 bg-black/60 rounded px-1 py-0.5 flex items-center cursor-pointer"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              type="checkbox"
              className="accent-blue-500"
              checked={!!selected}
              onChange={onToggleSelect}
            />
          </label>
        )}
        {count > 0 && (
          <span
            className="absolute top-1 right-1 bg-black/70 text-neutral-200 text-[10px] font-medium px-1.5 py-0.5 rounded-full"
            title={`${count} near-duplicate detections`}
          >
            ×{count}
          </span>
        )}
        {matched ? (
          <span className="absolute bottom-1 right-1 text-[10px] tabular-nums px-1.5 py-0.5 rounded-full bg-emerald-900/80 text-emerald-200">
            {(face.similarity! * 100).toFixed(0)}%
          </span>
        ) : (
          <span className="absolute bottom-1 right-1 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-900/80 text-amber-200">
            unmatched
          </span>
        )}
      </div>
      <div className="p-2 text-xs space-y-1">
        {matched && (
          <div className="text-emerald-400 font-medium truncate">{face.person}</div>
        )}
        <div className="text-neutral-500 truncate">
          {face.camera_id} · {formatRelativeAge(new Date(face.ts))}
        </div>
        {isAdmin && face.vector && (
          <div className="flex gap-2 flex-wrap pt-0.5">
            <button
              className="text-blue-400 hover:text-blue-300"
              onClick={() => setShowEnrol(true)}
              title={
                matched
                  ? "Move this detection's embedding to a different (or new) person"
                  : "Enrol this detection against a person"
              }
            >
              {matched ? "reassign" : "enrol"}
            </button>
            <button
              className="text-red-400 hover:text-red-300 disabled:opacity-50"
              disabled={dismiss.isPending}
              title="False positive — also penalises similar future detections"
              onClick={async () => {
                const ok = await confirm({
                  title: count > 0
                    ? `Mark all ${count + 1} detections as "not a face"?`
                    : `Mark this as "not a face"?`,
                  body: "Also trains the matcher to penalise similar detections.",
                  confirmLabel: "Not a face",
                });
                if (ok) dismiss.mutate("not_a_face");
              }}
            >
              not a face
            </button>
            <button
              className="text-neutral-400 hover:text-neutral-200 disabled:opacity-50"
              disabled={dismiss.isPending}
              title="Hide from the queue — no training impact"
              onClick={() => dismiss.mutate("deleted")}
            >
              dismiss
            </button>
          </div>
        )}
      </div>
      <PersonPicker
        open={showEnrol}
        title={count > 0 ? `Enrol ${count + 1} face samples` : "Enrol face"}
        submitLabel={count > 0 ? `Enrol ×${count + 1}` : "Enrol"}
        pending={enrol.isPending}
        onSubmit={(personId, newLabel) => enrol.mutate({ personId, newLabel })}
        onClose={() => setShowEnrol(false)}
      />
    </div>
  );
}

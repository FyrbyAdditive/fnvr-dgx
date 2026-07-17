import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, faceThumbUrl, Person, PersonEmbedding } from "@/lib/api";
import { Dialog } from "@/components/ui/Dialog";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { FaceTile } from "./FaceTile";

// Person drill-down in a wide dialog (used to replace the whole page):
// the training-sample curation panel + the recent-matches grid.
export function PersonDetailDialog({
  person,
  isAdmin,
  onClose,
}: {
  person: Person;
  isAdmin: boolean;
  onClose: () => void;
}) {
  const { data: matches = [], refetch } = useQuery({
    queryKey: ["person-matches", person.id],
    queryFn: () => api.personMatches(person.id, { hours: 24 * 7, limit: 200 }),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });

  return (
    <Dialog
      open
      onClose={onClose}
      ariaLabel={`Person: ${person.label}`}
      panelClassName="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[min(96vw,64rem)] max-h-[85vh] overflow-y-auto p-4"
    >
      <div className="flex items-center gap-3 mb-3">
        <h3 className="text-lg font-semibold">{person.label}</h3>
        <span className="text-xs text-neutral-500">
          {person.embedding_count} training sample{person.embedding_count === 1 ? "" : "s"}
        </span>
        <button
          className="ml-auto px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200"
          onClick={onClose}
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      <PersonEmbeddingsPanel person={person} isAdmin={isAdmin} />

      <h4 className="text-md font-semibold mt-6 mb-1 flex items-baseline gap-3">
        Recent matches
        <span className="text-xs text-neutral-500 font-normal">last 7 days</span>
      </h4>
      <p className="text-sm text-neutral-500 mb-3">
        Detections the matcher assigned to this person. Flag bad matches,
        reassign, or dismiss from each tile.
      </p>
      {matches.length === 0 ? (
        <p className="text-neutral-500 text-sm">
          No matches for {person.label} yet. Matches appear after enrolment
          and the next matcher reload (≤30s).
        </p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
          {matches.map((f) => (
            <FaceTile key={f.detection_id} face={f} isAdmin={isAdmin} onChanged={refetch} />
          ))}
        </div>
      )}
    </Dialog>
  );
}

// PersonEmbeddingsPanel lists the rows in face_embeddings that define
// this person, with both a per-row delete and a bulk-outlier flow.
//
// Each tile carries a kNN-similarity badge: the mean cosine to the
// 3 most similar embeddings in this person's pool. Outliers (wrong
// person, or noise with no kin) score low; genuine pose/lighting
// variants stay healthy as long as they have similar siblings.
function PersonEmbeddingsPanel({
  person,
  isAdmin,
}: {
  person: Person;
  isAdmin: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { data: embeddings = [] } = useQuery({
    queryKey: ["person-embeddings", person.id],
    queryFn: () => api.listPersonEmbeddings(person.id),
  });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["person-embeddings", person.id] });
    qc.invalidateQueries({ queryKey: ["persons"] });
  };
  const del = useMutation({
    mutationFn: (embeddingID: string) =>
      api.deletePersonEmbedding(person.id, embeddingID),
    onSuccess: () => {
      invalidate();
      toast.success("Sample deleted");
    },
    onError: (e) => toast.error(String((e as Error)?.message ?? "delete failed")),
  });
  const bulkDel = useMutation({
    mutationFn: (ids: string[]) => api.bulkDeletePersonEmbeddings(person.id, ids),
    onSuccess: (res) => {
      setSelected(new Set());
      invalidate();
      toast.success(`Deleted ${res.deleted} samples`);
    },
    onError: (e) => toast.error(String((e as Error)?.message ?? "bulk delete failed")),
  });

  const [sortMode, setSortMode] = useState<"newest" | "outliers">("newest");
  const [threshold, setThreshold] = useState(1.0);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const visible = (() => {
    let v = embeddings;
    if (threshold < 1.0) {
      v = v.filter((e) => e.nearest_neighbour_similarity < threshold);
    }
    if (sortMode === "outliers") {
      v = [...v].sort(
        (a, b) => a.nearest_neighbour_similarity - b.nearest_neighbour_similarity,
      );
    }
    return v;
  })();

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="relative">
      <h4 className="text-md font-semibold mb-2 flex items-baseline gap-3 flex-wrap">
        Training samples
        <span className="text-xs text-neutral-500 font-normal">
          {threshold < 1.0
            ? `${visible.length} of ${embeddings.length} below ${threshold.toFixed(2)}`
            : `${embeddings.length} sample${embeddings.length === 1 ? "" : "s"}`}
        </span>
        <div className="ml-auto flex items-center gap-3 text-xs font-normal">
          <label className="flex items-center gap-1">
            <span className="text-neutral-500">sort</span>
            <select
              className="bg-neutral-900 border border-neutral-700 rounded px-1 py-0.5"
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as "newest" | "outliers")}
            >
              <option value="newest">newest</option>
              <option value="outliers">lowest neighbour-sim</option>
            </select>
          </label>
          <label
            className="flex items-center gap-1"
            title="Filter to embeddings whose mean cosine to the rest of this person's pool is below this value."
          >
            <span className="text-neutral-500">below</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              className="w-24"
            />
            <span className="tabular-nums text-neutral-400 w-8 text-right">
              {threshold === 1.0 ? "off" : threshold.toFixed(2)}
            </span>
          </label>
        </div>
      </h4>
      {embeddings.length === 0 ? (
        <p className="text-neutral-500 text-sm">
          No training samples — this person will never match.
        </p>
      ) : visible.length === 0 ? (
        <p className="text-neutral-500 text-sm">Nothing below that threshold.</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3 pb-2">
          {visible.map((e) => (
            <EmbeddingTile
              key={e.id}
              e={e}
              isAdmin={isAdmin}
              checked={selected.has(e.id)}
              onToggle={() => toggle(e.id)}
              onDelete={async () => {
                const remaining = embeddings.length - 1;
                const ok = await confirm({
                  title: remaining <= 0
                    ? "Delete the last training sample?"
                    : "Delete this training sample?",
                  body: remaining <= 0
                    ? `${person.label} will stop matching until you add more.`
                    : `${remaining} will remain.`,
                  confirmLabel: "Delete",
                  tone: "danger",
                });
                if (ok) del.mutate(e.id);
              }}
              deleting={del.isPending}
            />
          ))}
        </div>
      )}

      {isAdmin && selected.size > 0 && (
        <div className="sticky bottom-0 mt-3 bg-neutral-900/95 border border-neutral-700 rounded-lg p-2 text-sm flex items-center gap-3 shadow-lg">
          <span className="tabular-nums">{selected.size} selected</span>
          <button
            className="text-neutral-400 hover:underline text-xs"
            onClick={() => setSelected(new Set())}
          >
            clear
          </button>
          <button
            className="ml-auto bg-red-700 hover:bg-red-600 rounded px-3 py-1 text-xs disabled:opacity-50"
            disabled={bulkDel.isPending}
            onClick={async () => {
              const n = selected.size;
              const remaining = embeddings.length - n;
              const ok = await confirm({
                title: `Delete ${n} training sample${n === 1 ? "" : "s"}?`,
                body: remaining <= 0
                  ? `${person.label} will stop matching entirely.`
                  : `${remaining} will remain.`,
                confirmLabel: "Delete",
                tone: "danger",
              });
              if (ok) bulkDel.mutate(Array.from(selected));
            }}
          >
            {bulkDel.isPending ? "deleting…" : "delete selected"}
          </button>
        </div>
      )}
    </div>
  );
}

function EmbeddingTile({
  e,
  isAdmin,
  checked,
  onToggle,
  onDelete,
  deleting,
}: {
  e: PersonEmbedding;
  isAdmin: boolean;
  checked: boolean;
  onToggle: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  // kNN-similarity badge colour floors calibrated against observed
  // data: an outlier stranger scores <0.35; a real-person variant with
  // similar siblings lands ≥0.50 even across pose changes. Pools with
  // <2 embeddings have no neighbours — grey, not red.
  const sim = e.nearest_neighbour_similarity;
  const tone =
    sim === 0
      ? "bg-neutral-900/80 text-neutral-400"
      : sim < 0.35
        ? "bg-red-900/80 text-red-200"
        : sim < 0.5
          ? "bg-amber-900/80 text-amber-200"
          : "bg-emerald-900/80 text-emerald-200";
  // Live-capture samples resolve by detection id; photo uploads by
  // their upload-<sha8> source name (the thumbnail handler supports
  // both — upload tiles used to wrongly show "no preview").
  const thumbKey =
    e.detection_id ?? (e.source.startsWith("upload-") ? e.source : null);
  return (
    <div
      className={`border rounded-lg overflow-hidden ${
        checked ? "border-blue-500" : "border-neutral-800"
      }`}
    >
      <div className="aspect-square bg-neutral-900 flex items-center justify-center overflow-hidden relative">
        {thumbKey !== null ? (
          <img
            src={faceThumbUrl(thumbKey)}
            alt=""
            className="w-full h-full object-cover"
            onError={(ev) => {
              (ev.target as HTMLImageElement).style.display = "none";
            }}
          />
        ) : (
          <span className="text-xs text-neutral-600">no preview</span>
        )}
        {isAdmin && (
          <label className="absolute top-1 left-1 bg-black/60 rounded px-1 py-0.5 flex items-center cursor-pointer">
            <input
              type="checkbox"
              className="accent-blue-500"
              checked={checked}
              onChange={onToggle}
            />
          </label>
        )}
        <span
          className={`absolute bottom-1 right-1 text-[10px] tabular-nums px-1.5 py-0.5 rounded ${tone}`}
          title={
            "Avg cosine similarity to the 3 most similar embeddings in this person's pool. " +
            "Low = outlier (wrong person or heavy noise). Pool-wide diversity is healthy — " +
            "don't curate away legitimate pose/lighting variants."
          }
        >
          {sim === 0 ? "—" : sim.toFixed(2)}
        </span>
      </div>
      <div className="p-2 text-xs space-y-1">
        <div className="text-neutral-500 truncate" title={e.source}>
          {new Date(e.created_at).toLocaleString()}
        </div>
        {isAdmin && (
          <button
            className="text-red-400 hover:underline disabled:opacity-50"
            disabled={deleting}
            onClick={onDelete}
          >
            {deleting ? "…" : "delete"}
          </button>
        )}
      </div>
    </div>
  );
}

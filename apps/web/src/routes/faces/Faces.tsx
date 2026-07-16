import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, Person, RecentFace } from "@/lib/api";
import { useMe } from "@/lib/me";
import { ClustersPanel } from "./Clusters";
import { UploadEnrolModal } from "./UploadEnrolModal";

// Faces tab.
// - Default view: Recent faces grid (un/matched + group-similar) +
//   Persons list. Clicking a person name drills into their match log.
// - Drill-down view: PersonMatches grid of detections resolved to the
//   selected person, with a back button. Reuses FaceTile so "not a
//   face" works the same — useful for catching matcher misfires.
export function Faces() {
  const { data: me } = useMe();
  const isAdmin = !!me?.is_admin;
  const [selectedPerson, setSelectedPerson] = useState<Person | null>(null);

  if (selectedPerson) {
    return (
      <div className="p-4 space-y-4 max-w-5xl">
        <PersonMatches
          person={selectedPerson}
          isAdmin={isAdmin}
          onBack={() => setSelectedPerson(null)}
        />
      </div>
    );
  }
  return (
    <div className="p-4 space-y-6 max-w-5xl">
      <RecentFacesGrid isAdmin={isAdmin} />
      <ClustersPanel isAdmin={isAdmin} onEnrolled={() => { /* react-query invalidations live in the panel */ }} />
      <Persons isAdmin={isAdmin} onSelect={setSelectedPerson} />
    </div>
  );
}

function PersonMatches({
  person,
  isAdmin,
  onBack,
}: {
  person: Person;
  isAdmin: boolean;
  onBack: () => void;
}) {
  const { data: matches = [], refetch } = useQuery({
    queryKey: ["person-matches", person.id],
    queryFn: () => api.personMatches(person.id, { hours: 24 * 7, limit: 200 }),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
  return (
    <section>
      <div className="flex items-baseline gap-3 mb-2">
        <button
          className="text-blue-400 hover:underline text-sm"
          onClick={onBack}
        >
          ← back
        </button>
        <h2 className="text-lg font-semibold">
          {person.label}
        </h2>
      </div>
      <PersonEmbeddingsPanel person={person} isAdmin={isAdmin} />
      <h3 className="text-md font-semibold mt-6 mb-2 flex items-baseline gap-3">
        Recent matches
        <span className="text-xs text-neutral-500 font-normal">last 7 days</span>
      </h3>
      <p className="text-sm text-neutral-500 mb-3">
        Detections the matcher assigned to this person. Use the
        buttons on each tile to flag bad matches, reassign to a
        different person, or hide the tile.
      </p>
      {matches.length === 0 ? (
        <p className="text-neutral-500 text-sm">
          No matches for {person.label} yet. Matches appear after
          enrolment and the next event-processor reload (≤30s).
        </p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
          {matches.map((f) => (
            <FaceTile
              key={f.detection_id}
              face={f}
              isAdmin={isAdmin}
              onChanged={refetch}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// PersonEmbeddingsPanel lists the rows in face_embeddings that define
// this person, with both a per-row delete and a bulk-outlier flow.
//
// Each tile carries a kNN-similarity badge: the mean cosine to the
// 3 most similar embeddings in this person's pool. Outliers (wrong
// person, or noise with no kin) score low; genuine pose/lighting
// variants stay healthy as long as they have similar siblings.
// Sorting by lowest nearest-neighbour + filtering below a threshold
// surfaces true outliers without punishing legitimate diversity.
function PersonEmbeddingsPanel({
  person,
  isAdmin,
}: {
  person: Person;
  isAdmin: boolean;
}) {
  const qc = useQueryClient();
  const { data: embeddings = [] } = useQuery({
    queryKey: ["person-embeddings", person.id],
    queryFn: () => api.listPersonEmbeddings(person.id),
  });
  const del = useMutation({
    mutationFn: (embeddingID: string) =>
      api.deletePersonEmbedding(person.id, embeddingID),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["person-embeddings", person.id] });
      qc.invalidateQueries({ queryKey: ["persons"] });
    },
  });
  const bulkDel = useMutation({
    mutationFn: (ids: string[]) =>
      api.bulkDeletePersonEmbeddings(person.id, ids),
    onSuccess: () => {
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ["person-embeddings", person.id] });
      qc.invalidateQueries({ queryKey: ["persons"] });
    },
  });

  const [sortMode, setSortMode] = useState<"newest" | "outliers">("newest");
  // Slider goes 0..1 in 0.05 steps; 1.0 means "no filter" (show all).
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
      <h3 className="text-md font-semibold mb-2 flex items-baseline gap-3 flex-wrap">
        Embeddings
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
              onChange={(e) =>
                setSortMode(e.target.value as "newest" | "outliers")
              }
            >
              <option value="newest">newest</option>
              <option value="outliers">lowest neighbour-sim</option>
            </select>
          </label>
          <label className="flex items-center gap-1" title="Filter to embeddings whose mean cosine to the rest of this person's pool is below this value.">
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
      </h3>
      {embeddings.length === 0 ? (
        <p className="text-neutral-500 text-sm">
          No embeddings — this person will never match.
        </p>
      ) : visible.length === 0 ? (
        <p className="text-neutral-500 text-sm">
          Nothing below that threshold.
        </p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3 pb-16">
          {visible.map((e) => (
            <EmbeddingTile
              key={e.id}
              e={e}
              isAdmin={isAdmin}
              checked={selected.has(e.id)}
              onToggle={() => toggle(e.id)}
              onDelete={() => {
                const remaining = embeddings.length - 1;
                const msg = remaining <= 0
                  ? `Delete the last embedding? ${person.label} will stop matching until you add more.`
                  : `Delete this embedding? ${remaining} will remain.`;
                if (confirm(msg)) del.mutate(e.id);
              }}
              deleting={del.isPending}
            />
          ))}
        </div>
      )}

      {isAdmin && selected.size > 0 && (
        <div className="sticky bottom-2 mt-4 bg-neutral-900/95 border border-neutral-700 rounded p-2 text-sm flex items-center gap-3 shadow-lg">
          <span className="tabular-nums">{selected.size} selected</span>
          <button
            className="text-neutral-400 hover:underline text-xs"
            onClick={() => setSelected(new Set())}
          >
            clear
          </button>
          <button
            className="ml-auto bg-red-600 hover:bg-red-500 rounded px-3 py-1 text-xs disabled:opacity-50"
            disabled={bulkDel.isPending}
            onClick={() => {
              const n = selected.size;
              const remaining = embeddings.length - n;
              const msg =
                remaining <= 0
                  ? `Delete all ${n} remaining embeddings? ${person.label} will stop matching.`
                  : `Delete ${n} embedding${n === 1 ? "" : "s"}? ${remaining} will remain.`;
              if (confirm(msg)) bulkDel.mutate(Array.from(selected));
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
  e: {
    id: string;
    source: string;
    created_at: string;
    detection_id?: number;
    nearest_neighbour_similarity: number;
  };
  isAdmin: boolean;
  checked: boolean;
  onToggle: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  // The badge shows each embedding's mean cosine to its 3 nearest
  // neighbours in the pool — a proxy for "does this embedding belong
  // with the others?" without penalising legitimate pose/lighting
  // variants. Colour floors calibrated against observed embedding
  // data: an outlier stranger scores <0.35; a real-person variant
  // with similar siblings lands ≥0.50 even across pose changes.
  // Pools with fewer than 2 embeddings have no neighbours to compare
  // against — show grey instead of red.
  const sim = e.nearest_neighbour_similarity;
  const tone =
    sim === 0
      ? "bg-neutral-900/80 text-neutral-400"
      : sim < 0.35
      ? "bg-red-900/80 text-red-200"
      : sim < 0.5
      ? "bg-amber-900/80 text-amber-200"
      : "bg-emerald-900/80 text-emerald-200";
  return (
    <div
      className={`border rounded overflow-hidden ${
        checked ? "border-blue-500" : "border-neutral-800"
      }`}
    >
      <div className="aspect-square bg-neutral-900 flex items-center justify-center overflow-hidden relative">
        {e.detection_id ? (
          <img
            src={`/api/v1/faces/thumbnail/${e.detection_id}.jpg`}
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
            "Low = this embedding is an outlier (wrong person or heavy noise). " +
            "Pool-wide diversity is expected and healthy — don't curate away legitimate pose/lighting variants."
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

function RecentFacesGrid({ isAdmin }: { isAdmin: boolean }) {
  const [onlyUnmatched, setOnlyUnmatched] = useState(true);
  const [groupSimilar, setGroupSimilar] = useState(true);
  const { data: recent = [], refetch } = useQuery({
    queryKey: ["recent-faces", onlyUnmatched, groupSimilar],
    queryFn: () =>
      api.recentFaces({
        hours: 24,
        limit: 60,
        unmatched: onlyUnmatched,
        collapse: groupSimilar,
      }),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });

  return (
    <section>
      <h2 className="text-lg font-semibold mb-2 flex items-baseline gap-3 flex-wrap">
        Recent faces
        <label className="text-xs font-normal inline-flex items-center gap-1 text-neutral-400">
          <input
            type="checkbox"
            checked={onlyUnmatched}
            onChange={(e) => setOnlyUnmatched(e.target.checked)}
          />
          only unmatched
        </label>
        <label className="text-xs font-normal inline-flex items-center gap-1 text-neutral-400">
          <input
            type="checkbox"
            checked={groupSimilar}
            onChange={(e) => setGroupSimilar(e.target.checked)}
          />
          group similar
        </label>
      </h2>
      <p className="text-sm text-neutral-500 mb-3">
        Click an unmatched face to enrol them. "Not a face" marks the
        thumbnail as a false positive so similar detections get
        penalised at match time. Thumbnails are cropped from the
        nearest live snapshot and only available for the last ~10
        minutes of detections.
      </p>
      {recent.length === 0 ? (
        <p className="text-neutral-500 text-sm">No face detections yet. Enable face ID in Settings.</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
          {recent.map((f) => (
            <FaceTile key={f.detection_id} face={f} isAdmin={isAdmin} onChanged={refetch} />
          ))}
        </div>
      )}
    </section>
  );
}

function FaceTile({
  face,
  isAdmin,
  onChanged,
}: {
  face: RecentFace;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const { data: persons = [] } = useQuery({ queryKey: ["persons"], queryFn: api.listPersons });
  const [showEnrol, setShowEnrol] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [pickId, setPickId] = useState("");

  // dismissAllAs submits representative + all cluster members to
  // /faces/dismiss with the given reason. 'not_a_face' / 'duplicate'
  // feed the matcher's negative-penalty scorer; 'deleted' /
  // 'enrolled' are UI-only hides.
  const dismissAllAs = async (
    reason: "not_a_face" | "duplicate" | "deleted" | "enrolled",
  ) => {
    if (!face.vector) return;
    const items: Array<{
      detection_id: number;
      vector: number[];
      reason: "not_a_face" | "duplicate" | "deleted" | "enrolled";
    }> = [{
      detection_id: face.detection_id,
      vector: face.vector,
      reason,
    }];
    if (face.member_vectors && face.members) {
      face.member_vectors.forEach((v, i) => {
        items.push({
          detection_id: face.members![i],
          vector: v,
          reason,
        });
      });
    }
    await api.dismissFaces(items);
  };

  // Enrol the representative + all cluster members in one shot, then
  // dismiss the tile(s) with reason=enrolled so the grid removes
  // them immediately (without needing to wait for the matcher's next
  // 30s reload to flip them from unmatched → matched).
  const enrol = useMutation({
    mutationFn: async () => {
      if (!face.vector) throw new Error("no embedding on this detection");
      let personID = pickId;
      if (!personID) {
        if (!newLabel.trim()) throw new Error("name required");
        const p = await api.createPerson({ label: newLabel.trim(), alert_on_match: false });
        personID = p.id;
      }
      const vectors: Array<{ vector: number[]; source: string; detection_id?: number }> = [
        {
          vector: face.vector,
          source: `enrol-live-${face.detection_id}`,
          detection_id: face.detection_id,
        },
      ];
      if (face.member_vectors && face.members) {
        face.member_vectors.forEach((v, i) => {
          vectors.push({
            vector: v,
            source: `enrol-cluster-${face.members![i]}`,
            detection_id: face.members![i],
          });
        });
      }
      await api.addPersonEmbeddingsBulk(personID, vectors);
      // Best-effort post-save autohide. If this fails the tile will
      // stick around one extra refetch cycle but the enrolment itself
      // has already committed.
      try { await dismissAllAs("enrolled"); } catch (_) { /* ignore */ }
    },
    onSuccess: () => {
      setShowEnrol(false);
      setNewLabel("");
      setPickId("");
      qc.invalidateQueries({ queryKey: ["persons"] });
      onChanged();
    },
  });

  // "Not a face" — flag the tile + cluster as a false positive so
  // the matcher penalises similar future detections at scoring time.
  const dismiss = useMutation({
    mutationFn: async () => {
      if (!face.vector) throw new Error("no embedding on this row");
      await dismissAllAs("not_a_face");
    },
    onSuccess: onChanged,
  });

  // "Delete" — plain UI hide. No training signal; the matcher keeps
  // behaving as before. Useful for removing redundant or ugly crops
  // from the review grid without mislabelling them as false positives.
  const del = useMutation({
    mutationFn: async () => {
      if (!face.vector) throw new Error("no embedding on this row");
      await dismissAllAs("deleted");
    },
    onSuccess: onChanged,
  });

  const matched = !!face.person;
  const count = face.count && face.count > 1 ? face.count : 0;
  return (
    <div className={`border rounded overflow-hidden relative ${matched ? "border-emerald-700" : "border-neutral-800"}`}>
      {count > 0 && (
        <span
          className="absolute top-1 right-1 bg-neutral-900/80 text-neutral-200 text-[10px] font-medium px-1.5 py-0.5 rounded"
          title={`${count} near-duplicate detections`}
        >
          ×{count}
        </span>
      )}
      <div className="aspect-square bg-neutral-900 flex items-center justify-center overflow-hidden">
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
      </div>
      <div className="p-2 text-xs">
        {matched ? (
          <div className="text-emerald-400 font-medium truncate">
            {face.person} · {(face.similarity! * 100).toFixed(0)}%
          </div>
        ) : (
          <div className="text-amber-400 font-medium">unmatched</div>
        )}
        <div className="text-neutral-500 truncate">
          {face.camera_id} · {new Date(face.ts).toLocaleTimeString()}
        </div>
        {isAdmin && face.vector && (
          <>
            {!showEnrol ? (
              <div className="mt-1 flex gap-2 flex-wrap">
                <button
                  className="text-blue-400 hover:underline"
                  onClick={() => setShowEnrol(true)}
                  title={
                    matched
                      ? "Move this detection's embedding to a different (or new) person"
                      : "Enrol this detection against a person"
                  }
                >
                  {matched ? "reassign…" : "enrol…"}
                </button>
                <button
                  className="text-red-400 hover:underline disabled:opacity-50"
                  disabled={dismiss.isPending}
                  title="False positive — also penalise similar future detections"
                  onClick={() => {
                    if (confirm(count > 0
                      ? `Mark all ${count + 1} detections as "not a face"?`
                      : `Mark this as "not a face"?`)) {
                      dismiss.mutate();
                    }
                  }}
                >
                  {dismiss.isPending ? "…" : "not a face"}
                </button>
                <button
                  className="text-neutral-400 hover:text-neutral-200 hover:underline disabled:opacity-50"
                  disabled={del.isPending}
                  title="Hide from grid — no training impact"
                  onClick={() => del.mutate()}
                >
                  {del.isPending ? "…" : "delete"}
                </button>
              </div>
            ) : (
              <div className="mt-1 space-y-1">
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
                <div className="flex gap-1">
                  <button
                    className="flex-1 bg-blue-600 hover:bg-blue-500 rounded px-1 py-0.5 disabled:opacity-50"
                    disabled={enrol.isPending || (!pickId && !newLabel.trim())}
                    onClick={() => enrol.mutate()}
                  >
                    {enrol.isPending
                      ? "saving…"
                      : count > 0
                        ? `save (×${count + 1})`
                        : "save"}
                  </button>
                  <button
                    className="text-neutral-400"
                    onClick={() => setShowEnrol(false)}
                  >
                    cancel
                  </button>
                </div>
                {enrol.isError && (
                  <div className="text-red-400">
                    {String((enrol.error as Error)?.message ?? "failed")}
                  </div>
                )}
                {dismiss.isError && (
                  <div className="text-red-400">
                    {String((dismiss.error as Error)?.message ?? "failed")}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Persons({
  isAdmin,
  onSelect,
}: {
  isAdmin: boolean;
  onSelect: (p: Person) => void;
}) {
  const qc = useQueryClient();
  const { data: persons = [] } = useQuery({ queryKey: ["persons"], queryFn: api.listPersons });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["persons"] });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<Person> }) =>
      api.updatePerson(id, body),
    onSuccess: invalidate,
  });
  // Erasure returns a report; surface the counts in an ephemeral
  // message so the operator sees the scope of what was removed.
  const [lastErasure, setLastErasure] = useState<string | null>(null);
  const erase = useMutation({
    mutationFn: api.deletePerson,
    onSuccess: (report) => {
      invalidate();
      setLastErasure(
        `Erased ${report.label}: ${report.embeddings_removed} embedding(s), ` +
        `${report.detections_nulled} detection row(s) anonymised, ` +
        `${report.thumbs_removed} thumbnail(s) removed.`
      );
    },
  });
  const [showUpload, setShowUpload] = useState(false);

  return (
    <section>
      <div className="flex items-baseline gap-3 mb-2">
        <h2 className="text-lg font-semibold">Persons</h2>
        {isAdmin && (
          <button
            className="text-blue-400 hover:underline text-sm"
            onClick={() => setShowUpload(true)}
            title="Enrol a person from a photo upload (no live feed needed)"
          >
            upload photo to enrol…
          </button>
        )}
      </div>
      {lastErasure && (
        <div className="mb-3 text-xs bg-red-950/40 border border-red-900 rounded p-2 text-red-200">
          {lastErasure}{" "}
          <button
            className="text-red-300 hover:underline ml-2"
            onClick={() => setLastErasure(null)}
          >
            dismiss
          </button>
        </div>
      )}
      {showUpload && (
        <UploadEnrolModal
          persons={persons}
          onClose={() => setShowUpload(false)}
          onEnrolled={() => {
            setShowUpload(false);
            invalidate();
          }}
        />
      )}
      {persons.length === 0 ? (
        <p className="text-neutral-500 text-sm">
          No enrolled persons. Enrol someone from the Recent faces grid above,
          {isAdmin && " or upload a photo via the button above,"}
          {" "}or cluster members in the Clusters panel.
        </p>
      ) : (
        <ul className="divide-y divide-neutral-800 rounded border border-neutral-800 text-sm">
          {persons.map((p) => (
            <li
              key={p.id}
              className={`p-2 grid grid-cols-[1fr_auto_auto_auto] gap-3 items-center ${!p.enabled ? "opacity-50" : ""}`}
            >
              <div>
                <button
                  className="font-medium text-left hover:underline text-blue-300"
                  onClick={() => onSelect(p)}
                  title="Show recent matches for this person"
                >
                  {p.label}
                </button>
                <div className="text-xs text-neutral-500">
                  {p.embedding_count} embedding{p.embedding_count === 1 ? "" : "s"}
                  {p.notes && ` · ${p.notes}`}
                </div>
              </div>
              {isAdmin && (
                <>
                  <label className="inline-flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={p.alert_on_match}
                      onChange={(e) =>
                        update.mutate({ id: p.id, body: { alert_on_match: e.target.checked } })
                      }
                    />
                    alert
                  </label>
                  <button
                    className={p.enabled ? "text-amber-400 hover:underline" : "text-emerald-400 hover:underline"}
                    onClick={() => update.mutate({ id: p.id, body: { enabled: !p.enabled } })}
                  >
                    {p.enabled ? "disable" : "enable"}
                  </button>
                  <button
                    className="text-red-400 hover:underline"
                    onClick={() => {
                      const msg =
                        `Erase ${p.label}?\n\n` +
                        `This removes their enrolment, training samples, ` +
                        `cached thumbnails, and clears identity labels on ` +
                        `past detections. Recordings are not touched and ` +
                        `age out via retention. This cannot be undone.`;
                      if (confirm(msg)) erase.mutate(p.id);
                    }}
                  >
                    erase
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

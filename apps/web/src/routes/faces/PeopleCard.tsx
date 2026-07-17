import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, faceThumbUrl, Person } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";

// Enrolled people as cards: avatar, inline rename (finally), toggles,
// GDPR erasure. Click a card to open the detail dialog.
export function PeopleCard({
  isAdmin,
  onOpen,
  onUpload,
}: {
  isAdmin: boolean;
  onOpen: (p: Person) => void;
  onUpload: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { data: persons = [], isLoading } = useQuery({
    queryKey: ["persons"],
    queryFn: api.listPersons,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["persons"] });

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<Person> }) =>
      api.updatePerson(id, body),
    onSuccess: (_, vars) => {
      invalidate();
      if (vars.body.label) toast.success("Renamed");
    },
    onError: (e) => toast.error(String((e as Error)?.message ?? "update failed")),
  });
  const erase = useMutation({
    mutationFn: api.deletePerson,
    onSuccess: (report) => {
      invalidate();
      toast.success(
        `Erased ${report.label}: ${report.embeddings_removed} embeddings, ` +
          `${report.detections_nulled} detections anonymised, ` +
          `${report.thumbs_removed} thumbnails removed`,
      );
    },
    onError: (e) => toast.error(String((e as Error)?.message ?? "erasure failed")),
  });

  return (
    <Card
      title="People"
      description="Enrolled identities. Matching applies within ~30 seconds of any change."
      headerRight={
        isAdmin ? (
          <button
            className="rounded border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:text-white whitespace-nowrap"
            onClick={onUpload}
            title="Enrol a person from a photo upload (no live feed needed)"
          >
            Upload photo to enrol
          </button>
        ) : undefined
      }
    >
      {isLoading ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="h-20 rounded-lg bg-neutral-900 animate-pulse" />
          ))}
        </div>
      ) : persons.length === 0 ? (
        <p className="text-neutral-500 text-sm">
          No enrolled people yet. Enrol someone from the review queue above
          {isAdmin && ", or upload a photo"}.
        </p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
          {persons.map((p) => (
            <PersonCard
              key={p.id}
              person={p}
              isAdmin={isAdmin}
              onOpen={() => onOpen(p)}
              onRename={(label) => update.mutate({ id: p.id, body: { label } })}
              onToggleAlert={(v) => update.mutate({ id: p.id, body: { alert_on_match: v } })}
              onToggleEnabled={() => update.mutate({ id: p.id, body: { enabled: !p.enabled } })}
              onErase={async () => {
                const ok = await confirm({
                  title: `Erase ${p.label}?`,
                  body: "Removes their enrolment, training samples, cached thumbnails, and clears identity labels on past detections. Recordings are not touched and age out via retention. This cannot be undone.",
                  confirmLabel: "Erase",
                  tone: "danger",
                });
                if (ok) erase.mutate(p.id);
              }}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

function PersonCard({
  person: p,
  isAdmin,
  onOpen,
  onRename,
  onToggleAlert,
  onToggleEnabled,
  onErase,
}: {
  person: Person;
  isAdmin: boolean;
  onOpen: () => void;
  onRename: (label: string) => void;
  onToggleAlert: (v: boolean) => void;
  onToggleEnabled: () => void;
  onErase: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(p.label);

  const commit = () => {
    setEditing(false);
    const v = draft.trim();
    if (v && v !== p.label) onRename(v);
    else setDraft(p.label);
  };

  return (
    <div
      className={`rounded-lg border border-neutral-800 bg-neutral-950 p-2.5 flex gap-3 ${
        !p.enabled ? "opacity-50" : ""
      }`}
    >
      <button
        className="w-16 h-16 rounded-lg overflow-hidden bg-neutral-900 shrink-0 flex items-center justify-center"
        onClick={onOpen}
        title="Open matches & training samples"
      >
        {p.thumb_detection_id ? (
          <img
            src={faceThumbUrl(p.thumb_detection_id)}
            alt=""
            className="w-full h-full object-cover"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        ) : (
          <span className="text-xl text-neutral-600 font-semibold">
            {p.label.slice(0, 1).toUpperCase()}
          </span>
        )}
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {editing ? (
            <input
              autoFocus
              className="bg-neutral-800 border border-neutral-700 rounded px-1.5 py-0.5 text-sm w-full"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") {
                  setDraft(p.label);
                  setEditing(false);
                }
              }}
            />
          ) : (
            <>
              <button
                className="font-medium text-sm truncate hover:underline text-left"
                onClick={onOpen}
              >
                {p.label}
              </button>
              {isAdmin && (
                <button
                  className="text-neutral-500 hover:text-neutral-200 text-xs"
                  title="Rename"
                  onClick={() => setEditing(true)}
                >
                  ✎
                </button>
              )}
            </>
          )}
        </div>
        <div className="text-xs text-neutral-500 truncate">
          {p.embedding_count} sample{p.embedding_count === 1 ? "" : "s"}
          {p.notes && ` · ${p.notes}`}
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2.5 mt-1 text-xs">
            <label className="inline-flex items-center gap-1 text-neutral-400">
              <input
                type="checkbox"
                checked={p.alert_on_match}
                onChange={(e) => onToggleAlert(e.target.checked)}
              />
              alert
            </label>
            <button
              className={p.enabled ? "text-amber-400 hover:underline" : "text-emerald-400 hover:underline"}
              onClick={onToggleEnabled}
            >
              {p.enabled ? "disable" : "enable"}
            </button>
            <button className="text-red-400 hover:underline" onClick={onErase}>
              erase
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

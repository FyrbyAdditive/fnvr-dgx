import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  bulkEnableClasses,
  createDetectionClass,
  deleteDetectionClass,
  DetectionClass,
} from "@/lib/api";
import { fetchDetectionClasses } from "@/lib/api";
import { CATEGORY_ORDER, classCategory } from "@/lib/classes";
import { Card } from "@/components/ui/Card";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import {
  applyMutes,
  ClassDraft,
  countChanges,
  emptyDraft,
  MuteBucket,
  taxonomyChanges,
  toggleMute,
  toggleTaxonomy,
} from "./classDraft";
import { useReportDirty } from "./dirty";

// One table for the two systems that used to fight each other from
// separate sections: the taxonomy (enabled = the class exists) and the
// mute buckets (muted = detections dropped globally / on indoor /
// outdoor cameras). Both converge into the same runtime mute sets and
// both need a pipeline restart to reach Live bounding boxes, so edits
// batch into ONE draft with ONE "Save & restart".

const BUCKETS: MuteBucket[] = ["global", "indoor", "outdoor"];

export function ClassesCard({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  const { data: classes = [], isLoading } = useQuery({
    queryKey: ["detection-classes"],
    queryFn: fetchDetectionClasses,
  });
  const { data: serverMutes } = useQuery({
    queryKey: ["class-mutes"],
    queryFn: api.getClassMutes,
  });

  const [draft, setDraft] = useState<ClassDraft>(emptyDraft());
  const changes = countChanges(draft);
  useReportDirty("classes", changes > 0);

  const [openCats, setOpenCats] = useState<Record<string, boolean>>({});

  // Group: Custom first (most relevant), then COCO categories.
  const buckets = useMemo(() => {
    const out: Record<string, DetectionClass[]> = { Custom: [] };
    for (const c of classes) {
      if (c.origin === "custom") out.Custom.push(c);
      else (out[classCategory(c.slug)] ??= []).push(c);
    }
    for (const k of Object.keys(out)) {
      out[k].sort((a, b) => a.display_name.localeCompare(b.display_name));
    }
    return out;
  }, [classes]);

  const serverMuted = (bucket: MuteBucket, slug: string) =>
    !!serverMutes && serverMutes[bucket].includes(slug);
  const effEnabled = (c: DetectionClass) => draft.taxonomy[c.id] ?? c.enabled;
  const effMuted = (bucket: MuteBucket, slug: string) =>
    draft.mutes[bucket][slug] ?? serverMuted(bucket, slug);

  const save = useMutation({
    mutationFn: async () => {
      const tax = taxonomyChanges(draft);
      const muteDirty = BUCKETS.some((b) => Object.keys(draft.mutes[b]).length > 0);
      if (tax.length > 0) {
        // Atomic server-side — either the whole taxonomy batch lands
        // or none of it.
        await bulkEnableClasses(tax);
      }
      if (muteDirty) {
        if (!serverMutes) throw new Error("class mutes not loaded");
        try {
          await api.updateClassMutes(applyMutes(serverMutes, draft));
        } catch (e) {
          // Taxonomy applied but mutes failed: keep only the mute
          // diffs so a retry Save is exactly the missing half.
          setDraft((d) => ({ ...emptyDraft(), mutes: d.mutes }));
          qc.invalidateQueries({ queryKey: ["detection-classes"] });
          throw new Error(
            `Class mutes failed to save — taxonomy changes were applied. Retry Save. (${(e as Error).message})`,
          );
        }
      }
      // One restart after both halves succeed, so probe-side mute sets
      // (which resolve at worker spawn) pick everything up at once.
      await api.restartPipeline();
    },
    onSuccess: () => {
      setDraft(emptyDraft());
      qc.invalidateQueries({ queryKey: ["detection-classes"] });
      qc.invalidateQueries({ queryKey: ["class-mutes"] });
      qc.invalidateQueries({ queryKey: ["pipeline-state"] });
      toast.success("Classes saved — pipeline restarting");
    },
    onError: (e) => toast.error(String((e as Error)?.message ?? "save failed")),
  });

  const doSave = async () => {
    const ok = await confirm({
      title: "Save and restart the pipeline?",
      body: `${changes} class change${changes === 1 ? "" : "s"} will apply. Recording and live view pause for roughly 10–30 seconds while workers respawn.`,
      confirmLabel: "Save & restart",
    });
    if (ok) save.mutate();
  };

  const create = useMutation({
    mutationFn: ({ slug, displayName }: { slug: string; displayName: string }) =>
      createDetectionClass(slug, displayName),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ["detection-classes"] });
      toast.success(`Added custom class "${c.display_name}"`);
    },
    onError: (e) => toast.error(String((e as Error)?.message ?? "create failed")),
  });
  const remove = useMutation({
    mutationFn: (id: number) => deleteDetectionClass(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["detection-classes"] });
      toast.success("Custom class deleted");
    },
    onError: (e) => toast.error(String((e as Error)?.message ?? "delete failed")),
  });

  const enabledCount = classes.filter((c) => effEnabled(c)).length;

  return (
    <Card
      title="Detection classes & mutes"
      description={
        <>
          Enabled = the class exists in the taxonomy: it can be detected, appears
          in the Live relabel picker, and is included in training datasets.
          Mute = detections of the class are dropped — globally, or only on
          cameras tagged indoor/outdoor. Changes apply after a pipeline restart.
        </>
      }
      headerRight={
        <Link to="/cameras" className="text-xs text-blue-400 hover:underline whitespace-nowrap">
          Per-camera overrides → Cameras
        </Link>
      }
    >
      <div className="text-xs text-neutral-500">
        {enabledCount} of {classes.length} classes enabled
        {serverMutes &&
          ` · muted: ${applyMutes(serverMutes, draft).global.length} global / ${
            applyMutes(serverMutes, draft).indoor.length
          } indoor / ${applyMutes(serverMutes, draft).outdoor.length} outdoor`}
      </div>

      {isAdmin && (
        <NewClassForm
          pending={create.isPending}
          onSubmit={(slug, name) => create.mutate({ slug, displayName: name })}
        />
      )}

      {isLoading && <div className="text-neutral-500 text-sm">loading…</div>}

      {!isLoading && serverMutes && (
        <div className="rounded border border-neutral-800 divide-y divide-neutral-800">
          <div className="grid grid-cols-[1fr_5rem_5rem_5rem_5rem] gap-2 items-center px-3 py-1 bg-neutral-900 text-xs text-neutral-500 uppercase sticky top-0 z-10">
            <span>Class</span>
            <span className="text-center">Enabled</span>
            <span className="text-center">Mute global</span>
            <span className="text-center">Mute indoor</span>
            <span className="text-center">Mute outdoor</span>
          </div>
          {(["Custom", ...CATEGORY_ORDER] as const).map((cat) => {
            const items = buckets[cat] ?? [];
            if (items.length === 0) return null;
            const open = !!openCats[cat];
            const en = items.filter((c) => effEnabled(c)).length;
            const muteCounts = BUCKETS.map(
              (b) => items.filter((c) => effMuted(b, c.slug)).length,
            );
            return (
              <div key={cat}>
                <button
                  className="w-full grid grid-cols-[1fr_5rem_5rem_5rem_5rem] gap-2 items-center px-3 py-1 text-left hover:bg-neutral-900"
                  onClick={() => setOpenCats((p) => ({ ...p, [cat]: !open }))}
                >
                  <span className="text-sm font-medium">
                    <span className="inline-block w-3">{open ? "▾" : "▸"}</span>
                    {cat}{" "}
                    <span className="text-neutral-500 font-normal">
                      {en}/{items.length} enabled
                    </span>
                  </span>
                  {muteCounts.map((n, i) => (
                    <span key={i} className="text-center text-xs text-neutral-500">
                      {n || ""}
                    </span>
                  ))}
                </button>
                {open &&
                  items.map((c) => {
                    const enabled = effEnabled(c);
                    return (
                      <div
                        key={c.id}
                        className="grid grid-cols-[1fr_5rem_5rem_5rem_5rem] gap-2 items-center px-3 py-1 text-sm group"
                      >
                        <span className={`pl-5 ${enabled ? "text-neutral-300" : "text-neutral-600"}`}>
                          {c.display_name}{" "}
                          <span className="text-[10px] text-neutral-600">#{c.yolo_id}</span>
                          {c.origin === "custom" && (
                            <>
                              <span className="ml-1 text-[10px] bg-neutral-800 text-neutral-400 rounded px-1">
                                custom
                              </span>
                              {isAdmin && (
                                <button
                                  className="opacity-0 group-hover:opacity-100 text-[10px] text-red-400 hover:text-red-300 ml-2"
                                  title="Delete custom class (only if no flagged samples)"
                                  onClick={async () => {
                                    const ok = await confirm({
                                      title: `Delete custom class "${c.display_name}"?`,
                                      body: "Only possible while it has no flagged samples.",
                                      confirmLabel: "Delete",
                                      tone: "danger",
                                    });
                                    if (ok) remove.mutate(c.id);
                                  }}
                                >
                                  delete
                                </button>
                              )}
                            </>
                          )}
                        </span>
                        <input
                          type="checkbox"
                          className="mx-auto accent-blue-500"
                          checked={enabled}
                          disabled={!isAdmin}
                          onChange={(e) =>
                            setDraft((d) => toggleTaxonomy(d, c.id, e.target.checked, c.enabled))
                          }
                        />
                        {BUCKETS.map((b) => (
                          <input
                            key={b}
                            type="checkbox"
                            className="mx-auto accent-amber-500"
                            checked={effMuted(b, c.slug)}
                            disabled={!isAdmin || !enabled}
                            title={!enabled ? "Class is disabled — mute is moot" : undefined}
                            onChange={(e) =>
                              setDraft((d) =>
                                toggleMute(d, b, c.slug, e.target.checked, serverMuted(b, c.slug)),
                              )
                            }
                          />
                        ))}
                      </div>
                    );
                  })}
              </div>
            );
          })}
        </div>
      )}

      {isAdmin && changes > 0 && (
        <div className="sticky bottom-0 bg-neutral-950/90 backdrop-blur rounded px-3 py-2 flex items-center gap-3 border border-neutral-800">
          <span className="text-xs text-amber-400">
            {changes} unsaved change{changes === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            className="text-sm px-3 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:text-white"
            onClick={() => setDraft(emptyDraft())}
            disabled={save.isPending}
          >
            Discard
          </button>
          <button
            type="button"
            className="text-sm px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50"
            onClick={doSave}
            disabled={save.isPending}
          >
            {save.isPending ? "Saving…" : "Save & restart pipeline"}
          </button>
        </div>
      )}
    </Card>
  );
}

function NewClassForm({
  pending,
  onSubmit,
}: {
  pending: boolean;
  onSubmit: (slug: string, displayName: string) => void;
}) {
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  return (
    <form
      className="flex items-center gap-2 flex-wrap text-xs bg-neutral-900/50 border border-neutral-800 rounded p-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!slug.trim()) return;
        onSubmit(slug.trim().toLowerCase(), displayName.trim() || slug.trim());
        setSlug("");
        setDisplayName("");
      }}
    >
      <span className="text-neutral-400">Add custom class</span>
      <input
        type="text"
        placeholder="slug (e.g. parcel)"
        className="bg-neutral-800 border border-neutral-700 rounded px-2 py-0.5 w-40"
        value={slug}
        onChange={(e) => setSlug(e.target.value)}
      />
      <input
        type="text"
        placeholder="display name (optional)"
        className="bg-neutral-800 border border-neutral-700 rounded px-2 py-0.5 w-48"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
      />
      <button
        type="submit"
        className="bg-blue-700 hover:bg-blue-600 px-2 py-0.5 rounded disabled:opacity-50"
        disabled={!slug.trim() || pending}
      >
        {pending ? "adding…" : "add"}
      </button>
    </form>
  );
}

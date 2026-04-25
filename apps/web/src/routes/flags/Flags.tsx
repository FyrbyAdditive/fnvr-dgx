import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fetchDetectionClasses, ObjectFlag, ObjectFlagStats } from "@/lib/api";
import { useMe } from "@/lib/me";

// Flags page. Surfaces everything the operator has ever flagged as a
// false-positive or relabelled on the Live feed. Each row is an entry
// in the suppression library AND a row in the YOLO-format dataset
// tree under /var/lib/fnvr/datasets/objects/.
//
// Admins can dismiss active flags (soft delete — removes from
// suppression, retains the dataset entry) or dismiss+purge (wipes the
// dataset files too). Viewers can read but not dismiss.
export function Flags() {
  const { data: me } = useMe();
  const isAdmin = !!me?.is_admin;

  const [showDismissed, setShowDismissed] = useState(false);
  const [filterClass, setFilterClass] = useState<string>("");
  const [filterCamera, setFilterCamera] = useState<string>("");

  const { data: cameras = [] } = useQuery({
    queryKey: ["cameras"],
    queryFn: api.listCameras,
  });
  const { data: stats } = useQuery<ObjectFlagStats>({
    queryKey: ["object-flag-stats"],
    queryFn: api.objectFlagStats,
    refetchInterval: 30_000,
  });
  const { data: flags = [], isLoading } = useQuery<ObjectFlag[]>({
    queryKey: ["object-flags", showDismissed, filterClass, filterCamera],
    queryFn: () =>
      api.listObjectFlags({
        dismissed: showDismissed,
        class_original: filterClass || undefined,
        camera_id: filterCamera || undefined,
        limit: 500,
      }),
  });

  const qc = useQueryClient();
  const dismiss = useMutation({
    mutationFn: ({ id, purge }: { id: number; purge: boolean }) =>
      api.dismissObjectFlag(id, purge),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["object-flags"] });
      qc.invalidateQueries({ queryKey: ["object-flag-stats"] });
    },
  });

  // Distinct class list for the filter dropdown — drawn from the
  // server's stats so dormant classes don't clutter. Falls back to
  // the full enabled-class list (from /admin/classes) when stats are
  // empty (fresh install with no flags yet).
  const distinctClasses = stats ? Object.keys(stats.by_class).sort() : [];
  const { data: allClasses = [] } = useQuery({
    queryKey: ["detection-classes"],
    queryFn: fetchDetectionClasses,
  });
  const fallbackClassSlugs = allClasses
    .filter((c) => c.enabled)
    .map((c) => c.slug);

  return (
    <div className="p-4 space-y-4 max-w-5xl">
      <header className="flex items-baseline gap-4 flex-wrap">
        <h2 className="text-lg font-semibold">Object flags</h2>
        {stats && (
          <span className="text-xs text-neutral-500">
            {stats.active} active · {stats.dismissed} dismissed · {stats.total} total
          </span>
        )}
      </header>
      <p className="text-sm text-neutral-400 max-w-2xl">
        Flags you created on the Live view. Active flags suppress visually
        similar future detections on the same camera + class, and land as
        rows in the on-disk YOLO-format dataset under{" "}
        <code>/var/lib/fnvr/datasets/objects/</code> so the data can train
        a future detector on a proper GPU.
      </p>

      <div className="flex items-center gap-3 flex-wrap text-xs">
        <label className="flex items-center gap-1">
          <span className="text-neutral-500">camera</span>
          <select
            className="bg-neutral-900 border border-neutral-700 rounded px-1 py-0.5"
            value={filterCamera}
            onChange={(e) => setFilterCamera(e.target.value)}
          >
            <option value="">(any)</option>
            {cameras.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-neutral-500">class</span>
          <select
            className="bg-neutral-900 border border-neutral-700 rounded px-1 py-0.5"
            value={filterClass}
            onChange={(e) => setFilterClass(e.target.value)}
          >
            <option value="">(any)</option>
            {(distinctClasses.length ? distinctClasses : fallbackClassSlugs).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            className="accent-blue-500"
            checked={showDismissed}
            onChange={(e) => setShowDismissed(e.target.checked)}
          />
          <span className="text-neutral-500">show dismissed</span>
        </label>
      </div>

      {isLoading ? (
        <div className="text-neutral-500 text-sm">Loading…</div>
      ) : flags.length === 0 ? (
        <div className="text-neutral-500 text-sm">
          No flags. Click a false-positive bounding box on the Live page to add
          one.
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
          {flags.map((f) => (
            <FlagTile
              key={f.id}
              flag={f}
              isAdmin={isAdmin}
              onDismiss={(purge) => dismiss.mutate({ id: f.id, purge })}
              busy={dismiss.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FlagTile({
  flag,
  isAdmin,
  onDismiss,
  busy,
}: {
  flag: ObjectFlag;
  isAdmin: boolean;
  onDismiss: (purge: boolean) => void;
  busy: boolean;
}) {
  const dismissed = !!flag.dismissed_at;
  return (
    <div
      className={`border rounded overflow-hidden ${
        dismissed ? "border-neutral-800 opacity-60" : "border-neutral-800"
      }`}
    >
      <div className="aspect-square bg-neutral-900 flex items-center justify-center overflow-hidden relative">
        <img
          src={`/api/v1/object-thumbnail/${flag.detection_id}.jpg`}
          alt=""
          className="w-full h-full object-cover"
          onError={(ev) => {
            (ev.target as HTMLImageElement).style.display = "none";
          }}
        />
        {dismissed && (
          <span className="absolute top-1 right-1 bg-neutral-950/80 text-neutral-400 text-[10px] px-1.5 py-0.5 rounded">
            dismissed
          </span>
        )}
      </div>
      <div className="p-2 text-xs space-y-1">
        <div>
          <span className="font-medium">{flag.class_original}</span>
          {flag.class_corrected ? (
            <span className="text-neutral-400"> → {flag.class_corrected}</span>
          ) : (
            <span className="text-red-400"> · not a {flag.class_original}</span>
          )}
        </div>
        <div className="text-neutral-500">
          {flag.camera_id} · {new Date(flag.ts).toLocaleString()}
        </div>
        <div className="text-neutral-600 text-[10px] truncate" title={flag.frame_path}>
          {flag.frame_path}
        </div>
        {isAdmin && !dismissed && (
          <div className="flex gap-2 pt-1">
            <button
              className="text-neutral-400 hover:text-neutral-200 disabled:opacity-50"
              disabled={busy}
              onClick={() => onDismiss(false)}
              title="Remove from suppression library but keep the dataset entry."
            >
              dismiss
            </button>
            <button
              className="text-red-400 hover:text-red-300 disabled:opacity-50"
              disabled={busy}
              onClick={() => {
                if (
                  confirm(
                    "Dismiss AND delete the dataset frame + label? This cannot be undone.",
                  )
                )
                  onDismiss(true);
              }}
              title="Dismiss and delete the on-disk training data."
            >
              dismiss + purge
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

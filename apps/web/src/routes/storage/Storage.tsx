import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, SystemStorage } from "@/lib/api";
import { useMe } from "@/lib/me";

// Storage dashboard. One-shot read of /api/v1/system/storage gives
// everything the page needs: disk free/total, the emergency purge
// floor, and per-camera byte totals + derived headroom. Admins get
// inline retention/quota editors; viewers see numbers only.
//
// Poll cadence matches the clusters panel (15 s) — per-camera totals
// only move meaningfully on storage-manager's 30 s tick, so this is
// already generous.
export function Storage() {
  const { data: me } = useMe();
  const isAdmin = !!me?.is_admin;
  const { data, isLoading } = useQuery({
    queryKey: ["storage"],
    queryFn: api.systemStorage,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });

  if (isLoading || !data) {
    return <div className="p-4 text-neutral-500 text-sm">Loading storage stats…</div>;
  }

  const diskEmergency = data.disk.free_pct < data.min_free_pct;

  return (
    <div className="p-4 space-y-6 max-w-5xl">
      <section>
        <div className="flex items-baseline gap-3 mb-2 flex-wrap">
          <h2 className="text-lg font-semibold">Disk</h2>
          <span className="text-xs text-neutral-500">
            {data.disk.path}
          </span>
          {diskEmergency && (
            <span className="bg-red-950/60 border border-red-900 text-red-200 text-xs px-2 py-0.5 rounded">
              Emergency purge active
            </span>
          )}
        </div>
        <DiskGauge
          freeBytes={data.disk.free_bytes}
          totalBytes={data.disk.total_bytes}
          freePct={data.disk.free_pct}
          minFreePct={data.min_free_pct}
        />
        <div className="text-xs text-neutral-500 mt-1">
          Emergency purge floor: {data.min_free_pct.toFixed(1)}%
          {" · "}admin can tune via <code>settings.storage.min_free_pct</code>
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-2">Per-camera usage</h2>
        {data.cameras.length === 0 ? (
          <div className="text-neutral-500 text-sm">No cameras configured.</div>
        ) : (
          <div className="rounded border border-neutral-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-neutral-900 text-xs text-neutral-400">
                <tr>
                  <th className="text-left px-3 py-2">Camera</th>
                  <th className="text-right px-3 py-2">Used</th>
                  <th className="text-right px-3 py-2">GB / day</th>
                  <th className="text-right px-3 py-2">Headroom</th>
                  <th className="text-right px-3 py-2">Quota (GB)</th>
                  <th className="text-right px-3 py-2">Retention (days)</th>
                  {isAdmin && <th className="w-20" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800">
                {data.cameras.map((c) => (
                  <CameraRow key={c.id} camera={c} isAdmin={isAdmin} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function DiskGauge({
  freeBytes,
  totalBytes,
  freePct,
  minFreePct,
}: {
  freeBytes: number;
  totalBytes: number;
  freePct: number;
  minFreePct: number;
}) {
  const usedPct = Math.max(0, 100 - freePct);
  const dangerous = freePct < minFreePct;
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span>
          {formatBytes(freeBytes)} free of {formatBytes(totalBytes)}
        </span>
        <span className={dangerous ? "text-red-300" : "text-neutral-400"}>
          {freePct.toFixed(1)}% free
        </span>
      </div>
      <div className="h-2 w-full bg-neutral-900 rounded overflow-hidden mt-1 relative">
        <div
          className={`h-full ${dangerous ? "bg-red-600" : "bg-blue-600"}`}
          style={{ width: `${usedPct}%` }}
        />
        <div
          className="absolute top-0 bottom-0 border-r border-amber-500/70"
          style={{ left: `${Math.max(0, 100 - minFreePct)}%` }}
          title={`Emergency purge floor: ${minFreePct}%`}
        />
      </div>
    </div>
  );
}

function CameraRow({
  camera: c,
  isAdmin,
}: {
  camera: SystemStorage["cameras"][number];
  isAdmin: boolean;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [retention, setRetention] = useState(c.retention_days);
  const [quota, setQuota] = useState(c.quota_gb);
  const [err, setErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api.updateCameraStorage(c.id, {
        retention_days: retention,
        quota_gb: quota,
      }),
    onSuccess: () => {
      setEditing(false);
      setErr(null);
      qc.invalidateQueries({ queryKey: ["storage"] });
    },
    onError: (e) => setErr((e as Error).message),
  });

  // Row colouring: red when we're inside 5% of quota, amber when
  // headroom is shorter than the retention window (i.e. quota will
  // truncate history), green otherwise. `days_of_headroom` is null on
  // brand-new cameras with no segments yet — those render neutral.
  const quotaRatio = c.quota_gb > 0 ? bytesToGB(c.bytes_used) / c.quota_gb : 0;
  let tone = "";
  if (quotaRatio >= 0.95) {
    tone = "bg-red-950/30";
  } else if (
    c.days_of_headroom !== null &&
    c.days_of_headroom < c.retention_days
  ) {
    tone = "bg-amber-950/30";
  }

  return (
    <>
      <tr className={tone}>
        <td className="px-3 py-2">
          <div className="font-medium">{c.name}</div>
          <div className="text-xs text-neutral-500">{c.id}</div>
        </td>
        <td className="px-3 py-2 text-right tabular-nums">
          {formatBytes(c.bytes_used)}
          <div className="text-xs text-neutral-500">{c.segment_count} segs</div>
        </td>
        <td className="px-3 py-2 text-right tabular-nums">
          {c.gb_per_day.toFixed(1)}
        </td>
        <td className="px-3 py-2 text-right tabular-nums">
          {c.days_of_headroom === null ? (
            <span className="text-neutral-600">—</span>
          ) : (
            <>{c.days_of_headroom.toFixed(1)}d</>
          )}
        </td>
        <td className="px-3 py-2 text-right tabular-nums">{c.quota_gb}</td>
        <td className="px-3 py-2 text-right tabular-nums">{c.retention_days}</td>
        {isAdmin && (
          <td className="px-3 py-2 text-right">
            {!editing && (
              <button
                className="text-blue-400 hover:underline text-xs"
                onClick={() => {
                  setRetention(c.retention_days);
                  setQuota(c.quota_gb);
                  setEditing(true);
                }}
              >
                edit
              </button>
            )}
          </td>
        )}
      </tr>
      {editing && isAdmin && (
        <tr className="bg-neutral-900/60">
          <td colSpan={7} className="px-3 py-2">
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <label className="text-neutral-400">
                Retention (days):{" "}
                <input
                  type="number"
                  min={1}
                  max={3650}
                  value={retention}
                  onChange={(e) => setRetention(Number(e.target.value))}
                  className="bg-neutral-900 border border-neutral-700 rounded px-2 py-0.5 w-20"
                />
              </label>
              <label className="text-neutral-400">
                Quota (GB):{" "}
                <input
                  type="number"
                  min={1}
                  max={10000}
                  value={quota}
                  onChange={(e) => setQuota(Number(e.target.value))}
                  className="bg-neutral-900 border border-neutral-700 rounded px-2 py-0.5 w-24"
                />
              </label>
              <button
                className="bg-blue-600 hover:bg-blue-500 rounded px-3 py-0.5 text-xs disabled:opacity-50"
                disabled={save.isPending}
                onClick={() => save.mutate()}
              >
                {save.isPending ? "saving…" : "save"}
              </button>
              <button
                className="text-neutral-400 hover:underline"
                onClick={() => {
                  setEditing(false);
                  setErr(null);
                }}
              >
                cancel
              </button>
              {err && <span className="text-red-400">{err}</span>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

function bytesToGB(n: number): number {
  return n / (1024 * 1024 * 1024);
}

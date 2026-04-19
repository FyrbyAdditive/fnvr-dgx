import { FormEvent, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api, HistoricDetection, HotlistEntry, RecentPlate } from "@/lib/api";
import { useMe } from "@/lib/me";

// Plates tab: search, hotlist, recent. All three panels stack on one
// page because they share context — a recent hit seeds the search;
// hotlist entries are visually adjacent to the search results that
// would trigger them.
export function Plates() {
  const { data: me } = useMe();
  const isAdmin = !!me?.is_admin;
  const { data: cameras = [] } = useQuery({
    queryKey: ["cameras"],
    queryFn: api.listCameras,
  });
  const [pattern, setPattern] = useState("");
  const [cameraId, setCameraId] = useState("");
  const [since, setSince] = useState<"1h" | "24h" | "7d">("24h");
  const [triggered, setTriggered] = useState(0);
  const navigate = useNavigate();

  const range = useMemo(() => {
    const to = new Date();
    const from = new Date(to);
    if (since === "1h") from.setHours(to.getHours() - 1);
    else if (since === "24h") from.setDate(to.getDate() - 1);
    else from.setDate(to.getDate() - 7);
    return { from, to };
  }, [since]);

  const search = useQuery({
    queryKey: ["plate-search", pattern, cameraId, since, triggered],
    queryFn: () =>
      api.listDetectionsHistoric({
        cameraId: cameraId || undefined,
        kind: "anpr",
        plate: pattern || undefined,
        from: range.from,
        to: range.to,
        limit: 500,
      }),
    enabled: triggered > 0,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTriggered((t) => t + 1);
  };

  const openTimeline = (d: HistoricDetection) =>
    navigate(
      `/timeline?camera=${encodeURIComponent(d.camera_id)}&ts=${encodeURIComponent(d.ts)}`,
    );

  return (
    <div className="p-4 space-y-6 max-w-4xl">
      <section>
        <h2 className="text-lg font-semibold mb-2">Search plates</h2>
        <form onSubmit={submit} className="grid grid-cols-[1fr_10rem_6rem_auto] gap-2 text-sm">
          <input
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 font-mono uppercase"
            placeholder="AB12, AB12%, or %12C%"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
          />
          <select
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
            value={cameraId}
            onChange={(e) => setCameraId(e.target.value)}
          >
            <option value="">all cameras</option>
            {cameras.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <select
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
            value={since}
            onChange={(e) => setSince(e.target.value as "1h" | "24h" | "7d")}
          >
            <option value="1h">last 1h</option>
            <option value="24h">last 24h</option>
            <option value="7d">last 7d</option>
          </select>
          <button
            type="submit"
            className="bg-blue-600 hover:bg-blue-500 rounded px-3 py-1 disabled:opacity-50"
            disabled={search.isFetching}
          >
            {search.isFetching ? "searching…" : "search"}
          </button>
        </form>

        {triggered > 0 && (
          <div className="mt-3">
            {search.data && search.data.length === 0 ? (
              <p className="text-neutral-500 text-sm">No matches in the selected window.</p>
            ) : (
              <ul className="divide-y divide-neutral-800 rounded border border-neutral-800 text-sm max-h-[30vh] overflow-auto">
                {search.data?.map((d) => (
                  <li key={d.id} className="p-2 grid grid-cols-[10rem_1fr_auto] gap-2 items-center">
                    <span className="text-neutral-500 tabular-nums">
                      {new Date(d.ts).toLocaleString()}
                    </span>
                    <span>
                      <span className="font-mono font-semibold text-emerald-300">
                        {d.attributes?.plate ?? "—"}
                      </span>
                      <span className="text-neutral-500">
                        {" · "}{d.camera_id}
                        {d.attributes?.parent_class && ` · ${d.attributes.parent_class}`}
                        {" · "}{(d.confidence * 100).toFixed(0)}%
                      </span>
                    </span>
                    <button
                      className="text-xs text-blue-400 hover:underline"
                      onClick={() => openTimeline(d)}
                      title="Open the recording at this moment"
                    >
                      ▸ timeline
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <Hotlist isAdmin={isAdmin} />

      <Recent onPick={(p) => { setPattern(p); setTriggered((t) => t + 1); }} />
    </div>
  );
}

// Hotlist — admin-gated CRUD. Non-admins see the list read-only so
// they can verify coverage.
function Hotlist({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const { data: entries = [] } = useQuery({
    queryKey: ["hotlist"],
    queryFn: api.listHotlist,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["hotlist"] });
  const create = useMutation({ mutationFn: api.createHotlist, onSuccess: invalidate });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<HotlistEntry> }) =>
      api.updateHotlist(id, body),
    onSuccess: invalidate,
  });
  const del = useMutation({ mutationFn: api.deleteHotlist, onSuccess: invalidate });

  const [pattern, setPattern] = useState("");
  const [label, setLabel] = useState("");
  const [severity, setSeverity] = useState<HotlistEntry["severity"]>("warning");
  const [notes, setNotes] = useState("");

  const add = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(
      { pattern, label, severity, notes, enabled: true },
      {
        onSuccess: () => { setPattern(""); setLabel(""); setNotes(""); },
      },
    );
  };

  return (
    <section>
      <h2 className="text-lg font-semibold mb-2">Hotlist</h2>
      <p className="text-sm text-neutral-500 mb-3">
        A matching plate fires an incident (rule-less) — notification
        channels and the Home Assistant bridge pick it up automatically.
        Patterns support "AB12" (exact), "AB12%" (prefix), "%12C%"
        (contains). Case / spaces / hyphens are ignored.
      </p>

      {isAdmin && (
        <form onSubmit={add} className="grid grid-cols-[8rem_1fr_7rem_1fr_auto] gap-2 text-sm mb-3">
          <input
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 font-mono uppercase"
            placeholder="pattern"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            required
          />
          <input
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
            placeholder="label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            required
          />
          <select
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
            value={severity}
            onChange={(e) => setSeverity(e.target.value as HotlistEntry["severity"])}
          >
            <option value="info">info</option>
            <option value="warning">warning</option>
            <option value="critical">critical</option>
          </select>
          <input
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
            placeholder="notes (optional)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          <button
            type="submit"
            className="bg-blue-600 hover:bg-blue-500 rounded px-3 py-1 disabled:opacity-50"
            disabled={create.isPending}
          >
            {create.isPending ? "adding…" : "add"}
          </button>
        </form>
      )}

      {entries.length === 0 ? (
        <p className="text-neutral-500 text-sm">No hotlist entries.</p>
      ) : (
        <ul className="divide-y divide-neutral-800 rounded border border-neutral-800 text-sm">
          {entries.map((h) => (
            <li key={h.id} className={`p-2 grid grid-cols-[10rem_1fr_auto] gap-2 items-center ${!h.enabled ? "opacity-50" : ""}`}>
              <span className="font-mono font-semibold">{h.pattern}</span>
              <span>
                <span className="font-medium">{h.label}</span>
                <span className="text-neutral-500"> · {h.severity}</span>
                {h.notes && <span className="text-neutral-500"> · {h.notes}</span>}
              </span>
              {isAdmin && (
                <div className="flex items-center gap-3 text-xs">
                  <button
                    className={h.enabled ? "text-amber-400 hover:underline" : "text-emerald-400 hover:underline"}
                    onClick={() => update.mutate({ id: h.id, body: { enabled: !h.enabled, pattern: h.pattern, label: h.label, severity: h.severity, notes: h.notes ?? "" } })}
                  >
                    {h.enabled ? "disable" : "enable"}
                  </button>
                  <button
                    className="text-red-400 hover:underline"
                    onClick={() => { if (confirm(`delete hotlist entry "${h.pattern}"?`)) del.mutate(h.id); }}
                  >
                    delete
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// Recent plates — deduped last-seen view. Click a row to seed the
// search input.
function Recent({ onPick }: { onPick: (plate: string) => void }) {
  const { data: recent = [] } = useQuery({
    queryKey: ["recent-plates"],
    queryFn: () => api.recentPlates({ hours: 24, limit: 50 }),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });

  return (
    <section>
      <h2 className="text-lg font-semibold mb-2">Recently seen · last 24h</h2>
      {recent.length === 0 ? (
        <p className="text-neutral-500 text-sm">No plates read in the last 24h.</p>
      ) : (
        <ul className="divide-y divide-neutral-800 rounded border border-neutral-800 text-sm max-h-[40vh] overflow-auto">
          {recent.map((r: RecentPlate) => (
            <li key={r.plate} className="p-2 grid grid-cols-[10rem_1fr_6rem_auto] gap-2 items-center">
              <button
                className="font-mono font-semibold text-left text-emerald-300 hover:underline"
                onClick={() => onPick(r.plate)}
                title="Search this plate"
              >
                {r.plate}
              </button>
              <span className="text-neutral-500">
                {r.last_camera} · last seen {new Date(r.last_seen).toLocaleString()}
              </span>
              <span className="text-right tabular-nums text-neutral-400">
                ×{r.count}
              </span>
              <span />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

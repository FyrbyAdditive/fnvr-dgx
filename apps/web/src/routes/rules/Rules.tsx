import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, Camera, NotificationChannel, NotificationSubscription, Rule, Zone } from "@/lib/api";
import { useMe } from "@/lib/me";

export function Rules() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const isAdmin = !!me?.is_admin;
  const { data: rules = [] } = useQuery({ queryKey: ["rules"], queryFn: api.listRules });
  const { data: zones = [] } = useQuery({ queryKey: ["zones"], queryFn: () => api.listZones() });
  const { data: cameras = [] } = useQuery({ queryKey: ["cameras"], queryFn: api.listCameras });
  const { data: channels = [] } = useQuery({ queryKey: ["channels"], queryFn: api.listChannels });
  const { data: subscriptions = [] } = useQuery({
    queryKey: ["subscriptions"],
    queryFn: () => api.listSubscriptions(),
  });

  const invalidateRules = () => qc.invalidateQueries({ queryKey: ["rules"] });
  const createRule = useMutation({ mutationFn: api.createRule, onSuccess: invalidateRules });
  const deleteRule = useMutation({ mutationFn: api.deleteRule, onSuccess: invalidateRules });
  const toggleRule = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      enabled ? api.disableRule(id) : api.enableRule(id),
    onSuccess: invalidateRules,
  });

  return (
    <div className="p-4 space-y-6 max-w-3xl">
      {isAdmin && (
        <section>
          <h2 className="text-lg font-semibold mb-2">New rule</h2>
          <RuleForm
            cameras={cameras}
            zones={zones}
            submitLabel="Add rule"
            pendingLabel="Adding…"
            onSubmit={(body) =>
              new Promise<void>((resolve, reject) => {
                createRule.mutate(body, {
                  onSuccess: () => resolve(),
                  onError: (e) => reject(e),
                });
              })
            }
            resetAfterSubmit
          />
        </section>
      )}

      <section>
        <h2 className="text-lg font-semibold mb-2">Rules ({rules.length})</h2>
        {rules.length === 0 ? (
          <div className="text-neutral-500 text-sm">None yet.</div>
        ) : (
          <ul className="divide-y divide-neutral-800 rounded border border-neutral-800">
            {rules.map((r) => (
              <RuleRow
                key={r.id}
                rule={r}
                cameras={cameras}
                zones={zones}
                channels={channels}
                subscriptions={subscriptions.filter((s) => s.rule_id === r.id)}
                isAdmin={isAdmin}
                onToggle={() => toggleRule.mutate({ id: r.id, enabled: r.enabled })}
                onDelete={() => deleteRule.mutate(r.id)}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// RuleForm backs both the "New rule" creator and the per-row edit UI.
// onSubmit receives a partial `{name, enabled, definition}` in create
// mode or `{name, definition}` in edit mode — the caller decides which
// mutation to run. Returning a rejected promise surfaces the error in
// the form.
type FormSubmitBody = {
  name: string;
  enabled: boolean;
  definition: Rule["definition"];
};

function RuleForm({
  cameras,
  zones,
  initial,
  submitLabel,
  pendingLabel,
  onSubmit,
  onCancel,
  resetAfterSubmit,
}: {
  cameras: Camera[];
  zones: Zone[];
  initial?: Rule;
  submitLabel: string;
  pendingLabel: string;
  onSubmit: (body: FormSubmitBody) => Promise<void>;
  onCancel?: () => void;
  resetAfterSubmit?: boolean;
}) {
  // Resolve initial state from the rule (edit mode) or defaults (create).
  const initialCameraIDs: string[] = (() => {
    if (!initial) return [];
    const ids = initial.definition.camera_ids ?? [];
    if (ids.length > 0) return ids;
    if (initial.definition.camera_id) return [initial.definition.camera_id];
    return [];
  })();
  const initialKind: "single" | "sequence" = initial?.definition.kind === "sequence" ? "sequence" : "single";

  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<"single" | "sequence">(initialKind);
  // applyToAll is tracked separately from cameraIDs so an empty
  // selection ("I want to pick cameras, just haven't yet") is distinct
  // from the all-cameras state. Without this, unticking "All cameras"
  // with an empty selection would immediately re-tick because the
  // derived check `cameraIDs.length === 0` would read as all.
  const [applyToAll, setApplyToAll] = useState<boolean>(initialCameraIDs.length === 0);
  const [cameraIDs, setCameraIDs] = useState<string[]>(initialCameraIDs);
  const [classes, setClasses] = useState((initial?.definition.classes ?? ["person"]).join(", "));
  const [minConf, setMinConf] = useState(initial?.definition.min_confidence ?? 0.5);
  const [zoneID, setZoneID] = useState(initial?.definition.zone_id ?? "");
  const [direction, setDirection] = useState<"" | "in" | "out">(initial?.definition.direction ?? "");
  const [severity, setSeverity] = useState<"info" | "warning" | "critical">(initial?.definition.severity ?? "warning");
  const [cooldown, setCooldown] = useState(initial?.definition.cooldown_sec ?? 30);
  const [steps, setSteps] = useState<Array<{ camera_id: string; classes: string }>>(
    initial?.definition.kind === "sequence"
      ? (initial.definition.steps ?? []).map((s) => ({
          camera_id: s.camera_id,
          classes: (s.classes ?? []).join(", "),
        }))
      : [
          { camera_id: "", classes: "car" },
          { camera_id: "", classes: "car" },
        ],
  );
  const [windowSec, setWindowSec] = useState(initial?.definition.window_sec ?? 120);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const selectedZone = zones.find((z) => z.id === zoneID);
  const isLineLike = selectedZone?.kind === "line" || selectedZone?.kind === "tripwire";

  function toggleCamera(id: string) {
    setApplyToAll(false);
    setCameraIDs((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function toggleApplyToAll() {
    // Ticking "All cameras" clears the chip selection so the two
    // states don't get out of sync. Unticking leaves the chip set
    // empty + enabled so the user can pick a subset.
    setApplyToAll((prev) => {
      const next = !prev;
      if (next) setCameraIDs([]);
      return next;
    });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    let def: Rule["definition"];
    if (kind === "sequence") {
      const cleanSteps = steps
        .map((s) => ({
          camera_id: s.camera_id.trim(),
          classes: s.classes.split(",").map((c) => c.trim()).filter(Boolean),
        }))
        .filter((s) => s.camera_id);
      if (cleanSteps.length < 2) {
        setErr("sequence rules need at least 2 steps with cameras");
        return;
      }
      def = {
        kind: "sequence",
        classes: [],
        min_confidence: 0,
        cooldown_sec: cooldown,
        severity,
        steps: cleanSteps.map((s) => ({
          camera_id: s.camera_id,
          classes: s.classes.length ? s.classes : undefined,
        })),
        window_sec: windowSec,
      };
    } else {
      if (!applyToAll && cameraIDs.length === 0) {
        setErr("pick at least one camera, or tick All cameras");
        return;
      }
      def = {
        camera_ids: applyToAll ? [] : cameraIDs,
        classes: classes.split(",").map((c) => c.trim()).filter(Boolean),
        min_confidence: minConf,
        zone_id: zoneID || undefined,
        direction: isLineLike && direction ? direction : undefined,
        cooldown_sec: cooldown,
        severity,
      };
    }
    setPending(true);
    try {
      await onSubmit({ name, enabled: initial?.enabled ?? true, definition: def });
      if (resetAfterSubmit) setName("");
    } catch (e) {
      setErr((e as Error)?.message ?? "submit failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid grid-cols-2 gap-2 text-sm">
      <input
        className="bg-neutral-900 rounded px-3 py-2 col-span-2"
        placeholder="Rule name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />

      <select
        className="bg-neutral-900 rounded px-3 py-2 col-span-2"
        value={kind}
        onChange={(e) => setKind(e.target.value as "single" | "sequence")}
        title="Rule kind"
      >
        <option value="single">Single camera (per-detection)</option>
        <option value="sequence">Sequence (seen on A then B within N seconds)</option>
      </select>

      {kind === "single" ? (
        <>
          <div className="col-span-2 space-y-1">
            <label className="inline-flex items-center gap-2 text-xs text-neutral-400">
              <input type="checkbox" checked={applyToAll} onChange={toggleApplyToAll} />
              All cameras
            </label>
            <div className={`flex flex-wrap gap-1 ${applyToAll ? "opacity-40" : ""}`}>
              {cameras.map((c) => {
                const on = cameraIDs.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    disabled={applyToAll}
                    onClick={() => toggleCamera(c.id)}
                    className={`text-xs rounded px-2 py-0.5 border ${
                      on
                        ? "bg-blue-700 border-blue-600 text-white"
                        : "bg-neutral-900 border-neutral-700 text-neutral-400 hover:text-neutral-100"
                    }`}
                    title={c.id}
                  >
                    {c.name}
                  </button>
                );
              })}
              {cameras.length === 0 && (
                <span className="text-xs text-neutral-600">no cameras configured</span>
              )}
            </div>
          </div>

          <select
            className="bg-neutral-900 rounded px-3 py-2"
            value={zoneID}
            onChange={(e) => setZoneID(e.target.value)}
          >
            <option value="">— any zone —</option>
            {zones
              .filter((z) => applyToAll || cameraIDs.length === 0 || cameraIDs.includes(z.camera_id))
              .map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name} ({z.kind}) · {z.camera_id}
                </option>
              ))}
          </select>

          {isLineLike ? (
            <select
              className="bg-neutral-900 rounded px-3 py-2"
              value={direction}
              onChange={(e) => setDirection(e.target.value as "" | "in" | "out")}
              title="Which direction of crossing fires this rule"
            >
              <option value="">both directions</option>
              <option value="in">crossing in (A → B)</option>
              <option value="out">crossing out (B → A)</option>
            </select>
          ) : (
            <div />
          )}

          <input
            className="bg-neutral-900 rounded px-3 py-2"
            placeholder="classes (comma-sep)"
            value={classes}
            onChange={(e) => setClasses(e.target.value)}
          />
          <input
            type="number"
            step="0.05"
            min="0"
            max="1"
            className="bg-neutral-900 rounded px-3 py-2"
            placeholder="min confidence"
            value={minConf}
            onChange={(e) => setMinConf(Number(e.target.value))}
          />
        </>
      ) : (
        <>
          <div className="col-span-2 space-y-2">
            {steps.map((s, i) => (
              <div key={i} className="flex gap-2 items-center">
                <span className="text-xs text-neutral-500 w-6">#{i + 1}</span>
                <select
                  className="bg-neutral-900 rounded px-2 py-1 flex-1"
                  value={s.camera_id}
                  onChange={(e) =>
                    setSteps((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, camera_id: e.target.value } : x)),
                    )
                  }
                  required
                >
                  <option value="">— pick camera —</option>
                  {cameras.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.id})
                    </option>
                  ))}
                </select>
                <input
                  className="bg-neutral-900 rounded px-2 py-1 flex-1"
                  placeholder="classes (comma-sep, blank = any)"
                  value={s.classes}
                  onChange={(e) =>
                    setSteps((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, classes: e.target.value } : x)),
                    )
                  }
                />
                {steps.length > 2 && (
                  <button
                    type="button"
                    className="text-red-400 text-xs hover:underline"
                    onClick={() => setSteps((prev) => prev.filter((_, j) => j !== i))}
                  >
                    remove
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              className="text-blue-400 text-xs hover:underline"
              onClick={() => setSteps((prev) => [...prev, { camera_id: "", classes: "" }])}
            >
              + add step
            </button>
          </div>
          <input
            type="number"
            min="1"
            className="bg-neutral-900 rounded px-3 py-2"
            placeholder="window (s)"
            value={windowSec}
            onChange={(e) => setWindowSec(Number(e.target.value))}
          />
          <div />
        </>
      )}

      <select
        className="bg-neutral-900 rounded px-3 py-2"
        value={severity}
        onChange={(e) => setSeverity(e.target.value as "info" | "warning" | "critical")}
      >
        <option value="info">info</option>
        <option value="warning">warning</option>
        <option value="critical">critical</option>
      </select>
      <input
        type="number"
        min="0"
        className="bg-neutral-900 rounded px-3 py-2"
        placeholder="cooldown (s)"
        value={cooldown}
        onChange={(e) => setCooldown(Number(e.target.value))}
      />

      {err && <div className="col-span-2 text-xs text-red-400">{err}</div>}

      <div className="col-span-2 flex gap-2">
        <button
          type="submit"
          className="flex-1 bg-blue-600 hover:bg-blue-500 rounded px-3 py-2"
          disabled={pending}
        >
          {pending ? pendingLabel : submitLabel}
        </button>
        {onCancel && (
          <button
            type="button"
            className="px-3 py-2 text-neutral-400 hover:text-white"
            onClick={onCancel}
          >
            cancel
          </button>
        )}
      </div>
    </form>
  );
}

function cameraNamesFor(def: Rule["definition"], cameras: Camera[]): string {
  const ids = def.camera_ids && def.camera_ids.length > 0
    ? def.camera_ids
    : def.camera_id
      ? [def.camera_id]
      : [];
  if (ids.length === 0) return "all cameras";
  return ids
    .map((id) => cameras.find((c) => c.id === id)?.name ?? id)
    .join(", ");
}

function RuleRow({
  rule,
  cameras,
  zones,
  channels,
  subscriptions,
  isAdmin,
  onToggle,
  onDelete,
}: {
  rule: Rule;
  cameras: Camera[];
  zones: Zone[];
  channels: NotificationChannel[];
  subscriptions: NotificationSubscription[];
  isAdmin: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const qc = useQueryClient();
  const [addChannelID, setAddChannelID] = useState("");
  const [editing, setEditing] = useState(false);

  const invalidateSubs = () => qc.invalidateQueries({ queryKey: ["subscriptions"] });
  const addSub = useMutation({ mutationFn: api.createSubscription, onSuccess: invalidateSubs });
  const delSub = useMutation({ mutationFn: api.deleteSubscription, onSuccess: invalidateSubs });

  const invalidateRules = () => qc.invalidateQueries({ queryKey: ["rules"] });
  const updateRule = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { name?: string; definition?: Rule["definition"] } }) =>
      api.updateRule(id, body),
    onSuccess: invalidateRules,
  });

  const subscribedIDs = new Set(subscriptions.map((s) => s.channel_id));
  const available = channels.filter((c) => !subscribedIDs.has(c.id));

  const handleAdd = () => {
    if (!addChannelID) return;
    addSub.mutate({ channel_id: addChannelID, rule_id: rule.id, min_severity: "info" });
    setAddChannelID("");
  };

  return (
    <li className="p-3 text-sm">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <div className="font-medium">{rule.name}</div>
          <div className="text-xs text-neutral-500">
            {rule.definition.kind === "sequence" ? (
              <>
                {(rule.definition.steps ?? []).map((s) => s.camera_id).join(" → ")}
                {` · within ${rule.definition.window_sec ?? 0}s`}
                {` · ${rule.definition.severity ?? "info"}`}
              </>
            ) : (
              <>
                {(rule.definition.classes ?? []).join(", ")}
                {` · ${cameraNamesFor(rule.definition, cameras)}`}
                {` · ≥${Math.round((rule.definition.min_confidence ?? 0) * 100)}%`}
                {rule.definition.direction && ` · crossing ${rule.definition.direction}`}
                {` · ${rule.definition.severity ?? "info"}`}
              </>
            )}
          </div>
        </div>
        {isAdmin && (
          <>
            <button
              className="text-xs text-neutral-400 hover:underline"
              onClick={() => setEditing((v) => !v)}
            >
              {editing ? "close" : "edit"}
            </button>
            <button className="text-xs text-neutral-400 hover:underline" onClick={onToggle}>
              {rule.enabled ? "disable" : "enable"}
            </button>
            <button className="text-xs text-red-400 hover:underline" onClick={onDelete}>
              delete
            </button>
          </>
        )}
      </div>

      {editing && isAdmin && (
        <div className="mt-3 p-3 rounded bg-neutral-900/50 border border-neutral-800">
          <RuleForm
            cameras={cameras}
            zones={zones}
            initial={rule}
            submitLabel="Save"
            pendingLabel="Saving…"
            onCancel={() => setEditing(false)}
            onSubmit={(body) =>
              new Promise<void>((resolve, reject) => {
                updateRule.mutate(
                  { id: rule.id, body: { name: body.name, definition: body.definition } },
                  {
                    onSuccess: () => {
                      setEditing(false);
                      resolve();
                    },
                    onError: (e) => reject(e),
                  },
                );
              })
            }
          />
        </div>
      )}

      <div className="mt-2 pl-2 border-l-2 border-neutral-800 text-xs flex flex-wrap items-center gap-2">
        <span className="text-neutral-500">notifies:</span>
        {subscriptions.length === 0 && <span className="text-neutral-600 italic">no channels</span>}
        {subscriptions.map((s) => {
          const c = channels.find((c) => c.id === s.channel_id);
          return (
            <span
              key={s.id}
              className="inline-flex items-center gap-1 bg-neutral-800 rounded px-2 py-0.5"
            >
              {c ? `${c.name} (${c.kind})` : s.channel_id.slice(0, 8)}
              {isAdmin && (
                <button
                  className="text-red-400 hover:text-red-300"
                  onClick={() => delSub.mutate(s.id)}
                  title="unsubscribe"
                >
                  ×
                </button>
              )}
            </span>
          );
        })}
        {isAdmin && available.length > 0 && (
          <>
            <select
              className="bg-neutral-900 border border-neutral-700 rounded px-2 py-0.5"
              value={addChannelID}
              onChange={(e) => setAddChannelID(e.target.value)}
            >
              <option value="">+ add channel…</option>
              {available.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.kind})
                </option>
              ))}
            </select>
            {addChannelID && (
              <button
                className="text-blue-400 hover:underline"
                onClick={handleAdd}
                disabled={addSub.isPending}
              >
                add
              </button>
            )}
          </>
        )}
        {channels.length === 0 && (
          <a href="/settings" className="text-blue-400 hover:underline">
            create a channel
          </a>
        )}
      </div>
    </li>
  );
}

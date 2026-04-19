import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, NotificationChannel, NotificationSubscription, Rule } from "@/lib/api";

export function Rules() {
  const qc = useQueryClient();
  const { data: rules = [] } = useQuery({ queryKey: ["rules"], queryFn: api.listRules });
  const { data: zones = [] } = useQuery({ queryKey: ["zones"], queryFn: () => api.listZones() });
  const { data: cameras = [] } = useQuery({ queryKey: ["cameras"], queryFn: api.listCameras });
  const { data: channels = [] } = useQuery({ queryKey: ["channels"], queryFn: api.listChannels });
  const { data: subscriptions = [] } = useQuery({
    queryKey: ["subscriptions"],
    queryFn: () => api.listSubscriptions(),
  });

  const createRule = useMutation({
    mutationFn: api.createRule,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rules"] }),
  });
  const deleteRule = useMutation({
    mutationFn: api.deleteRule,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rules"] }),
  });
  const toggleRule = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      enabled ? api.disableRule(id) : api.enableRule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rules"] }),
  });

  const [name, setName] = useState("");
  const [cameraID, setCameraID] = useState("");
  const [classes, setClasses] = useState("person");
  const [minConf, setMinConf] = useState(0.5);
  const [zoneID, setZoneID] = useState("");
  const [severity, setSeverity] = useState<"info" | "warning" | "critical">("warning");
  const [cooldown, setCooldown] = useState(30);

  function submit(e: FormEvent) {
    e.preventDefault();
    createRule.mutate({
      name,
      enabled: true,
      definition: {
        camera_id: cameraID || undefined,
        classes: classes.split(",").map((c) => c.trim()).filter(Boolean),
        min_confidence: minConf,
        zone_id: zoneID || undefined,
        cooldown_sec: cooldown,
        severity,
      },
    } as any);
    setName("");
  }

  return (
    <div className="p-4 space-y-6 max-w-3xl">
      <section>
        <h2 className="text-lg font-semibold mb-2">New rule</h2>
        <form onSubmit={submit} className="grid grid-cols-2 gap-2 text-sm">
          <input className="bg-neutral-900 rounded px-3 py-2 col-span-2" placeholder="Rule name"
            value={name} onChange={(e) => setName(e.target.value)} required />

          <select className="bg-neutral-900 rounded px-3 py-2" value={cameraID}
            onChange={(e) => setCameraID(e.target.value)}>
            <option value="">— any camera —</option>
            {cameras.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.id})</option>)}
          </select>

          <select className="bg-neutral-900 rounded px-3 py-2" value={zoneID}
            onChange={(e) => setZoneID(e.target.value)}>
            <option value="">— any zone —</option>
            {zones
              .filter((z) => !cameraID || z.camera_id === cameraID)
              .map((z) => <option key={z.id} value={z.id}>{z.name} ({z.camera_id})</option>)}
          </select>

          <input className="bg-neutral-900 rounded px-3 py-2" placeholder="classes (comma-sep)"
            value={classes} onChange={(e) => setClasses(e.target.value)} />
          <input type="number" step="0.05" min="0" max="1" className="bg-neutral-900 rounded px-3 py-2"
            placeholder="min confidence" value={minConf}
            onChange={(e) => setMinConf(Number(e.target.value))} />

          <select className="bg-neutral-900 rounded px-3 py-2" value={severity}
            onChange={(e) => setSeverity(e.target.value as any)}>
            <option value="info">info</option>
            <option value="warning">warning</option>
            <option value="critical">critical</option>
          </select>
          <input type="number" min="0" className="bg-neutral-900 rounded px-3 py-2"
            placeholder="cooldown (s)" value={cooldown}
            onChange={(e) => setCooldown(Number(e.target.value))} />

          <button type="submit" className="col-span-2 bg-blue-600 hover:bg-blue-500 rounded px-3 py-2"
            disabled={createRule.isPending}>
            {createRule.isPending ? "Adding…" : "Add rule"}
          </button>
        </form>
      </section>

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
                channels={channels}
                subscriptions={subscriptions.filter((s) => s.rule_id === r.id)}
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

function RuleRow({ rule, channels, subscriptions, onToggle, onDelete }: {
  rule: Rule;
  channels: NotificationChannel[];
  subscriptions: NotificationSubscription[];
  onToggle: () => void;
  onDelete: () => void;
}) {
  const qc = useQueryClient();
  const [addChannelID, setAddChannelID] = useState("");

  const invalidate = () => qc.invalidateQueries({ queryKey: ["subscriptions"] });
  const addSub = useMutation({ mutationFn: api.createSubscription, onSuccess: invalidate });
  const delSub = useMutation({ mutationFn: api.deleteSubscription, onSuccess: invalidate });

  const subscribedIDs = new Set(subscriptions.map((s) => s.channel_id));
  const available = channels.filter((c) => !subscribedIDs.has(c.id));

  const handleAdd = () => {
    if (!addChannelID) return;
    addSub.mutate({
      channel_id: addChannelID,
      rule_id: rule.id,
      min_severity: "info",
    });
    setAddChannelID("");
  };

  return (
    <li className="p-3 text-sm">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <div className="font-medium">{rule.name}</div>
          <div className="text-xs text-neutral-500">
            {(rule.definition.classes ?? []).join(", ")}
            {rule.definition.camera_id && ` · ${rule.definition.camera_id}`}
            {` · ≥${Math.round((rule.definition.min_confidence ?? 0) * 100)}%`}
            {` · ${rule.definition.severity ?? "info"}`}
          </div>
        </div>
        <button className="text-xs text-neutral-400 hover:underline" onClick={onToggle}>
          {rule.enabled ? "disable" : "enable"}
        </button>
        <button className="text-xs text-red-400 hover:underline" onClick={onDelete}>
          delete
        </button>
      </div>

      <div className="mt-2 pl-2 border-l-2 border-neutral-800 text-xs flex flex-wrap items-center gap-2">
        <span className="text-neutral-500">notifies:</span>
        {subscriptions.length === 0 && (
          <span className="text-neutral-600 italic">no channels</span>
        )}
        {subscriptions.map((s) => {
          const c = channels.find((c) => c.id === s.channel_id);
          return (
            <span
              key={s.id}
              className="inline-flex items-center gap-1 bg-neutral-800 rounded px-2 py-0.5"
            >
              {c ? `${c.name} (${c.kind})` : s.channel_id.slice(0, 8)}
              <button
                className="text-red-400 hover:text-red-300"
                onClick={() => delSub.mutate(s.id)}
                title="unsubscribe"
              >
                ×
              </button>
            </span>
          );
        })}
        {available.length > 0 && (
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

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, HAConfig, NotificationChannel, NotificationSubscription } from "@/lib/api";
import { Card, FormRow, SaveBar } from "@/components/ui/Card";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { useDraft } from "@/lib/useDraft";
import { useReportDirty } from "./dirty";

export function IntegrationsTab({ isAdmin }: { isAdmin: boolean }) {
  return (
    <>
      {isAdmin && <HomeAssistantCard />}
      <NotificationsCard isAdmin={isAdmin} />
    </>
  );
}

// Home Assistant bridge settings. Saving reloads the dispatcher's
// bridge within ~30s (it polls ha.config that often); no restart.
function HomeAssistantCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: server } = useQuery({
    queryKey: ["ha-config"],
    queryFn: api.getHAConfig,
  });

  // Masked password round-trips unchanged, so the draft stays clean
  // until the admin actually types a new one.
  const { draft, setDraft, dirty, discard } = useDraft<HAConfig>(server);
  useReportDirty("ha", dirty);

  const save = useMutation({
    mutationFn: (c: HAConfig) => api.updateHAConfig(c),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ha-config"] });
      toast.success("Home Assistant settings saved — bridge reloads within 30s");
    },
    onError: (e) => toast.error(String((e as Error)?.message ?? "save failed")),
  });

  if (!draft) {
    return (
      <Card title="Home Assistant">
        <p className="text-sm text-neutral-500">Loading…</p>
      </Card>
    );
  }
  const patch = (p: Partial<HAConfig>) => setDraft((d) => (d ? { ...d, ...p } : d));

  return (
    <Card
      title="Home Assistant"
      description="Publishes every camera as a Home Assistant device via MQTT auto-discovery. HA picks up motion, incident, last-class, last-confidence, last-plate, and camera-state entities per camera. Changes take effect within 30 seconds of Save."
    >
      <div className="grid gap-2">
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          Enable bridge
        </label>
        <FormRow label="Broker URL">
          <input
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 w-full"
            value={draft.broker_url}
            onChange={(e) => patch({ broker_url: e.target.value })}
            placeholder="tcp://mosquitto:1883"
          />
        </FormRow>
        <FormRow label="Username">
          <input
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 w-full"
            value={draft.username}
            onChange={(e) => patch({ username: e.target.value })}
          />
        </FormRow>
        <FormRow label="Password">
          <input
            type="password"
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 w-full"
            value={draft.password}
            onChange={(e) => patch({ password: e.target.value })}
            placeholder="unchanged"
          />
        </FormRow>
        <FormRow label="Discovery prefix">
          <input
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 w-full"
            value={draft.discovery_prefix}
            onChange={(e) => patch({ discovery_prefix: e.target.value })}
          />
        </FormRow>
        <FormRow label="Topic prefix">
          <input
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 w-full"
            value={draft.topic_prefix}
            onChange={(e) => patch({ topic_prefix: e.target.value })}
          />
        </FormRow>
        <SaveBar
          dirty={dirty}
          saving={save.isPending}
          onSave={() => save.mutate(draft)}
          onDiscard={discard}
        />
      </div>
    </Card>
  );
}

function NotificationsCard({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { data: channels = [] } = useQuery({
    queryKey: ["channels"],
    queryFn: api.listChannels,
  });
  const { data: subscriptions = [] } = useQuery({
    queryKey: ["subscriptions"],
    queryFn: () => api.listSubscriptions(),
  });
  const { data: deliveries = [] } = useQuery({
    queryKey: ["deliveries"],
    queryFn: () => api.recentDeliveries(20),
    refetchInterval: 5_000,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["channels"] });
  const del = useMutation({
    mutationFn: api.deleteChannel,
    onSuccess: () => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["subscriptions"] });
      toast.success("Channel deleted");
    },
    onError: (e) => toast.error(String((e as Error)?.message ?? "delete failed")),
  });
  const enable = useMutation({
    mutationFn: api.enableChannel,
    onSuccess: () => {
      invalidate();
      toast.success("Channel enabled");
    },
    onError: (e) => toast.error(String((e as Error)?.message ?? "enable failed")),
  });
  const disable = useMutation({
    mutationFn: api.disableChannel,
    onSuccess: () => {
      invalidate();
      toast.success("Channel disabled");
    },
    onError: (e) => toast.error(String((e as Error)?.message ?? "disable failed")),
  });

  const [subsOpenFor, setSubsOpenFor] = useState<string | null>(null);
  const subsFor = (channelId: string) =>
    subscriptions.filter((s) => s.channel_id === channelId);

  return (
    <Card
      title="Notifications"
      description="Channels receive incidents as they fire. A channel only fires for incidents matched by one of its subscriptions — add at least one below."
    >
      {isAdmin && <NewChannelForm onCreated={invalidate} />}

      {channels.length === 0 ? (
        <p className="text-neutral-500 text-sm">No channels yet.</p>
      ) : (
        <ul className="divide-y divide-neutral-800 rounded border border-neutral-800 text-sm">
          {channels.map((c) => {
            const subs = subsFor(c.id);
            return (
              <li key={c.id} className="p-2">
                <div className="grid grid-cols-[1fr_auto] gap-2 items-center">
                  <div>
                    <div className="font-medium">
                      {c.name}{" "}
                      <span className="text-neutral-500 font-normal">
                        · {c.kind}
                        {!c.enabled && <span className="text-amber-500"> · disabled</span>}
                      </span>
                      {subs.length === 0 ? (
                        <span className="ml-2 text-[11px] bg-amber-900/60 border border-amber-700 text-amber-200 rounded px-1.5 py-0.5">
                          never fires — no subscriptions
                        </span>
                      ) : (
                        <span className="ml-2 text-[11px] bg-neutral-800 text-neutral-400 rounded px-1.5 py-0.5">
                          {subs.length} subscription{subs.length === 1 ? "" : "s"}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-neutral-500 truncate">
                      {formatChannelConfig(c)}
                    </div>
                  </div>
                  <div className="flex gap-3 text-xs">
                    <button
                      className="text-neutral-300 hover:underline"
                      onClick={() => setSubsOpenFor(subsOpenFor === c.id ? null : c.id)}
                    >
                      {subsOpenFor === c.id ? "hide subscriptions" : "subscriptions"}
                    </button>
                    {isAdmin && (
                      <>
                        <button
                          className="text-blue-400 hover:underline"
                          onClick={() => (c.enabled ? disable.mutate(c.id) : enable.mutate(c.id))}
                        >
                          {c.enabled ? "disable" : "enable"}
                        </button>
                        <button
                          className="text-red-400 hover:underline"
                          onClick={async () => {
                            const ok = await confirm({
                              title: `Delete channel "${c.name}"?`,
                              body: "Its subscriptions are removed with it.",
                              confirmLabel: "Delete",
                              tone: "danger",
                            });
                            if (ok) del.mutate(c.id);
                          }}
                        >
                          delete
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {subsOpenFor === c.id && (
                  <SubscriptionsPanel channelId={c.id} subs={subs} isAdmin={isAdmin} />
                )}
              </li>
            );
          })}
        </ul>
      )}

      <h3 className="text-sm font-semibold mt-2">Recent deliveries</h3>
      {deliveries.length === 0 ? (
        <p className="text-neutral-500 text-xs">No delivery attempts yet.</p>
      ) : (
        <ul className="divide-y divide-neutral-800 rounded border border-neutral-800 text-xs max-h-60 overflow-auto">
          {deliveries.map((d) => (
            <li key={d.id} className="p-2 grid grid-cols-[10rem_4rem_1fr] gap-2 items-center">
              <span className="text-neutral-500 tabular-nums">
                {new Date(d.attempted_at).toLocaleString()}
              </span>
              <span className={d.succeeded ? "text-emerald-400" : "text-red-400"}>
                {d.succeeded ? `ok${d.status_code ? ` (${d.status_code})` : ""}` : "fail"}
              </span>
              <span className="text-neutral-500 truncate">
                {d.error ?? `incident ${d.incident_id.slice(0, 8)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// Subscription management — the piece that used to say "add
// subscriptions via the API for now" while channels silently never
// fired without one.
function SubscriptionsPanel({
  channelId,
  subs,
  isAdmin,
}: {
  channelId: string;
  subs: NotificationSubscription[];
  isAdmin: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { data: rules = [] } = useQuery({ queryKey: ["rules"], queryFn: api.listRules });
  const { data: cameras = [] } = useQuery({ queryKey: ["cameras"], queryFn: api.listCameras });

  const [ruleId, setRuleId] = useState("");
  const [cameraId, setCameraId] = useState("");
  const [severity, setSeverity] = useState<"info" | "warning" | "critical">("info");

  const invalidate = () => qc.invalidateQueries({ queryKey: ["subscriptions"] });
  const create = useMutation({
    mutationFn: (body: Partial<NotificationSubscription>) => api.createSubscription(body),
    onSuccess: () => {
      invalidate();
      toast.success("Subscription added");
    },
    onError: (e) => toast.error(String((e as Error)?.message ?? "subscribe failed")),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSubscription(id),
    onSuccess: () => {
      invalidate();
      toast.success("Subscription removed");
    },
    onError: (e) => toast.error(String((e as Error)?.message ?? "delete failed")),
  });

  const ruleName = (id?: string) =>
    id ? rules.find((r) => r.id === id)?.name ?? id.slice(0, 8) : "any rule";
  const cameraName = (id?: string) =>
    id ? cameras.find((c) => c.id === id)?.name ?? id : "any camera";

  const add = (body: Partial<NotificationSubscription>) =>
    create.mutate({ channel_id: channelId, ...body });

  return (
    <div className="mt-2 ml-3 pl-3 border-l-2 border-neutral-800 space-y-2 text-xs">
      {subs.length === 0 ? (
        <div className="flex items-center gap-3">
          <span className="text-neutral-500">No subscriptions yet.</span>
          {isAdmin && (
            <button
              className="text-blue-400 hover:underline"
              onClick={() => add({ min_severity: "warning" })}
            >
              Subscribe to all incidents ≥ warning
            </button>
          )}
        </div>
      ) : (
        <ul className="divide-y divide-neutral-800 rounded border border-neutral-800">
          {subs.map((s) => (
            <li key={s.id} className="p-2 grid grid-cols-[1fr_auto] gap-2 items-center">
              <span>
                {ruleName(s.rule_id)} · {cameraName(s.camera_id)} ·{" "}
                <SeverityBadge s={s.min_severity} />
              </span>
              {isAdmin && (
                <button
                  className="text-red-400 hover:underline"
                  onClick={async () => {
                    const ok = await confirm({
                      title: "Remove this subscription?",
                      confirmLabel: "Remove",
                      tone: "danger",
                    });
                    if (ok) remove.mutate(s.id);
                  }}
                >
                  remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {isAdmin && (
        <form
          className="flex items-center gap-2 flex-wrap"
          onSubmit={(e) => {
            e.preventDefault();
            add({
              ...(ruleId ? { rule_id: ruleId } : {}),
              ...(cameraId ? { camera_id: cameraId } : {}),
              min_severity: severity,
            });
          }}
        >
          <select
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-0.5"
            value={ruleId}
            onChange={(e) => setRuleId(e.target.value)}
          >
            <option value="">Any rule</option>
            {rules.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
          <select
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-0.5"
            value={cameraId}
            onChange={(e) => setCameraId(e.target.value)}
          >
            <option value="">Any camera</option>
            {cameras.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <select
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-0.5"
            value={severity}
            onChange={(e) => setSeverity(e.target.value as typeof severity)}
            title="Minimum incident severity"
          >
            <option value="info">≥ info</option>
            <option value="warning">≥ warning</option>
            <option value="critical">critical only</option>
          </select>
          <button
            type="submit"
            className="bg-blue-600 hover:bg-blue-500 rounded px-2 py-0.5 disabled:opacity-50"
            disabled={create.isPending}
          >
            {create.isPending ? "adding…" : "add subscription"}
          </button>
        </form>
      )}
    </div>
  );
}

function SeverityBadge({ s }: { s: string }) {
  const color =
    s === "critical"
      ? "bg-red-900/70 text-red-200"
      : s === "warning"
        ? "bg-amber-900/70 text-amber-200"
        : "bg-blue-900/70 text-blue-200";
  return <span className={`rounded px-1.5 py-0.5 ${color}`}>≥ {s}</span>;
}

function NewChannelForm({ onCreated }: { onCreated: () => void }) {
  const toast = useToast();
  const [kind, setKind] = useState<"webhook" | "ntfy" | "mqtt">("webhook");
  const [name, setName] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [ntfyServer, setNtfyServer] = useState("https://ntfy.sh");
  const [ntfyTopic, setNtfyTopic] = useState("");
  const [mqttBroker, setMqttBroker] = useState("tcp://mosquitto:1883");
  const [mqttUser, setMqttUser] = useState("");
  const [mqttPass, setMqttPass] = useState("");
  const [mqttTopic, setMqttTopic] = useState("alerts/{severity}/{camera_id}");
  const [mqttQOS, setMqttQOS] = useState(1);
  const [mqttRetain, setMqttRetain] = useState(false);

  const create = useMutation({
    mutationFn: api.createChannel,
    onSuccess: (c) => {
      onCreated();
      toast.success(`Channel "${c.name}" created — now add a subscription so it fires`);
      setName("");
      setWebhookUrl("");
      setNtfyTopic("");
      setMqttUser("");
      setMqttPass("");
    },
    onError: (e) => toast.error(String((e as Error)?.message ?? "create failed")),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    let config: Record<string, unknown>;
    if (kind === "webhook") {
      config = { url: webhookUrl };
    } else if (kind === "ntfy") {
      config = { server: ntfyServer, topic: ntfyTopic };
    } else {
      config = {
        broker_url: mqttBroker,
        username: mqttUser,
        password: mqttPass,
        topic: mqttTopic,
        qos: mqttQOS,
        retain: mqttRetain,
      };
    }
    create.mutate({ name, kind, config, enabled: true });
  };

  return (
    <form onSubmit={submit} className="grid grid-cols-[1fr_8rem_auto] gap-2 items-start">
      <input
        className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm"
        placeholder="Name (e.g. Home Assistant)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />
      <select
        className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm"
        value={kind}
        onChange={(e) => setKind(e.target.value as "webhook" | "ntfy" | "mqtt")}
      >
        <option value="webhook">webhook</option>
        <option value="ntfy">ntfy</option>
        <option value="mqtt">mqtt</option>
      </select>
      <div />
      {kind === "webhook" ? (
        <input
          className="col-span-2 bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm"
          placeholder="POST URL"
          value={webhookUrl}
          onChange={(e) => setWebhookUrl(e.target.value)}
          required
        />
      ) : kind === "ntfy" ? (
        <>
          <input
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm"
            placeholder="ntfy server"
            value={ntfyServer}
            onChange={(e) => setNtfyServer(e.target.value)}
          />
          <input
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm"
            placeholder="topic"
            value={ntfyTopic}
            onChange={(e) => setNtfyTopic(e.target.value)}
            required
          />
        </>
      ) : (
        <>
          <input
            className="col-span-2 bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm"
            placeholder="broker URL (tcp://host:1883)"
            value={mqttBroker}
            onChange={(e) => setMqttBroker(e.target.value)}
            required
          />
          <input
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm"
            placeholder="username (optional)"
            value={mqttUser}
            onChange={(e) => setMqttUser(e.target.value)}
          />
          <input
            type="password"
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm"
            placeholder="password (optional)"
            value={mqttPass}
            onChange={(e) => setMqttPass(e.target.value)}
          />
          <input
            className="col-span-2 bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm"
            placeholder="topic (tokens: {camera_id} {severity} {rule_id})"
            value={mqttTopic}
            onChange={(e) => setMqttTopic(e.target.value)}
            required
          />
          <select
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm"
            value={mqttQOS}
            onChange={(e) => setMqttQOS(Number(e.target.value))}
            title="QoS"
          >
            <option value={0}>QoS 0</option>
            <option value={1}>QoS 1</option>
            <option value={2}>QoS 2</option>
          </select>
          <label className="inline-flex items-center gap-1 text-xs text-neutral-400">
            <input type="checkbox" checked={mqttRetain} onChange={(e) => setMqttRetain(e.target.checked)} />
            retain
          </label>
        </>
      )}
      <button
        type="submit"
        className="bg-blue-600 hover:bg-blue-500 rounded px-3 py-1 text-sm"
        disabled={create.isPending}
      >
        {create.isPending ? "adding…" : "add"}
      </button>
    </form>
  );
}

function formatChannelConfig(c: NotificationChannel): string {
  if (c.kind === "webhook") {
    return `POST ${(c.config.url as string) ?? "—"}`;
  }
  if (c.kind === "ntfy") {
    return `${(c.config.server as string) ?? "https://ntfy.sh"}/${(c.config.topic as string) ?? ""}`;
  }
  if (c.kind === "mqtt") {
    const broker = (c.config.broker_url as string) ?? "?";
    const topic = (c.config.topic as string) ?? "?";
    const user = (c.config.username as string) ?? "";
    return `${user ? user + "@" : ""}${broker} → ${topic}`;
  }
  return JSON.stringify(c.config);
}

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, APIToken, ClassMutes as ClassMutesT, DetectorSettings, NotificationChannel } from "@/lib/api";
import { loadCocoLabels, classCategory, CATEGORY_ORDER } from "@/lib/classes";
import { useMe } from "@/lib/me";

export function Settings() {
  const { data: info } = useQuery({ queryKey: ["info"], queryFn: api.systemInfo });
  const { data: me } = useMe();

  return (
    <div className="p-4 space-y-6 max-w-3xl">
      <Detector />
      <ClassMutes />

      {me?.is_admin && <Users />}

      <section>
        <h2 className="text-lg font-semibold mb-2">System</h2>
        <pre className="text-xs bg-neutral-900 rounded p-3">
          {JSON.stringify(info, null, 2)}
        </pre>
      </section>

      <NotificationChannels />
    </div>
  );
}

// Short description shown in the dropdown. mAP numbers from Ultralytics'
// published COCO benchmarks for YOLO26 (standard mode).
const YOLO_VARIANTS: { value: DetectorSettings["yolo26_variant"]; label: string }[] = [
  { value: "yolo26n", label: "YOLO26-n · 40.9 mAP · fastest" },
  { value: "yolo26s", label: "YOLO26-s · 48.6 mAP" },
  { value: "yolo26m", label: "YOLO26-m · 53.1 mAP" },
  { value: "yolo26l", label: "YOLO26-l · 55.0 mAP" },
  { value: "yolo26x", label: "YOLO26-x · 57.5 mAP · most accurate" },
];

function Detector() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const isAdmin = !!me?.is_admin;
  const { data: current } = useQuery({
    queryKey: ["detector"],
    queryFn: api.getDetectorSettings,
  });
  const { data: pipelineState } = useQuery({
    queryKey: ["pipeline-state"],
    queryFn: api.getPipelineState,
    refetchInterval: 3_000,
  });

  const [variant, setVariant] = useState<DetectorSettings["yolo26_variant"]>("yolo26x");
  const [precision, setPrecision] = useState<DetectorSettings["yolo26_precision"]>("fp16");
  const [anpr, setAnpr] = useState<boolean>(false);

  // Seed local state from server once.
  useEffect(() => {
    if (current) {
      setVariant(current.yolo26_variant);
      setPrecision(current.yolo26_precision);
      setAnpr(!!current.anpr_enabled);
    }
  }, [current]);

  const save = useMutation({
    mutationFn: async () => {
      await api.updateDetectorSettings({
        yolo26_variant: variant,
        yolo26_precision: precision,
        anpr_enabled: anpr,
      });
      await api.restartPipeline();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["detector"] });
      qc.invalidateQueries({ queryKey: ["pipeline-state"] });
      qc.invalidateQueries({ queryKey: ["cameras"] });
    },
  });

  const dirty =
    !!current &&
    (variant !== current.yolo26_variant ||
      precision !== current.yolo26_precision ||
      anpr !== !!current.anpr_enabled);

  return (
    <section>
      <h2 className="text-lg font-semibold mb-2">Object detector</h2>
      <p className="text-sm text-neutral-500 mb-3">
        Primary detector run on every camera (unless disabled per-camera). YOLO26, 80 COCO classes.
      </p>

      <div className="grid gap-3 text-sm">
        <div className="grid grid-cols-[8rem_1fr] items-center gap-2">
          <label className="text-neutral-400">Model size</label>
          <select
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
            value={variant}
            onChange={(e) => setVariant(e.target.value as DetectorSettings["yolo26_variant"])}
          >
            {YOLO_VARIANTS.map((v) => (
              <option key={v.value} value={v.value}>{v.label}</option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-[8rem_1fr] items-center gap-2">
          <label className="text-neutral-400">Precision</label>
          <div className="flex items-center gap-4">
            <label className="inline-flex items-center gap-1">
              <input
                type="radio"
                name="precision"
                checked={precision === "fp16"}
                onChange={() => setPrecision("fp16")}
              />
              FP16
            </label>
            <label
              className="inline-flex items-center gap-1 text-neutral-500"
              title="INT8 via DeepStream-Yolo's calibrator is disabled pending an upstream TRT fix — see docs/known-issues.md"
            >
              <input type="radio" name="precision" disabled />
              INT8 (temporarily disabled)
            </label>
          </div>
        </div>

        <div className="grid grid-cols-[8rem_1fr] items-center gap-2">
          <label className="text-neutral-400">ANPR</label>
          <label
            className="inline-flex items-center gap-2"
            title="Adds NVIDIA TAO LPDNet + LPRNet after the object detector. Reads licence plates on vehicles (US charset). Toggling restarts the pipeline."
          >
            <input
              type="checkbox"
              checked={anpr}
              onChange={(e) => setAnpr(e.target.checked)}
            />
            <span>Read licence plates (LPDNet + LPRNet)</span>
          </label>
        </div>

        {isAdmin && (
          <div>
            <button
              className="bg-blue-600 hover:bg-blue-500 rounded px-3 py-1 text-sm disabled:opacity-50"
              onClick={() => save.mutate()}
              disabled={!dirty || save.isPending}
            >
              {save.isPending ? "Saving…" : dirty ? "Save and restart pipeline" : "No changes"}
            </button>
            {save.isError && (
              <span className="text-red-400 text-xs ml-3">
                {String((save.error as Error)?.message ?? "failed")}
              </span>
            )}
          </div>
        )}

        <PipelineStatusChip state={pipelineState?.state} />
      </div>
    </section>
  );
}

// Three-bucket class-mute editor (global / indoor / outdoor). Each bucket
// is an independent set — the server unions them with the camera's
// location_kind to produce the effective mute set. Per-camera overrides
// live on the camera row, not here.
function ClassMutes() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const isAdmin = !!me?.is_admin;
  const { data: server } = useQuery({
    queryKey: ["class-mutes"],
    queryFn: api.getClassMutes,
  });
  const [labels, setLabels] = useState<string[]>([]);
  useEffect(() => {
    loadCocoLabels().then(setLabels);
  }, []);

  // Local editable copy. Null = not yet seeded.
  const [local, setLocal] = useState<ClassMutesT | null>(null);
  useEffect(() => {
    if (server && !local) setLocal(server);
  }, [server, local]);

  const [expanded, setExpanded] = useState(false);
  const [openCats, setOpenCats] = useState<Record<string, boolean>>({});

  const grouped = useMemo(() => {
    const g: Record<string, string[]> = {};
    for (const c of CATEGORY_ORDER) g[c] = [];
    for (const l of labels) g[classCategory(l)].push(l);
    return g;
  }, [labels]);

  const save = useMutation({
    mutationFn: async (m: ClassMutesT) => {
      await api.updateClassMutes(m);
      // Pipeline workers snapshot their mute set at spawn, so a restart
      // is needed to stop muted classes from reaching Live bboxes. The
      // event-processor gate already picks up the change within 30s,
      // which keeps PG / sidecar / rules correct in the meantime.
      await api.restartPipeline();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["class-mutes"] });
      qc.invalidateQueries({ queryKey: ["pipeline-state"] });
    },
  });

  if (!local) {
    return (
      <section>
        <h2 className="text-lg font-semibold mb-2">Muted classes</h2>
        <p className="text-sm text-neutral-500">Loading…</p>
      </section>
    );
  }

  const has = (bucket: keyof ClassMutesT, cls: string) =>
    local[bucket].includes(cls);
  const toggle = (bucket: keyof ClassMutesT, cls: string) => {
    setLocal((prev) => {
      if (!prev) return prev;
      const set = new Set(prev[bucket]);
      if (set.has(cls)) set.delete(cls);
      else set.add(cls);
      return { ...prev, [bucket]: Array.from(set).sort() };
    });
  };

  const dirty =
    !!server &&
    (bucketDiffers(server.global, local.global) ||
      bucketDiffers(server.indoor, local.indoor) ||
      bucketDiffers(server.outdoor, local.outdoor));

  return (
    <section>
      <div className="flex items-baseline gap-3">
        <button
          className="text-lg font-semibold flex items-center gap-1 hover:text-neutral-300"
          onClick={() => setExpanded((v) => !v)}
        >
          <span className="inline-block w-3">{expanded ? "▾" : "▸"}</span>
          Muted classes
        </button>
        <span className="text-sm text-neutral-500">
          {local.global.length} global · {local.indoor.length} indoor ·{" "}
          {local.outdoor.length} outdoor
        </span>
        {dirty && isAdmin && (
          <button
            className="ml-auto bg-blue-600 hover:bg-blue-500 rounded px-3 py-1 text-sm disabled:opacity-50"
            disabled={save.isPending}
            onClick={() => save.mutate(local)}
          >
            {save.isPending ? "Saving…" : "Save and restart pipeline"}
          </button>
        )}
      </div>
      <p className="text-sm text-neutral-500 mt-1">
        Detections in any muted class are dropped before the timeline
        and rules engine. Indoor/outdoor buckets apply on top of global
        to cameras tagged with that location (Cameras → expand a row).
        Per-camera overrides let one camera ignore or re-enable a class.
      </p>

      {expanded && (
        <div className="mt-3 rounded border border-neutral-800 divide-y divide-neutral-800">
          <div className="grid grid-cols-[1fr_4rem_4rem_4rem] gap-2 items-center px-3 py-1 bg-neutral-900 text-xs text-neutral-500 uppercase">
            <span>Class</span>
            <span className="text-center">Global</span>
            <span className="text-center">Indoor</span>
            <span className="text-center">Outdoor</span>
          </div>
          {CATEGORY_ORDER.map((cat) => {
            const classes = grouped[cat] ?? [];
            if (classes.length === 0) return null;
            const open = !!openCats[cat];
            const counts = {
              global: classes.filter((c) => has("global", c)).length,
              indoor: classes.filter((c) => has("indoor", c)).length,
              outdoor: classes.filter((c) => has("outdoor", c)).length,
            };
            return (
              <div key={cat}>
                <button
                  className="w-full grid grid-cols-[1fr_4rem_4rem_4rem] gap-2 items-center px-3 py-1 text-left hover:bg-neutral-900"
                  onClick={() =>
                    setOpenCats((p) => ({ ...p, [cat]: !open }))
                  }
                >
                  <span className="text-sm font-medium">
                    <span className="inline-block w-3">{open ? "▾" : "▸"}</span>
                    {cat} <span className="text-neutral-500">({classes.length})</span>
                  </span>
                  <span className="text-center text-xs text-neutral-500">{counts.global || ""}</span>
                  <span className="text-center text-xs text-neutral-500">{counts.indoor || ""}</span>
                  <span className="text-center text-xs text-neutral-500">{counts.outdoor || ""}</span>
                </button>
                {open &&
                  classes.map((cls) => (
                    <div
                      key={cls}
                      className="grid grid-cols-[1fr_4rem_4rem_4rem] gap-2 items-center px-3 py-1 text-sm"
                    >
                      <span className="pl-5 text-neutral-300">{cls}</span>
                      <input
                        type="checkbox"
                        className="mx-auto"
                        checked={has("global", cls)}
                        onChange={() => toggle("global", cls)}
                      />
                      <input
                        type="checkbox"
                        className="mx-auto"
                        checked={has("indoor", cls)}
                        onChange={() => toggle("indoor", cls)}
                      />
                      <input
                        type="checkbox"
                        className="mx-auto"
                        checked={has("outdoor", cls)}
                        onChange={() => toggle("outdoor", cls)}
                      />
                    </div>
                  ))}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function bucketDiffers(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return true;
  const s = new Set(a);
  for (const x of b) if (!s.has(x)) return true;
  return false;
}

function PipelineStatusChip({ state }: { state?: { state: string; variant?: string; precision?: string; message?: string } }) {
  if (!state) return null;
  const label = state.state;
  let color = "bg-neutral-700 text-neutral-200";
  let text = "unknown";
  switch (label) {
    case "ready":
      color = "bg-emerald-700 text-emerald-100";
      text = "pipeline running";
      break;
    case "calibrating":
      color = "bg-amber-700 text-amber-100 animate-pulse";
      text = state.message ?? "Calibrating INT8…";
      break;
    case "compiling_engine":
      color = "bg-amber-700 text-amber-100 animate-pulse";
      text = state.message ?? "Building TensorRT engine…";
      break;
    case "failed":
      color = "bg-red-700 text-red-100";
      text = state.message ?? "failed";
      break;
    case "unknown":
      text = "pipeline state unknown";
      break;
  }
  return (
    <div className={`inline-flex items-center gap-2 rounded px-2 py-1 text-xs ${color}`}>
      <span>{text}</span>
      {state.variant && <span className="opacity-70">· {state.variant}/{state.precision}</span>}
    </div>
  );
}

function NotificationChannels() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const isAdmin = !!me?.is_admin;
  const { data: channels = [] } = useQuery({
    queryKey: ["channels"],
    queryFn: api.listChannels,
  });
  const { data: deliveries = [] } = useQuery({
    queryKey: ["deliveries"],
    queryFn: () => api.recentDeliveries(20),
    refetchInterval: 5_000,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["channels"] });
  const del = useMutation({ mutationFn: api.deleteChannel, onSuccess: invalidate });
  const enable = useMutation({ mutationFn: api.enableChannel, onSuccess: invalidate });
  const disable = useMutation({ mutationFn: api.disableChannel, onSuccess: invalidate });

  return (
    <section>
      <h2 className="text-lg font-semibold mb-2">Notifications</h2>
      <p className="text-sm text-neutral-500 mb-3">
        Channels receive incidents as they fire. A channel with no
        subscription never fires — add subscriptions via the API for now.
      </p>

      {isAdmin && <NewChannelForm onCreated={invalidate} />}

      {channels.length === 0 ? (
        <p className="text-neutral-500 text-sm mt-4">No channels yet.</p>
      ) : (
        <ul className="divide-y divide-neutral-800 rounded border border-neutral-800 text-sm mt-4">
          {channels.map((c) => (
            <li key={c.id} className="p-2 grid grid-cols-[1fr_auto] gap-2 items-center">
              <div>
                <div className="font-medium">
                  {c.name}{" "}
                  <span className="text-neutral-500 font-normal">
                    · {c.kind}{!c.enabled && <span className="text-amber-500"> · disabled</span>}
                  </span>
                </div>
                <div className="text-xs text-neutral-500 truncate">
                  {formatChannelConfig(c)}
                </div>
              </div>
              {isAdmin && (
                <div className="flex gap-3 text-xs">
                  <button
                    className="text-blue-400 hover:underline"
                    onClick={() => (c.enabled ? disable.mutate(c.id) : enable.mutate(c.id))}
                  >
                    {c.enabled ? "disable" : "enable"}
                  </button>
                  <button
                    className="text-red-400 hover:underline"
                    onClick={() => confirm(`delete channel "${c.name}"?`) && del.mutate(c.id)}
                  >
                    delete
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3 className="text-sm font-semibold mt-5 mb-1">Recent deliveries</h3>
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
    </section>
  );
}

function NewChannelForm({ onCreated }: { onCreated: () => void }) {
  const [kind, setKind] = useState<"webhook" | "ntfy">("webhook");
  const [name, setName] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [ntfyServer, setNtfyServer] = useState("https://ntfy.sh");
  const [ntfyTopic, setNtfyTopic] = useState("");

  const create = useMutation({
    mutationFn: api.createChannel,
    onSuccess: () => {
      onCreated();
      setName("");
      setWebhookUrl("");
      setNtfyTopic("");
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const config =
      kind === "webhook"
        ? { url: webhookUrl }
        : { server: ntfyServer, topic: ntfyTopic };
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
        onChange={(e) => setKind(e.target.value as "webhook" | "ntfy")}
      >
        <option value="webhook">webhook</option>
        <option value="ntfy">ntfy</option>
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
      ) : (
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
  return JSON.stringify(c.config);
}

// Admin-only users section: list, add, role-change, disable, delete,
// and an expandable tokens drawer for api-only users. All calls are
// server-side gated; this UI is the convenience layer.
function Users() {
  const qc = useQueryClient();
  const { data: users = [] } = useQuery({
    queryKey: ["users"],
    queryFn: api.listUsers,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["users"] });

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof api.updateUser>[1] }) =>
      api.updateUser(id, body),
    onSuccess: invalidate,
  });
  const del = useMutation({ mutationFn: api.deleteUser, onSuccess: invalidate });

  const [showTokensFor, setShowTokensFor] = useState<string | null>(null);

  return (
    <section>
      <h2 className="text-lg font-semibold mb-2">Users</h2>
      <p className="text-sm text-neutral-500 mb-3">
        Admin can edit everything. Viewer can read everything but cannot
        change settings, cameras, zones, or rules. API-only users cannot
        log into the web UI; they authenticate with personal access
        tokens in the Authorization header.
      </p>

      <NewUserForm onCreated={invalidate} />

      {users.length === 0 ? (
        <p className="text-neutral-500 text-sm mt-4">No users yet.</p>
      ) : (
        <ul className="divide-y divide-neutral-800 rounded border border-neutral-800 text-sm mt-4">
          {users.map((u) => (
            <li key={u.id} className="p-2">
              <div className="grid grid-cols-[1fr_auto_auto] gap-2 items-center">
                <div>
                  <div className="font-medium">
                    {u.username}{" "}
                    <span className="text-neutral-500 font-normal">
                      · {prettyRole(u.role)}
                      {u.api_only && <span className="text-emerald-400"> · api-only</span>}
                      {u.disabled && <span className="text-amber-500"> · disabled</span>}
                    </span>
                  </div>
                  <div className="text-xs text-neutral-500">
                    created {new Date(u.created_at).toLocaleDateString()}
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <select
                    className="bg-neutral-900 border border-neutral-700 rounded px-2 py-0.5"
                    value={normaliseRole(u.role)}
                    disabled={update.isPending}
                    onChange={(e) =>
                      update.mutate({
                        id: u.id,
                        body: { role: e.target.value as "admin" | "viewer" },
                      })
                    }
                  >
                    <option value="admin">admin</option>
                    <option value="viewer">viewer</option>
                  </select>
                  <button
                    className={u.disabled ? "text-emerald-400 hover:underline" : "text-amber-400 hover:underline"}
                    onClick={() =>
                      update.mutate({ id: u.id, body: { disabled: !u.disabled } })
                    }
                  >
                    {u.disabled ? "enable" : "disable"}
                  </button>
                  {u.api_only ? (
                    <button
                      className="text-blue-400 hover:underline"
                      onClick={() =>
                        setShowTokensFor(showTokensFor === u.id ? null : u.id)
                      }
                    >
                      {showTokensFor === u.id ? "hide tokens" : "tokens"}
                    </button>
                  ) : (
                    <PasswordResetButton userID={u.id} />
                  )}
                </div>
                <button
                  className="text-xs text-red-400 hover:underline"
                  onClick={() => {
                    if (confirm(`delete user "${u.username}"?`)) del.mutate(u.id);
                  }}
                >
                  delete
                </button>
              </div>
              {showTokensFor === u.id && u.api_only && (
                <TokensPanel userID={u.id} />
              )}
            </li>
          ))}
        </ul>
      )}
      {update.isError && (
        <div className="text-red-400 text-xs mt-2">
          {String((update.error as Error)?.message ?? "update failed")}
        </div>
      )}
      {del.isError && (
        <div className="text-red-400 text-xs mt-2">
          {String((del.error as Error)?.message ?? "delete failed")}
        </div>
      )}
    </section>
  );
}

function prettyRole(r: string): string {
  // Legacy rows may have "superadmin"/"operator"/"guest"; show them as
  // they map to the handler-side gate.
  if (r === "superadmin" || r === "admin") return "admin";
  return "viewer";
}
function normaliseRole(r: string): "admin" | "viewer" {
  return prettyRole(r) as "admin" | "viewer";
}

function NewUserForm({ onCreated }: { onCreated: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "viewer">("viewer");
  const [apiOnly, setApiOnly] = useState(false);

  const create = useMutation({
    mutationFn: api.createUser,
    onSuccess: () => {
      onCreated();
      setUsername("");
      setPassword("");
      setRole("viewer");
      setApiOnly(false);
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    create.mutate({
      username: username.trim(),
      password: apiOnly ? undefined : password,
      role,
      api_only: apiOnly,
    });
  };

  return (
    <form onSubmit={submit} className="grid grid-cols-[1fr_1fr_8rem_auto_auto] gap-2 items-center">
      <input
        className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm"
        placeholder="Username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        required
      />
      <input
        className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm disabled:opacity-50"
        placeholder={apiOnly ? "(no password — api-only)" : "Password"}
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        disabled={apiOnly}
        required={!apiOnly}
      />
      <select
        className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-sm"
        value={role}
        onChange={(e) => setRole(e.target.value as "admin" | "viewer")}
      >
        <option value="viewer">viewer</option>
        <option value="admin">admin</option>
      </select>
      <label className="inline-flex items-center gap-1 text-xs text-neutral-400">
        <input
          type="checkbox"
          checked={apiOnly}
          onChange={(e) => setApiOnly(e.target.checked)}
        />
        api-only
      </label>
      <button
        type="submit"
        className="bg-blue-600 hover:bg-blue-500 rounded px-3 py-1 text-sm disabled:opacity-50"
        disabled={create.isPending}
      >
        {create.isPending ? "adding…" : "add user"}
      </button>
      {create.isError && (
        <span className="col-span-5 text-red-400 text-xs">
          {String((create.error as Error)?.message ?? "failed")}
        </span>
      )}
    </form>
  );
}

function PasswordResetButton({ userID }: { userID: string }) {
  const update = useMutation({
    mutationFn: ({ password }: { password: string }) =>
      api.updateUser(userID, { password }),
  });
  const reset = () => {
    const pw = prompt("New password (shown once — the user will need to re-login):");
    if (!pw) return;
    update.mutate({ password: pw });
  };
  return (
    <button
      className="text-blue-400 hover:underline"
      onClick={reset}
      disabled={update.isPending}
      title="Set a new password for this user"
    >
      {update.isPending ? "saving…" : "reset pw"}
    </button>
  );
}

function TokensPanel({ userID }: { userID: string }) {
  const qc = useQueryClient();
  const { data: tokens = [] } = useQuery({
    queryKey: ["tokens", userID],
    queryFn: () => api.listTokens(userID),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["tokens", userID] });
  const [name, setName] = useState("");
  const [justCreated, setJustCreated] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.createToken(userID, name.trim()),
    onSuccess: (res) => {
      setJustCreated(res.token);
      setName("");
      invalidate();
    },
  });
  const revoke = useMutation({
    mutationFn: (tokenID: string) => api.revokeToken(userID, tokenID),
    onSuccess: invalidate,
  });

  return (
    <div className="mt-2 ml-3 pl-3 border-l-2 border-neutral-800 space-y-2">
      <form
        className="flex items-center gap-2 text-xs"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <input
          className="bg-neutral-900 border border-neutral-700 rounded px-2 py-0.5 min-w-[14rem]"
          placeholder="Token name (e.g. grafana, home-assistant)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <button
          type="submit"
          className="bg-blue-600 hover:bg-blue-500 rounded px-2 py-0.5 disabled:opacity-50"
          disabled={create.isPending}
        >
          {create.isPending ? "creating…" : "create token"}
        </button>
      </form>
      {justCreated && (
        <div className="bg-emerald-950/60 border border-emerald-700 rounded p-2 text-xs">
          <div className="mb-1 text-emerald-200">
            New token — copy now, it will not be shown again.
          </div>
          <div className="flex items-center gap-2">
            <input
              readOnly
              className="flex-1 bg-neutral-900 border border-neutral-700 rounded px-2 py-1 font-mono text-xs"
              value={justCreated}
              onClick={(e) => (e.target as HTMLInputElement).select()}
            />
            <button
              className="bg-neutral-800 hover:bg-neutral-700 rounded px-2 py-1"
              onClick={() => {
                navigator.clipboard?.writeText(justCreated);
              }}
            >
              copy
            </button>
            <button
              className="text-neutral-400 hover:text-white"
              onClick={() => setJustCreated(null)}
            >
              dismiss
            </button>
          </div>
        </div>
      )}
      {tokens.length === 0 ? (
        <p className="text-xs text-neutral-500">No tokens yet.</p>
      ) : (
        <ul className="divide-y divide-neutral-800 rounded border border-neutral-800 text-xs">
          {tokens.map((t: APIToken) => (
            <li key={t.id} className="p-2 grid grid-cols-[1fr_auto_auto] gap-2 items-center">
              <div>
                <div className="font-medium">{t.name}</div>
                <div className="text-neutral-500">
                  created {new Date(t.created_at).toLocaleDateString()}
                  {t.last_used_at && (
                    <> · last used {new Date(t.last_used_at).toLocaleString()}</>
                  )}
                </div>
              </div>
              <button
                className="text-red-400 hover:underline"
                onClick={() => {
                  if (confirm(`revoke token "${t.name}"?`)) revoke.mutate(t.id);
                }}
              >
                revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

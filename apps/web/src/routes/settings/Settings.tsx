import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, DetectorSettings, NotificationChannel } from "@/lib/api";

export function Settings() {
  const { data: info } = useQuery({ queryKey: ["info"], queryFn: api.systemInfo });

  return (
    <div className="p-4 space-y-6 max-w-3xl">
      <Detector />

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

  // Seed local state from server once.
  useEffect(() => {
    if (current) {
      setVariant(current.yolo26_variant);
      setPrecision(current.yolo26_precision);
    }
  }, [current]);

  const save = useMutation({
    mutationFn: async () => {
      await api.updateDetectorSettings({ yolo26_variant: variant, yolo26_precision: precision });
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
    (variant !== current.yolo26_variant || precision !== current.yolo26_precision);

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
              FP16 (default)
            </label>
            <label className="inline-flex items-center gap-1">
              <input
                type="radio"
                name="precision"
                checked={precision === "int8"}
                onChange={() => setPrecision("int8")}
              />
              INT8 (~1.5–2× faster, first use triggers ~5 min calibration)
            </label>
          </div>
        </div>

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

        <PipelineStatusChip state={pipelineState?.state} />
      </div>
    </section>
  );
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

      <NewChannelForm onCreated={invalidate} />

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

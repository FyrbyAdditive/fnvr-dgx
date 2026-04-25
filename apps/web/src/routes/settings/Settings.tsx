import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, APIToken, ClassMutes as ClassMutesT, createDetectionClass, deleteDetectionClass, DetectionClass, DetectorSettings, fetchDetectionClasses, HAConfig, NotificationChannel, patchDetectionClass } from "@/lib/api";
import { loadCocoLabels, classCategory, CATEGORY_ORDER } from "@/lib/classes";
import { useMe } from "@/lib/me";

export function Settings() {
  const { data: info } = useQuery({ queryKey: ["info"], queryFn: api.systemInfo });
  const { data: me } = useMe();

  return (
    <div className="p-4 space-y-6 max-w-3xl">
      <Detector />
      {me?.is_admin && <PipelineTunables />}
      <ClassMutes />
      {me?.is_admin && <ClassesEditor />}

      {me?.is_admin && <Users />}
      {me?.is_admin && <HomeAssistant />}

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

// PipelineTunables are the small knobs that shape supervisor behaviour —
// no pipeline restart needed for a change to take effect (the supervisor
// re-reads them per worker respawn cycle).
function PipelineTunables() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["pipeline-startup-grace"],
    queryFn: api.getPipelineStartupGrace,
  });
  const [value, setValue] = useState<number | null>(null);
  useEffect(() => {
    if (data) setValue(data.startup_grace_sec);
  }, [data]);
  const save = useMutation({
    mutationFn: (n: number) => api.updatePipelineStartupGrace(n),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["pipeline-startup-grace"] }),
  });
  const dirty =
    value !== null && data !== undefined && value !== data.startup_grace_sec;
  return (
    <section>
      <h2 className="text-lg font-semibold mb-2">Pipeline tunables</h2>
      <div className="bg-neutral-900 rounded p-3 space-y-2 text-sm">
        <label className="flex items-center gap-3">
          <span className="w-56 text-neutral-400">Startup grace (seconds)</span>
          <input
            type="number"
            min={0}
            max={600}
            className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 w-24"
            value={value ?? 0}
            onChange={(e) => setValue(Math.max(0, Math.min(600, Number(e.target.value))))}
          />
          <button
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed rounded px-3 py-1 text-xs"
            disabled={!dirty || save.isPending}
            onClick={() => value !== null && save.mutate(value)}
          >
            {save.isPending ? "saving…" : "save"}
          </button>
        </label>
        <p className="text-xs text-neutral-500 pl-56">
          During this window after a worker (re)spawn, transient exits
          don't flip the UI banner to "pipeline failed" — gives
          slow-to-dial sources (MediaMTX-proxied, self-signed TLS,
          cold-boot cameras) time to settle. Default 60s. Set to 0 to
          fail fast.
        </p>
      </div>
    </section>
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
  const [faceId, setFaceId] = useState<boolean>(false);
  const [hailoVersion, setHailoVersion] = useState<string>("stock");

  // Seed local state from server once.
  useEffect(() => {
    if (current) {
      setVariant(current.yolo26_variant);
      setPrecision(current.yolo26_precision);
      setAnpr(!!current.anpr_enabled);
      setFaceId(!!current.face_id_enabled);
      setHailoVersion(current.hailo_model_version || "stock");
    }
  }, [current]);

  const save = useMutation({
    mutationFn: async () => {
      await api.updateDetectorSettings({
        yolo26_variant: variant,
        yolo26_precision: precision,
        anpr_enabled: anpr,
        face_id_enabled: faceId,
        hailo_model_version: hailoVersion,
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
      anpr !== !!current.anpr_enabled ||
      faceId !== !!current.face_id_enabled ||
      hailoVersion !== (current.hailo_model_version || "stock"));

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
            value={
              YOLO_VARIANTS.find((v) => v.value === variant)
                ? variant
                : "__custom__"
            }
            onChange={(e) => {
              const v = e.target.value;
              if (v === "__custom__") {
                // Switching to custom mode — preserve any
                // existing fnvr-vN value, default to fnvr-v1.
                setVariant(variant.startsWith("fnvr-") ? variant : "fnvr-v1");
              } else {
                setVariant(v);
              }
            }}
          >
            {YOLO_VARIANTS.map((v) => (
              <option key={v.value} value={v.value}>{v.label}</option>
            ))}
            <option value="__custom__">
              Custom fine-tuned (fnvr-v1, fnvr-v2, …)
            </option>
          </select>
        </div>

        {variant.startsWith("fnvr-") && (
          <div className="grid grid-cols-[8rem_1fr] items-center gap-2">
            <label className="text-neutral-400">Custom name</label>
            <input
              type="text"
              className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
              value={variant}
              placeholder="fnvr-v1"
              onChange={(e) => setVariant(e.target.value.trim().toLowerCase())}
            />
          </div>
        )}

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
              className="inline-flex items-center gap-1"
              title="Quantised to INT8 via offline trtexec calibration. Needs a batch of calibration images first — see the Calibration panel below. Quantised yolo26x roughly halves inference cost vs FP16."
            >
              <input
                type="radio"
                name="precision"
                checked={precision === "int8"}
                onChange={() => setPrecision("int8")}
              />
              INT8
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

        <div className="grid grid-cols-[8rem_1fr] items-center gap-2">
          <label className="text-neutral-400">Face ID</label>
          <label
            className="inline-flex items-center gap-2"
            title="Adds a YOLOv8-face detector + ArcFace R100 embedder after the object detector. Enrol + match persons from the Faces tab. Toggling restarts the pipeline."
          >
            <input
              type="checkbox"
              checked={faceId}
              onChange={(e) => setFaceId(e.target.checked)}
            />
            <span>Detect &amp; recognise faces (SCRFD-like + ArcFace)</span>
          </label>
        </div>

        <div className="grid grid-cols-[8rem_1fr] items-center gap-2">
          <label
            className="text-neutral-400"
            title="Which HEF the hailo-broker loads. 'stock' uses the Hailo Model Zoo's pre-compiled yolov11l (80 COCO classes). Set to a custom name like 'fnvr-v1' to load /var/lib/fnvr/models/hailo/fnvr-v1.hef from tools/compile-hef/. Missing files transparently fall back to stock."
          >
            Hailo model
          </label>
          <input
            type="text"
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
            value={hailoVersion}
            placeholder="stock"
            onChange={(e) => setHailoVersion(e.target.value.trim().toLowerCase())}
          />
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

        <CalibrationPanel isAdmin={isAdmin} precision={precision} />
      </div>
    </section>
  );
}

// CalibrationPanel drives the yolo26 INT8 calibration workflow:
// - sampler trigger ("Prepare calibration images from recent recordings")
// - image_count progress
// - last-run timestamp and last-error surface (from the entrypoint's
//   POST to /api/v1/internal/detector/calibration_report)
// - recalibrate + revert-to-FP16 escape hatches
function CalibrationPanel({
  isAdmin,
  precision,
}: {
  isAdmin: boolean;
  precision: DetectorSettings["yolo26_precision"];
}) {
  const qc = useQueryClient();
  const { data: cal } = useQuery({
    queryKey: ["calibration-status"],
    queryFn: api.getCalibrationStatus,
    // Poll while a job might be running — cheap, single settings row.
    refetchInterval: 2_000,
    refetchIntervalInBackground: false,
  });
  const prepare = useMutation({
    mutationFn: api.prepareCalibration,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["calibration-status"] }),
  });
  const target = 500;
  const count = cal?.image_count ?? 0;
  const pct = Math.min(100, Math.round((count / target) * 100));
  // Minimum the calibrator accepts (calibrate-yolo26.sh rejects
  // below this). Anything between min and target still works; more
  // frames → better quantisation but diminishing returns.
  const minCount = 100;
  const readyForCalibration = count >= minCount;
  // The sampler sets last_run only when finished. Treat a present
  // last_run as "job done". prepare.isPending covers the pre-first-
  // progress-write window right after the button is clicked.
  const samplerDone = !!cal?.last_run;
  return (
    <div className="border border-neutral-800 rounded p-3 space-y-2">
      <div className="flex items-baseline gap-3">
        <span className="font-medium text-sm">INT8 calibration</span>
        <span className="text-xs text-neutral-500">
          {precision === "int8"
            ? "Required for INT8 inference."
            : "Only relevant when precision is INT8."}
        </span>
      </div>
      <div className="text-xs text-neutral-400">
        Samples representative frames from your own recordings so
        quantisation matches deployment. INT8 then runs offline via
        trtexec on next pipeline restart.
      </div>
      <div className="flex items-center gap-3">
        <div className="flex-1 bg-neutral-900 rounded h-2 overflow-hidden">
          <div
            className={`h-full transition-all ${
              readyForCalibration ? "bg-emerald-600" : "bg-blue-600"
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="text-xs text-neutral-400 w-20 text-right">
          {count}
          {samplerDone ? " ready" : ` / ${target}`}
        </span>
      </div>
      {readyForCalibration && samplerDone && (
        <div className="text-xs text-emerald-400">
          {count} frames ready — enough to calibrate (minimum {minCount}).
          Flip the precision to INT8 above and Save to run trtexec.
        </div>
      )}
      {!readyForCalibration && count > 0 && cal?.last_run && (
        <div className="text-xs text-amber-400">
          Only {count} frames — need ≥{minCount}. This usually means
          the cameras haven't been recording long enough. Try again
          later or check recent recording history.
        </div>
      )}
      {cal?.last_run && (
        <div className="text-xs text-neutral-500">
          Last calibration attempt: {new Date(cal.last_run).toLocaleString()}
          {cal.engine_size
            ? ` · engine ${(cal.engine_size / (1024 * 1024)).toFixed(0)} MB`
            : ""}
          {cal.table_sha256
            ? ` · sha256:${cal.table_sha256.slice(0, 8)}…`
            : ""}
        </div>
      )}
      {cal?.last_error && (
        <pre className="text-xs bg-red-950/50 border border-red-900 rounded p-2 text-red-200 overflow-auto max-h-32 whitespace-pre-wrap">
          {cal.last_error}
        </pre>
      )}
      {isAdmin && (
        <div className="flex gap-2 pt-1">
          <button
            className="bg-blue-600 hover:bg-blue-500 rounded px-3 py-1 text-xs disabled:opacity-50"
            disabled={prepare.isPending}
            onClick={() => prepare.mutate()}
            title="Samples ~500 JPEGs from recent mp4 recordings into /var/lib/fnvr/models/yolo26/calib_images/"
          >
            {prepare.isPending
              ? "Starting…"
              : count > 0
                ? "Re-sample calibration images"
                : "Prepare calibration images"}
          </button>
          {prepare.isError && (
            <span className="text-red-400 text-xs self-center">
              {String((prepare.error as Error)?.message ?? "failed")}
            </span>
          )}
        </div>
      )}
    </div>
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
    onSuccess: () => {
      onCreated();
      setName("");
      setWebhookUrl("");
      setNtfyTopic("");
      setMqttUser("");
      setMqttPass("");
    },
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

// Home Assistant bridge settings. Admin-only. Saving reloads the
// dispatcher's bridge within ~30s (it polls ha.config that often);
// no explicit restart button needed.
function HomeAssistant() {
  const qc = useQueryClient();
  const { data: server } = useQuery({
    queryKey: ["ha-config"],
    queryFn: api.getHAConfig,
  });

  const [local, setLocal] = useState<HAConfig | null>(null);
  useEffect(() => {
    if (server && !local) setLocal(server);
  }, [server, local]);

  const save = useMutation({
    mutationFn: (c: HAConfig) => api.updateHAConfig(c),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ha-config"] }),
  });

  if (!local) {
    return (
      <section>
        <h2 className="text-lg font-semibold mb-2">Home Assistant</h2>
        <p className="text-sm text-neutral-500">Loading…</p>
      </section>
    );
  }

  const patch = (p: Partial<HAConfig>) => setLocal({ ...local, ...p });
  const dirty = !!server && JSON.stringify(local) !== JSON.stringify(server);

  return (
    <section>
      <h2 className="text-lg font-semibold mb-2">Home Assistant</h2>
      <p className="text-sm text-neutral-500 mb-3">
        Publishes every camera as a Home Assistant device via MQTT
        auto-discovery. HA picks up motion, incident, last-class,
        last-confidence, last-plate, and camera-state entities per
        camera. Changes take effect within 30 seconds of Save.
      </p>

      <div className="grid gap-2 text-sm">
        <label className="inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={local.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          Enable bridge
        </label>
        <div className="grid grid-cols-[10rem_1fr] items-center gap-2">
          <label className="text-neutral-400">Broker URL</label>
          <input
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
            value={local.broker_url}
            onChange={(e) => patch({ broker_url: e.target.value })}
            placeholder="tcp://mosquitto:1883"
          />
        </div>
        <div className="grid grid-cols-[10rem_1fr] items-center gap-2">
          <label className="text-neutral-400">Username</label>
          <input
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
            value={local.username}
            onChange={(e) => patch({ username: e.target.value })}
          />
        </div>
        <div className="grid grid-cols-[10rem_1fr] items-center gap-2">
          <label className="text-neutral-400">Password</label>
          <input
            type="password"
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
            value={local.password}
            onChange={(e) => patch({ password: e.target.value })}
            placeholder="unchanged"
          />
        </div>
        <div className="grid grid-cols-[10rem_1fr] items-center gap-2">
          <label className="text-neutral-400">Discovery prefix</label>
          <input
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
            value={local.discovery_prefix}
            onChange={(e) => patch({ discovery_prefix: e.target.value })}
          />
        </div>
        <div className="grid grid-cols-[10rem_1fr] items-center gap-2">
          <label className="text-neutral-400">Topic prefix</label>
          <input
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
            value={local.topic_prefix}
            onChange={(e) => patch({ topic_prefix: e.target.value })}
          />
        </div>
        <div>
          <button
            className="bg-blue-600 hover:bg-blue-500 rounded px-3 py-1 text-sm disabled:opacity-50"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate(local)}
          >
            {save.isPending ? "Saving…" : dirty ? "Save" : "No changes"}
          </button>
          {save.isError && (
            <span className="text-red-400 text-xs ml-3">
              {String((save.error as Error)?.message ?? "failed")}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

// ClassesEditor lets admins curate the detection class taxonomy:
// disable COCO classes the site doesn't care about, add custom
// classes (e.g. "parcel", "amazon-van"), rename display labels.
//
// Disabling a class hides it from the relabel dropdown and excludes
// it from the regenerated dataset.yaml. The numeric yolo_id is
// immutable — already-written label files still resolve correctly.
function ClassesEditor() {
  const qc = useQueryClient();
  const { data: classes = [], isLoading } = useQuery({
    queryKey: ["detection-classes"],
    queryFn: fetchDetectionClasses,
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      patchDetectionClass(id, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["detection-classes"] }),
  });
  const create = useMutation({
    mutationFn: ({ slug, displayName }: { slug: string; displayName: string }) =>
      createDetectionClass(slug, displayName),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["detection-classes"] }),
  });
  const remove = useMutation({
    mutationFn: (id: number) => deleteDetectionClass(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["detection-classes"] }),
  });

  // Group COCO seeds by category for readability; custom classes go in
  // their own bucket pinned at the top.
  const buckets = useMemo(() => {
    const out: Record<string, DetectionClass[]> = { Custom: [] };
    for (const c of classes) {
      if (c.origin === "custom") out.Custom.push(c);
      else {
        const cat = classCategory(c.slug);
        (out[cat] ??= []).push(c);
      }
    }
    for (const k of Object.keys(out)) {
      out[k].sort((a, b) => a.display_name.localeCompare(b.display_name));
    }
    return out;
  }, [classes]);

  const enabledCount = classes.filter((c) => c.enabled).length;

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Detection classes</h2>
      <p className="text-sm text-neutral-400 max-w-2xl">
        The taxonomy your detector recognises. Tick the classes that
        matter for your site; disabled classes are hidden from the
        Live-tab relabel picker and excluded from the YOLO dataset.yaml
        the next training pass consumes. Custom classes you add here
        will be detected once a fine-tuned model is trained on labelled
        samples.
      </p>
      <div className="text-xs text-neutral-500">
        {enabledCount} of {classes.length} classes enabled
      </div>

      {isLoading && <div className="text-neutral-500">loading…</div>}

      {!isLoading && (
        <>
          <NewClassForm
            onSubmit={(slug, name) => create.mutate({ slug, displayName: name })}
            error={create.isError ? String((create.error as Error)?.message) : null}
          />

          {/* Custom bucket first (most relevant), then COCO categories
              in their established order. */}
          {(["Custom", ...CATEGORY_ORDER] as const).map((cat) => {
            const items = buckets[cat] ?? [];
            if (cat !== "Custom" && items.length === 0) return null;
            if (cat === "Custom" && items.length === 0) return null;
            return (
              <div key={cat} className="space-y-1">
                <div className="text-xs uppercase tracking-wide text-neutral-500 mt-3">
                  {cat}
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1">
                  {items.map((c) => (
                    <ClassRow
                      key={c.id}
                      c={c}
                      onToggle={(enabled) =>
                        toggle.mutate({ id: c.id, enabled })
                      }
                      onDelete={
                        c.origin === "custom"
                          ? () => remove.mutate(c.id)
                          : undefined
                      }
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </>
      )}
    </section>
  );
}

function ClassRow({
  c,
  onToggle,
  onDelete,
}: {
  c: DetectionClass;
  onToggle: (enabled: boolean) => void;
  onDelete?: () => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm py-0.5 group">
      <input
        type="checkbox"
        className="accent-blue-500"
        checked={c.enabled}
        onChange={(e) => onToggle(e.target.checked)}
      />
      <span className={c.enabled ? "" : "text-neutral-500"}>
        {c.display_name}
      </span>
      <span className="text-[10px] text-neutral-600">#{c.yolo_id}</span>
      {onDelete && (
        <button
          className="opacity-0 group-hover:opacity-100 text-[10px] text-red-400 hover:text-red-300 ml-auto"
          title="Delete custom class (only if no flagged samples)"
          onClick={(e) => {
            e.preventDefault();
            if (window.confirm(`Delete custom class "${c.display_name}"?`)) {
              onDelete();
            }
          }}
        >
          delete
        </button>
      )}
    </label>
  );
}

function NewClassForm({
  onSubmit,
  error,
}: {
  onSubmit: (slug: string, displayName: string) => void;
  error: string | null;
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
        disabled={!slug.trim()}
      >
        add
      </button>
      {error && <span className="text-red-400">{error}</span>}
    </form>
  );
}

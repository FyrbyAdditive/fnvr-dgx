import { FormEvent, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, Camera } from "@/lib/api";
import { loadCocoLabels } from "@/lib/classes";
import { useMe } from "@/lib/me";
import { ZoneEditor } from "./ZoneEditor";
import { CameraToggle } from "@/components/CameraToggle";


type Kind = "rtsp" | "v4l2" | "rtmp" | "http";

export function Cameras() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const isAdmin = !!me?.is_admin;
  const { data: cameras = [] } = useQuery({ queryKey: ["cameras"], queryFn: api.listCameras });
  const { data: devices = [] } = useQuery({
    queryKey: ["local-devices"],
    queryFn: api.listLocalDevices,
    staleTime: 30_000,
    retry: false,
  });

  const create = useMutation({
    mutationFn: api.createCamera,
    onSuccess: () => {
      setName("");
      setRtspUrl("");
      setDevice("");
      qc.invalidateQueries({ queryKey: ["cameras"] });
    },
  });
  const remove = useMutation({
    mutationFn: api.deleteCamera,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cameras"] }),
  });

  const [kind, setKind] = useState<Kind>("rtsp");
  const [name, setName] = useState("");
  const [rtspUrl, setRtspUrl] = useState("");
  const [device, setDevice] = useState("");

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    let url = "";
    if (kind === "rtsp" || kind === "rtmp" || kind === "http") {
      url = rtspUrl.trim();
    } else {
      url = `v4l2://${device}`;
    }
    if (!name.trim() || !url) return;
    create.mutate({ name: name.trim(), url });
  }

  return (
    <div className="p-4 space-y-6 max-w-4xl">
      {isAdmin && (
        <section>
          <h2 className="text-lg font-semibold mb-2">Add camera</h2>

          <div className="flex gap-1 mb-3 text-sm">
            {(["rtsp", "v4l2", "rtmp", "http"] as Kind[]).map((k) => (
              <button key={k} type="button"
                className={`px-3 py-1 rounded ${
                  kind === k ? "bg-neutral-800 text-white" : "text-neutral-400 hover:bg-neutral-900"
                }`}
                onClick={() => setKind(k)}>
                {kindLabel(k)}
              </button>
            ))}
          </div>

          <form onSubmit={onSubmit} className="space-y-2 text-sm">
            <input className="w-full bg-neutral-900 rounded px-3 py-2" placeholder="Display name (e.g. Front door)"
              value={name} onChange={(e) => setName(e.target.value)} required />

            {kind === "v4l2" ? (
              <select className="w-full bg-neutral-900 rounded px-3 py-2"
                value={device} onChange={(e) => setDevice(e.target.value)} required>
                <option value="">— select a device —</option>
                {devices.map((d) => (
                  <option key={d.path} value={d.path}>
                    {d.label} ({d.path})
                  </option>
                ))}
                {devices.length === 0 && <option disabled>No local cameras detected</option>}
              </select>
            ) : (
              <input className="w-full bg-neutral-900 rounded px-3 py-2" placeholder={placeholderFor(kind)}
                value={rtspUrl} onChange={(e) => setRtspUrl(e.target.value)} required />
            )}

            <button type="submit" className="w-full bg-blue-600 hover:bg-blue-500 rounded px-3 py-2"
              disabled={create.isPending}>
              {create.isPending ? "Adding…" : "Add camera"}
            </button>
            {create.isError && (
              <div className="text-red-400 text-xs">
                {String((create.error as any)?.message ?? "Could not save camera")}
              </div>
            )}
          </form>
        </section>
      )}

      <section>
        <h2 className="text-lg font-semibold mb-2">
          Cameras <span className="text-neutral-500 text-sm">({cameras.length})</span>
        </h2>
        {cameras.length === 0 ? (
          <div className="text-neutral-500 text-sm">None yet.</div>
        ) : (
          <ul className="divide-y divide-neutral-800 rounded border border-neutral-800">
            {cameras.map((c: Camera) => (
              <CameraRow
                key={c.id}
                camera={c}
                isAdmin={isAdmin}
                onDelete={() => remove.mutate(c.id)}
              />
            ))}
          </ul>
        )}
        {remove.isError && (
          <div className="text-red-400 text-xs mt-2">
            {String((remove.error as any)?.message ?? "Could not delete")}
          </div>
        )}
      </section>
    </div>
  );
}

function CameraRow({ camera, isAdmin, onDelete }: { camera: Camera; isAdmin: boolean; onDelete: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const qc = useQueryClient();
  return (
    <li className="text-sm">
      <div className="p-3 flex items-center gap-3">
        <button
          className="text-neutral-500 hover:text-white text-xs w-4"
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? "hide details" : "show details"}
        >
          {expanded ? "▾" : "▸"}
        </button>
        <div className="flex-1 min-w-0">
          <div className="font-medium">{camera.name}</div>
          <div className="text-xs text-neutral-500 truncate">
            {camera.id} · {camera.url}
          </div>
        </div>
        {isAdmin && (
          <>
            <CameraToggle
              cameraId={camera.id}
              enabled={camera.enabled}
              onChange={() => qc.invalidateQueries({ queryKey: ["cameras"] })}
            />
            <button
              className="text-xs text-red-400 hover:underline"
              onClick={onDelete}
            >
              delete
            </button>
          </>
        )}
      </div>
      {expanded && isAdmin && (
        <div className="px-3 pb-3 space-y-3">
          <BasicsEditor camera={camera} />
          <LocationAndOverrides camera={camera} />
          <DetectorToggle camera={camera} />
          <DetectorBackendSelect camera={camera} />
          <RotationSelect camera={camera} />
          <MtxProxyToggle camera={camera} />
          <ZoneEditor cameraId={camera.id} cameraName={camera.name} />
        </div>
      )}
    </li>
  );
}

const DETECTOR_KINDS: { value: string; label: string }[] = [
  { value: "object", label: "object detection" },
  { value: "anpr", label: "number plates (ANPR)" },
  { value: "face", label: "face ID" },
];

function DetectorToggle({ camera }: { camera: Camera }) {
  const qc = useQueryClient();
  // enabled_detectors encoding:
  //   []         → all enabled (default)
  //   ["none"]   → explicitly none enabled
  //   ["object", ...] → whitelist
  const stored = camera.enabled_detectors ?? [];
  const isNone = stored.length === 1 && stored[0] === "none";
  const allEnabled = stored.length === 0;
  const current = isNone
    ? new Set<string>()
    : allEnabled
      ? new Set(DETECTOR_KINDS.map((k) => k.value))
      : new Set(stored.filter((k) => k !== "none"));

  const update = useMutation({
    mutationFn: (kinds: string[]) => api.updateCameraDetectors(camera.id, { enabled_detectors: kinds }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cameras"] }),
  });

  const toggle = (kind: string) => {
    const next = new Set(current);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    // Encode:
    //   all known kinds selected → [] (forward-compatible default)
    //   zero kinds selected → ["none"] (explicit opt-out)
    //   subset → the list
    const arr =
      next.size === DETECTOR_KINDS.length
        ? []
        : next.size === 0
          ? ["none"]
          : Array.from(next);
    update.mutate(arr);
  };

  return (
    <div className="pl-3 border-l-2 border-neutral-800">
      <div className="text-xs text-neutral-400 mb-1">
        Detectors enabled on this camera
        {allEnabled && <span className="text-neutral-600"> · all</span>}
        {isNone && <span className="text-neutral-600"> · none</span>}
      </div>
      <div className="flex flex-wrap gap-3 text-xs">
        {DETECTOR_KINDS.map((k) => (
          <label key={k.value} className="inline-flex items-center gap-1">
            <input
              type="checkbox"
              checked={current.has(k.value)}
              disabled={update.isPending}
              onChange={() => toggle(k.value)}
            />
            {k.label}
          </label>
        ))}
      </div>
    </div>
  );
}

// RotationSelect picks a clockwise software rotation (0/90/180/270) for
// cameras that can't be physically reoriented. Any non-zero value forces
// the pipeline onto the transcode path (decode + nvvideoconvert flip +
// re-encode), so leave at 0 unless needed.
// BasicsEditor lets an admin rename a camera and/or change its RTSP URL
// in place — preserving the camera id (and therefore its rules, zones,
// and historical detections). Save is disabled until something's
// actually changed so a hover over the expand panel doesn't fire a
// pointless round-trip.
function BasicsEditor({ camera }: { camera: Camera }) {
  const qc = useQueryClient();
  const [name, setName] = useState(camera.name);
  const [url, setUrl] = useState(camera.url);
  const [err, setErr] = useState<string | null>(null);
  // Reset local state when the upstream camera row changes (e.g. another
  // client edits it, or an unrelated invalidate refetches).
  useEffect(() => {
    setName(camera.name);
    setUrl(camera.url);
  }, [camera.name, camera.url]);
  const save = useMutation({
    mutationFn: () => {
      const body: { name?: string; url?: string } = {};
      if (name !== camera.name) body.name = name;
      if (url !== camera.url) body.url = url;
      return api.updateCameraBasics(camera.id, body);
    },
    onSuccess: () => {
      setErr(null);
      qc.invalidateQueries({ queryKey: ["cameras"] });
    },
    onError: (e) => setErr((e as Error)?.message ?? "save failed"),
  });
  const dirty = name !== camera.name || url !== camera.url;
  return (
    <div className="pl-3 border-l-2 border-neutral-800 space-y-1">
      <div className="text-xs text-neutral-400 mb-1">Basics</div>
      <div className="flex flex-col gap-1 text-xs">
        <label className="flex items-center gap-2">
          <span className="w-10 text-neutral-500">name</span>
          <input
            className="flex-1 bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={save.isPending}
          />
        </label>
        <label className="flex items-center gap-2">
          <span className="w-10 text-neutral-500">url</span>
          <input
            className="flex-1 bg-neutral-900 border border-neutral-700 rounded px-2 py-1 font-mono"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={save.isPending}
          />
        </label>
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed rounded px-3 py-1"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "saving…" : "save"}
          </button>
          {dirty && !save.isPending && (
            <button
              type="button"
              className="text-neutral-400 hover:text-white"
              onClick={() => {
                setName(camera.name);
                setUrl(camera.url);
                setErr(null);
              }}
            >
              reset
            </button>
          )}
          {err && <span className="text-red-400">{err}</span>}
          <span className="text-neutral-600 ml-auto">id: {camera.id}</span>
        </div>
      </div>
    </div>
  );
}

// DetectorBackendSelect picks which inference engine runs this
// camera's primary object detector (PGIE). "TensorRT (GPU)" is the
// existing DeepStream nvinfer path; "Hailo-8 (PCIe)" offloads to the
// Hailo accelerator, freeing GPU for SGIEs + encode. The Hailo option
// is only enabled when /dev/hailo0 is reachable from the api-server
// container (host driver + HailoRT installed + bind-mounted in).
function DetectorBackendSelect({ camera }: { camera: Camera }) {
  const qc = useQueryClient();
  const { data: hailo } = useQuery({
    queryKey: ["system-hailo"],
    queryFn: api.getHailoStatus,
    // This rarely changes — polling every 30s is plenty, and it's
    // cheap (single syscall inside the container).
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
  const current = camera.detector_backend ?? "trt";
  const update = useMutation({
    mutationFn: (backend: "trt" | "hailo") =>
      api.updateCameraDetectorBackend(camera.id, backend),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cameras"] }),
  });
  const hailoPresent = hailo?.present ?? false;
  return (
    <div className="pl-3 border-l-2 border-neutral-800">
      <div className="text-xs text-neutral-400 mb-1">Detector backend</div>
      <div className="flex items-center gap-2 text-xs">
        <select
          className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
          value={current}
          disabled={update.isPending}
          onChange={(e) =>
            update.mutate(e.target.value as "trt" | "hailo")
          }
        >
          <option value="trt">TensorRT (GPU)</option>
          <option value="hailo" disabled={!hailoPresent}>
            Hailo-8 (PCIe){hailoPresent ? "" : " — not detected"}
          </option>
        </select>
        {current === "hailo" && (
          <span className="text-neutral-500">
            primary detector offloaded to Hailo-8
          </span>
        )}
      </div>
    </div>
  );
}

function RotationSelect({ camera }: { camera: Camera }) {
  const qc = useQueryClient();
  const current = camera.rotation ?? 0;
  const update = useMutation({
    mutationFn: (rotation: 0 | 90 | 180 | 270) =>
      api.updateCameraRotation(camera.id, rotation),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cameras"] }),
  });
  return (
    <div className="pl-3 border-l-2 border-neutral-800">
      <div className="text-xs text-neutral-400 mb-1">Rotation</div>
      <div className="flex items-center gap-2 text-xs">
        <select
          className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
          value={current}
          disabled={update.isPending}
          onChange={(e) =>
            update.mutate(Number(e.target.value) as 0 | 90 | 180 | 270)
          }
        >
          <option value={0}>0°</option>
          <option value={90}>90° (clockwise)</option>
          <option value={180}>180°</option>
          <option value={270}>270° (counterclockwise)</option>
        </select>
        {current !== 0 && (
          <span className="text-neutral-500">
            transcode path (decode + NVENC)
          </span>
        )}
      </div>
    </div>
  );
}

// MtxProxyToggle routes the pipeline worker through the local MediaMTX
// re-muxer instead of pulling the source URL directly. Useful for
// broken RTSP streams (corrupt H.264 / bad NAL framing) where MediaMTX
// re-normalises the bitstream before we record or decode it. Only
// rendered for no-AI cameras since NVDEC is already tolerant enough for
// detection paths.
function MtxProxyToggle({ camera }: { camera: Camera }) {
  const qc = useQueryClient();
  const stored = camera.enabled_detectors ?? [];
  const isNoAI = stored.length === 1 && stored[0] === "none";
  const current = !!camera.mtx_proxy;
  const pinned = !!camera.mtx_tls_fingerprint;
  const isRtsps = camera.url.startsWith("rtsps://");
  const update = useMutation({
    mutationFn: (enabled: boolean) =>
      api.updateCameraMtxProxy(camera.id, enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cameras"] }),
  });
  const tlsIgnore = useMutation({
    mutationFn: (ignore: boolean) =>
      api.updateCameraMtxTLSIgnore(camera.id, ignore),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cameras"] }),
    onError: (e) =>
      alert(
        `couldn't probe TLS cert: ${e instanceof Error ? e.message : String(e)}`,
      ),
  });
  if (!isNoAI) return null;
  return (
    <div className="pl-3 border-l-2 border-neutral-800">
      <div className="text-xs text-neutral-400 mb-1">MediaMTX re-muxer</div>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={current}
          disabled={update.isPending}
          onChange={(e) => update.mutate(e.target.checked)}
        />
        <span>
          Route source through MediaMTX
          <span className="text-neutral-600">
            {" "}
            · laundering for broken RTSP streams
          </span>
        </span>
      </label>
      {current && (
        <>
          <div className="mt-1 text-[11px] text-neutral-500 font-mono">
            pipeline pulls: rtsp://mediamtx:8554/proxy_{camera.id}
          </div>
          {isRtsps && (
            <label className="mt-2 flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={pinned}
                disabled={tlsIgnore.isPending}
                onChange={(e) => tlsIgnore.mutate(e.target.checked)}
              />
              <span>
                Ignore certificate
                <span className="text-neutral-600">
                  {" "}
                  · pin to the current cert (self-signed / no-SAN devices)
                </span>
              </span>
            </label>
          )}
          {pinned && camera.mtx_tls_fingerprint && (
            <div className="mt-1 text-[10px] text-neutral-600 font-mono break-all">
              pinned: {camera.mtx_tls_fingerprint}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// LocationAndOverrides bundles the per-camera bits of the class-mute
// hierarchy: which bucket (indoor/outdoor/none) applies, plus two chip-
// input lists that add or subtract from the resolved mute set.
function LocationAndOverrides({ camera }: { camera: Camera }) {
  const qc = useQueryClient();
  const { data: globalMutes } = useQuery({
    queryKey: ["class-mutes"],
    queryFn: api.getClassMutes,
  });
  const [labels, setLabels] = useState<string[]>([]);
  useEffect(() => {
    loadCocoLabels().then(setLabels);
  }, []);

  // Pipeline workers snapshot muted_classes at spawn, so a change only
  // stops muted bboxes from reaching Live after a restart. We PATCH
  // immediately (so sidecar/PG side picks up via the 30s reload) but
  // defer the expensive restart to an explicit Apply — chip-editing
  // otherwise fires a 10s video gap per click.
  const [hasEdits, setHasEdits] = useState(false);

  const patch = useMutation({
    mutationFn: (body: Parameters<typeof api.updateCameraClasses>[1]) =>
      api.updateCameraClasses(camera.id, body),
    onSuccess: () => {
      setHasEdits(true);
      qc.invalidateQueries({ queryKey: ["cameras"] });
    },
  });

  const restart = useMutation({
    mutationFn: () => api.restartPipeline(),
    onSuccess: () => {
      setHasEdits(false);
      qc.invalidateQueries({ queryKey: ["pipeline-state"] });
    },
  });

  const loc = (camera.location_kind ?? "") as "" | "indoor" | "outdoor";
  const muteOv = camera.mute_classes_override ?? [];
  const unmuteOv = camera.unmute_classes_override ?? [];

  // Classes muted by inheritance for this camera (global + the location
  // bucket). These are the candidates the operator can re-enable.
  const inherited = useMemo(() => {
    if (!globalMutes) return [];
    const set = new Set<string>(globalMutes.global);
    if (loc === "indoor") for (const c of globalMutes.indoor) set.add(c);
    if (loc === "outdoor") for (const c of globalMutes.outdoor) set.add(c);
    return Array.from(set).sort();
  }, [globalMutes, loc]);

  const setLoc = (next: "" | "indoor" | "outdoor") =>
    patch.mutate({ location_kind: next });

  const toggleMute = (cls: string) => {
    const next = muteOv.includes(cls)
      ? muteOv.filter((c) => c !== cls)
      : [...muteOv, cls].sort();
    patch.mutate({ mute_classes_override: next });
  };
  const toggleUnmute = (cls: string) => {
    const next = unmuteOv.includes(cls)
      ? unmuteOv.filter((c) => c !== cls)
      : [...unmuteOv, cls].sort();
    patch.mutate({ unmute_classes_override: next });
  };

  return (
    <div className="pl-3 border-l-2 border-neutral-800 space-y-2">
      {hasEdits && (
        <div className="flex items-center gap-2 text-xs bg-amber-900/30 border border-amber-700/40 rounded px-2 py-1">
          <span className="text-amber-200">
            Pipeline restart needed for Live bboxes to reflect these changes.
          </span>
          <button
            className="ml-auto bg-amber-700 hover:bg-amber-600 rounded px-2 py-0.5"
            disabled={restart.isPending}
            onClick={() => restart.mutate()}
          >
            {restart.isPending ? "Restarting…" : "Restart pipeline"}
          </button>
        </div>
      )}
      <div className="flex items-center gap-2 text-xs">
        <span className="text-neutral-400">Location</span>
        <select
          className="bg-neutral-900 border border-neutral-700 rounded px-2 py-0.5"
          value={loc}
          onChange={(e) => setLoc(e.target.value as "" | "indoor" | "outdoor")}
          disabled={patch.isPending}
        >
          <option value="">— none —</option>
          <option value="indoor">indoor</option>
          <option value="outdoor">outdoor</option>
        </select>
        <span className="text-neutral-600">
          picks which class-mute bucket applies here
        </span>
      </div>

      <ChipPicker
        title="Also mute on this camera"
        hint="Classes added only for this camera, on top of global/location."
        selected={muteOv}
        candidates={labels}
        onToggle={toggleMute}
        disabled={patch.isPending}
      />

      {inherited.length > 0 && (
        <ChipPicker
          title="Re-enable from inherited"
          hint={`Classes currently muted by global${loc ? `/${loc}` : ""} that this camera should still see.`}
          selected={unmuteOv}
          candidates={inherited}
          onToggle={toggleUnmute}
          disabled={patch.isPending}
        />
      )}
    </div>
  );
}

// ChipPicker is a generic "show selected as chips, plus a datalist input
// to add". Enter key or blur commits. Clicking a chip toggles it off.
// Kept local to Cameras.tsx since it's only used here.
function ChipPicker({
  title,
  hint,
  selected,
  candidates,
  onToggle,
  disabled,
}: {
  title: string;
  hint: string;
  selected: string[];
  candidates: string[];
  onToggle: (cls: string) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const listId = `chips-${title.replace(/\s+/g, "-")}`;
  const commit = () => {
    const v = draft.trim();
    if (!v) return;
    if (!candidates.includes(v)) {
      // Allow anyway — operators may mute classes a future model has,
      // or COCO class names we don't know about. Harmless no-op if so.
    }
    onToggle(v);
    setDraft("");
  };
  return (
    <div>
      <div className="text-xs text-neutral-400 mb-1">
        {title} <span className="text-neutral-600">· {hint}</span>
      </div>
      <div className="flex flex-wrap gap-1 items-center">
        {selected.map((c) => (
          <button
            key={c}
            className="text-xs bg-neutral-800 hover:bg-red-900 rounded px-2 py-0.5"
            disabled={disabled}
            onClick={() => onToggle(c)}
            title="remove"
          >
            {c} ✕
          </button>
        ))}
        <input
          className="text-xs bg-neutral-900 border border-neutral-700 rounded px-2 py-0.5 min-w-[10rem]"
          placeholder="add class…"
          list={listId}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
          onBlur={commit}
          disabled={disabled}
        />
        <datalist id={listId}>
          {candidates
            .filter((c) => !selected.includes(c))
            .map((c) => (
              <option key={c} value={c} />
            ))}
        </datalist>
      </div>
    </div>
  );
}

function kindLabel(k: Kind) {
  return { rtsp: "RTSP", v4l2: "Local / USB", rtmp: "RTMP", http: "HTTP/MJPEG" }[k];
}
function placeholderFor(k: Kind) {
  return {
    rtsp: "rtsp://user:pass@10.0.0.42:554/…",
    rtmp: "rtmp://host/app/stream",
    http: "http://host/mjpg/video.mjpg",
    v4l2: "",
  }[k];
}

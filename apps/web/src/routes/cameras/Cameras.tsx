import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, Camera } from "@/lib/api";

type Kind = "rtsp" | "v4l2" | "rtmp" | "http";

export function Cameras() {
  const qc = useQueryClient();
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
    <div className="p-4 space-y-6 max-w-3xl">
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

      <section>
        <h2 className="text-lg font-semibold mb-2">
          Cameras <span className="text-neutral-500 text-sm">({cameras.length})</span>
        </h2>
        {cameras.length === 0 ? (
          <div className="text-neutral-500 text-sm">None yet.</div>
        ) : (
          <ul className="divide-y divide-neutral-800 rounded border border-neutral-800">
            {cameras.map((c: Camera) => (
              <li key={c.id} className="p-3 flex items-center gap-3 text-sm">
                <div className="flex-1 min-w-0">
                  <div className="font-medium">{c.name}</div>
                  <div className="text-xs text-neutral-500 truncate">
                    {c.id} · {c.url}
                  </div>
                </div>
                <button className="text-xs text-red-400 hover:underline"
                  onClick={() => remove.mutate(c.id)}>delete</button>
              </li>
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

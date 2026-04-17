import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useRecentDetections } from "@/lib/events";

export function Live() {
  const { data: cameras = [] } = useQuery({ queryKey: ["cameras"], queryFn: api.listCameras });
  const events = useRecentDetections(50);

  const byCamera = useMemo(() => {
    const m = new Map<string, (typeof events)[number][]>();
    for (const e of events) {
      const arr = m.get(e.camera_id) ?? [];
      arr.push(e);
      m.set(e.camera_id, arr);
    }
    return m;
  }, [events]);

  const grid =
    cameras.length <= 1 ? "grid-cols-1" :
    cameras.length <= 4 ? "grid-cols-2" :
    cameras.length <= 9 ? "grid-cols-3" :
    "grid-cols-4";

  return (
    <div className="p-4 h-full">
      {cameras.length === 0 ? (
        <EmptyState />
      ) : (
        <div className={`grid gap-2 ${grid} h-full`}>
          {cameras.map((c) => {
            const last = byCamera.get(c.id)?.[0];
            return (
              <CameraTile key={c.id} id={c.id} name={c.name} lastDetection={last} />
            );
          })}
        </div>
      )}
    </div>
  );
}

function CameraTile({ id, name, lastDetection }: {
  id: string;
  name: string;
  lastDetection?: { class_name: string; confidence: number };
}) {
  // Refresh the snapshot every second — pipeline writes a 1 fps JPEG ring
  // so that's the realistic update rate. Server caches for 1s to keep load
  // bounded when the mosaic has many tiles.
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    const h = setInterval(() => setT(Date.now()), 1000);
    return () => clearInterval(h);
  }, []);
  const src = `/api/v1/cameras/${encodeURIComponent(id)}/snapshot.jpg?t=${t}`;

  const [ok, setOk] = useState(true);
  useEffect(() => { setOk(true); }, [id]);

  return (
    <div className="bg-neutral-900 rounded aspect-video relative overflow-hidden">
      {ok ? (
        <img
          src={src}
          alt={name}
          className="absolute inset-0 w-full h-full object-cover"
          onError={() => setOk(false)}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-neutral-600 text-sm">
          No recording yet
        </div>
      )}
      <div className="absolute bottom-2 left-2 text-xs bg-black/60 px-2 py-0.5 rounded">
        {name}
      </div>
      {lastDetection && (
        <div className="absolute top-2 right-2 text-xs bg-blue-600/80 px-2 py-0.5 rounded">
          {lastDetection.class_name} {(lastDetection.confidence * 100).toFixed(0)}%
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-center space-y-2">
        <div className="text-lg">No cameras yet.</div>
        <div className="text-neutral-500 text-sm">
          Add one from the <a className="underline" href="/cameras">Cameras</a> tab.
        </div>
      </div>
    </div>
  );
}

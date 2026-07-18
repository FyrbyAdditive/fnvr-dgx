import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, Zone } from "@/lib/api";

// Zone editor: renders a camera snapshot and lets the user click to add
// polygon vertices (or two endpoints for a line/tripwire). Geometry stored
// as {"points": [x0,y0,x1,y1,...]} with normalised 0..1 coords so it's
// resolution-independent — the server compares detection bboxes in the
// same space.

type Kind = "polygon" | "line" | "tripwire";

export function ZoneEditor({ cameraId, cameraName }: { cameraId: string; cameraName: string }) {
  const qc = useQueryClient();
  const { data: zones = [] } = useQuery({
    queryKey: ["zones", cameraId],
    queryFn: () => api.listZones(cameraId),
    enabled: !!cameraId,
  });

  const createZone = useMutation({
    mutationFn: api.createZone,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["zones", cameraId] });
      qc.invalidateQueries({ queryKey: ["zones"] });
    },
  });
  const deleteZone = useMutation({
    mutationFn: api.deleteZone,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["zones", cameraId] });
      qc.invalidateQueries({ queryKey: ["zones"] });
    },
  });

  const [kind, setKind] = useState<Kind>("polygon");
  const [name, setName] = useState("");
  const [points, setPoints] = useState<number[]>([]); // [x0,y0,x1,y1,...] normalised

  const containerRef = useRef<HTMLDivElement>(null);

  // Refresh snapshot every few seconds so the editor reflects the live frame.
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const h = setInterval(() => setTick(Date.now()), 3000);
    return () => clearInterval(h);
  }, []);
  const snapshotSrc = `/api/v1/cameras/${encodeURIComponent(cameraId)}/snapshot.jpg?t=${tick}`;

  const maxPoints = kind === "line" || kind === "tripwire" ? 2 : 100;

  const onClick = (e: React.MouseEvent) => {
    const r = containerRef.current!.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    setPoints((p) => (p.length / 2 >= maxPoints ? p : [...p, x, y]));
  };

  const canSave = name.trim() !== "" && points.length >= (kind === "polygon" ? 6 : 4);

  const save = () => {
    if (!canSave) return;
    createZone.mutate(
      {
        camera_id: cameraId,
        name: name.trim(),
        kind,
        geometry: { points },
      },
      {
        onSuccess: () => {
          setName("");
          setPoints([]);
        },
      },
    );
  };

  return (
    <div className="mt-3 pl-3 border-l-2 border-neutral-800">
      <div className="text-xs text-neutral-500 mb-2">
        Zones for <span className="text-neutral-300">{cameraName}</span>
      </div>

      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 items-center mb-2 text-sm">
        <input
          className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
          placeholder="zone name (e.g. driveway)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <select
          className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as Kind);
            setPoints([]);
          }}
        >
          <option value="polygon">polygon</option>
          <option value="line">line</option>
          <option value="tripwire">tripwire</option>
        </select>
        <button
          className="text-xs text-neutral-400 hover:underline"
          onClick={() => setPoints([])}
          disabled={points.length === 0}
        >
          clear
        </button>
        <button
          className="bg-blue-600 hover:bg-blue-500 rounded px-3 py-1 text-sm disabled:opacity-50"
          onClick={save}
          disabled={!canSave || createZone.isPending}
        >
          {createZone.isPending ? "saving…" : "save zone"}
        </button>
      </div>

      <div
        ref={containerRef}
        onClick={onClick}
        className="relative aspect-video bg-neutral-900 rounded overflow-hidden cursor-crosshair select-none"
      >
        <img
          src={snapshotSrc}
          alt={cameraName}
          className="absolute inset-0 w-full h-full object-contain"
          draggable={false}
        />

        {/* existing zones */}
        <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 1 1" preserveAspectRatio="none">
          {zones.map((z) => (
            <ZoneShape key={z.id} zone={z} />
          ))}

          {/* in-progress points + preview outline */}
          {points.length >= 2 && (
            kind === "polygon" ? (
              <polygon
                points={polygonPointsAttr(points)}
                fill="rgba(59,130,246,0.15)"
                stroke="#3b82f6"
                strokeWidth="0.003"
                vectorEffect="non-scaling-stroke"
              />
            ) : (
              <polyline
                points={polygonPointsAttr(points)}
                fill="none"
                stroke="#3b82f6"
                strokeWidth="0.003"
                vectorEffect="non-scaling-stroke"
              />
            )
          )}
          {pairs(points).map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r={0.005} fill="#3b82f6" />
          ))}
        </svg>

        <div className="absolute bottom-1 left-2 text-[10px] text-neutral-400 bg-black/50 px-1 rounded pointer-events-none">
          click to add points · {points.length / 2} / {maxPoints}
          {kind === "polygon" && points.length >= 6 && " · first + last auto-close"}
        </div>
      </div>

      {zones.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1 text-xs">
          {zones.map((z) => (
            <ZoneChip key={z.id} zone={z} onDelete={() => deleteZone.mutate(z.id)} />
          ))}
        </ul>
      )}
    </div>
  );
}

const KIND_OPTIONS: { value: string; label: string }[] = [
  { value: "object", label: "object detection" },
  { value: "anpr", label: "number plates (ANPR)" },
  { value: "face", label: "face ID" },
  { value: "print_defect", label: "print failure" },
];

function ZoneChip({ zone, onDelete }: { zone: Zone; onDelete: () => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [classesText, setClassesText] = useState(
    (zone.exclude_classes ?? []).join(", "),
  );
  const [kinds, setKinds] = useState<Set<string>>(
    () => new Set(zone.exclude_kinds ?? []),
  );

  const update = useMutation({
    mutationFn: (body: { exclude_classes: string[]; exclude_kinds: string[] }) =>
      api.updateZoneExclusions(zone.id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["zones"] });
      qc.invalidateQueries({ queryKey: ["zones", zone.camera_id] });
      setOpen(false);
    },
  });

  const save = () => {
    const classes = classesText
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    update.mutate({ exclude_classes: classes, exclude_kinds: Array.from(kinds) });
  };

  const muteSummary =
    (zone.exclude_classes?.length ?? 0) + (zone.exclude_kinds?.length ?? 0);

  return (
    <li className="bg-neutral-800 rounded px-2 py-1">
      <div className="flex items-center gap-2">
        <span className="font-medium">{zone.name}</span>
        <span className="text-neutral-500">· {zone.kind}</span>
        {muteSummary > 0 && (
          <span
            className="text-amber-400"
            title={[
              ...(zone.exclude_kinds ?? []).map((k) => `mute ${k}`),
              ...(zone.exclude_classes ?? []).map((c) => `mute class "${c}"`),
            ].join(" · ")}
          >
            · muting {muteSummary}
          </span>
        )}
        <button
          className="ml-auto text-neutral-400 hover:text-white"
          onClick={() => setOpen((v) => !v)}
          title="configure mutes"
        >
          {open ? "close" : "⚙"}
        </button>
        <button
          className="text-red-400 hover:text-red-300"
          onClick={onDelete}
          title="delete zone"
        >
          ×
        </button>
      </div>
      {open && zone.kind === "polygon" && (
        <div className="mt-2 grid gap-2 text-xs">
          <div>
            <div className="text-neutral-400 mb-1">
              Mute detector kinds inside this zone
            </div>
            <div className="flex flex-wrap gap-3">
              {KIND_OPTIONS.map((opt) => (
                <label key={opt.value} className="inline-flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={kinds.has(opt.value)}
                    onChange={(e) => {
                      const next = new Set(kinds);
                      if (e.target.checked) next.add(opt.value);
                      else next.delete(opt.value);
                      setKinds(next);
                    }}
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </div>
          <div>
            <div className="text-neutral-400 mb-1">
              Mute specific classes (comma-separated — e.g. <code>car, bicycle</code>)
            </div>
            <input
              className="w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
              value={classesText}
              onChange={(e) => setClassesText(e.target.value)}
              placeholder="(none)"
            />
          </div>
          <div className="flex gap-2">
            <button
              className="bg-blue-600 hover:bg-blue-500 rounded px-3 py-1 disabled:opacity-50"
              onClick={save}
              disabled={update.isPending}
            >
              {update.isPending ? "saving…" : "save"}
            </button>
          </div>
        </div>
      )}
      {open && zone.kind !== "polygon" && (
        <div className="mt-2 text-xs text-neutral-500">
          Mutes only apply to polygon zones — the bbox-inside test needs an
          enclosed area.
        </div>
      )}
    </li>
  );
}

function ZoneShape({ zone }: { zone: Zone }) {
  const pts = zone.geometry.points ?? [];
  if (pts.length < 4) return null;
  const attr = polygonPointsAttr(pts);
  if (zone.kind === "polygon") {
    return (
      <polygon
        points={attr}
        fill="rgba(245,158,11,0.12)"
        stroke="#f59e0b"
        strokeWidth="0.003"
        vectorEffect="non-scaling-stroke"
      />
    );
  }
  return (
    <polyline
      points={attr}
      fill="none"
      stroke="#f59e0b"
      strokeWidth="0.004"
      vectorEffect="non-scaling-stroke"
    />
  );
}

function polygonPointsAttr(pts: number[]): string {
  const xs: string[] = [];
  for (let i = 0; i + 1 < pts.length; i += 2) {
    xs.push(`${pts[i].toFixed(4)},${pts[i + 1].toFixed(4)}`);
  }
  return xs.join(" ");
}

function pairs(pts: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < pts.length; i += 2) out.push([pts[i], pts[i + 1]]);
  return out;
}

import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function Rules() {
  const qc = useQueryClient();
  const { data: rules = [] } = useQuery({ queryKey: ["rules"], queryFn: api.listRules });
  const { data: zones = [] } = useQuery({ queryKey: ["zones"], queryFn: () => api.listZones() });
  const { data: cameras = [] } = useQuery({ queryKey: ["cameras"], queryFn: api.listCameras });

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
              <li key={r.id} className="p-3 flex items-center gap-3 text-sm">
                <div className="flex-1">
                  <div className="font-medium">{r.name}</div>
                  <div className="text-xs text-neutral-500">
                    {(r.definition.classes ?? []).join(", ")}
                    {r.definition.camera_id && ` · ${r.definition.camera_id}`}
                    {` · ≥${Math.round((r.definition.min_confidence ?? 0) * 100)}%`}
                    {` · ${r.definition.severity ?? "info"}`}
                  </div>
                </div>
                <button className="text-xs text-neutral-400 hover:underline"
                  onClick={() => toggleRule.mutate({ id: r.id, enabled: r.enabled })}>
                  {r.enabled ? "disable" : "enable"}
                </button>
                <button className="text-xs text-red-400 hover:underline"
                  onClick={() => deleteRule.mutate(r.id)}>
                  delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

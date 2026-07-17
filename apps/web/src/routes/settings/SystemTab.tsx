import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AdvancedSettings, api } from "@/lib/api";
import { Card, FormRow, SaveBar } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { useDraft } from "@/lib/useDraft";
import { useReportDirty } from "./dirty";

export function SystemTab({ isAdmin }: { isAdmin: boolean }) {
  return (
    <>
      {isAdmin && <PipelineTunablesCard />}
      {isAdmin && <AdvancedCard />}
      <SystemInfoCard />
    </>
  );
}

// PipelineTunables are the small knobs that shape supervisor behaviour —
// no pipeline restart needed for a change to take effect (the supervisor
// re-reads them per worker respawn cycle).
function PipelineTunablesCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({
    queryKey: ["pipeline-startup-grace"],
    queryFn: api.getPipelineStartupGrace,
  });
  const { draft, setDraft, dirty, discard } = useDraft(data);
  useReportDirty("tunables", dirty);
  const save = useMutation({
    mutationFn: (n: number) => api.updatePipelineStartupGrace(n),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pipeline-startup-grace"] });
      toast.success("Startup grace saved — applies from the next worker respawn");
    },
    onError: (e) => toast.error(String((e as Error)?.message ?? "save failed")),
  });

  if (!draft) {
    return (
      <Card title="Pipeline tunables">
        <p className="text-sm text-neutral-500">Loading…</p>
      </Card>
    );
  }

  return (
    <Card title="Pipeline tunables">
      <FormRow
        label="Startup grace (seconds)"
        hint="During this window after a worker (re)spawn, transient exits don't flip the UI banner to “pipeline failed” — gives slow-to-dial sources (MediaMTX-proxied, self-signed TLS, cold-boot cameras) time to settle. Default 60s. Set to 0 to fail fast. No restart needed."
      >
        <input
          type="number"
          min={0}
          max={600}
          className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 w-24"
          value={draft.startup_grace_sec}
          onChange={(e) =>
            setDraft({
              startup_grace_sec: Math.max(0, Math.min(600, Number(e.target.value))),
            })
          }
        />
      </FormRow>
      <SaveBar
        dirty={dirty}
        saving={save.isPending}
        onSave={() => save.mutate(draft.startup_grace_sec)}
        onDiscard={discard}
      />
    </Card>
  );
}

type AdvancedRowSpec = {
  key: keyof AdvancedSettings;
  label: string;
  hint: string;
  min?: number;
  max?: number;
  step?: number;
  text?: boolean; // HH:MM field
};

const ADVANCED_GROUPS: { group: string; rows: AdvancedRowSpec[] }[] = [
  {
    group: "Face matching",
    rows: [
      {
        key: "faces.match_threshold",
        label: "Match threshold",
        hint: "Cosine-similarity floor for a face to match an enrolled person. Default 0.40.",
        min: 0.01, max: 0.99, step: 0.01,
      },
      {
        key: "faces.match_margin",
        label: "Match margin",
        hint: "Required similarity gap between the best and runner-up person. Default 0.05.",
        min: 0, max: 0.5, step: 0.01,
      },
      {
        key: "faces.negative_penalty_weight",
        label: "Negative penalty weight",
        hint: "Weight of near-negative matches when scoring; 0 disables the penalty. Default 1.0.",
        min: 0, max: 2, step: 0.1,
      },
    ],
  },
  {
    group: "Detections",
    rows: [
      {
        key: "detections.suppression_hamming_threshold",
        label: "Suppression pHash distance",
        hint: "Max Hamming distance for a detection to match a flagged false-positive and be suppressed. Default 8.",
        min: 4, max: 16, step: 1,
      },
      {
        key: "detections.hot_hours",
        label: "Hot window (hours)",
        hint: "How long detections stay in Postgres before queries fall back to per-segment sidecar files. Default 24.",
        min: 1, max: 168, step: 1,
      },
    ],
  },
  {
    group: "Storage",
    rows: [
      {
        key: "storage.min_free_pct",
        label: "Min free disk %",
        hint: "Emergency-purge floor: oldest recordings are deleted when free space drops below this. Shown on the Storage page. Default 10.",
        min: 0, max: 50, step: 0.5,
      },
    ],
  },
  {
    group: "ML",
    rows: [
      {
        key: "ml.cluster.batch_schedule",
        label: "Face clustering time",
        hint: "Nightly unknown-face clustering start (HH:MM, server-local). Default 03:00.",
        text: true,
      },
    ],
  },
];

function AdvancedCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: server } = useQuery({
    queryKey: ["advanced-settings"],
    queryFn: api.getAdvancedSettings,
  });
  const { draft, setDraft, dirty, discard } = useDraft<AdvancedSettings>(server);
  useReportDirty("advanced", dirty);

  const save = useMutation({
    mutationFn: (changed: Partial<AdvancedSettings>) => api.updateAdvancedSettings(changed),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["advanced-settings"] });
      toast.success("Advanced settings saved — services pick them up within ~30s");
    },
    onError: (e) => toast.error(String((e as Error)?.message ?? "save failed")),
  });

  if (!draft || !server) {
    return (
      <Card title="Advanced">
        <p className="text-sm text-neutral-500">Loading…</p>
      </Card>
    );
  }

  const doSave = () => {
    // Send only the keys that changed — the endpoint writes exactly
    // what it receives.
    const changed: Partial<AdvancedSettings> = {};
    for (const k of Object.keys(draft) as (keyof AdvancedSettings)[]) {
      if (draft[k] !== server[k]) {
        (changed as Record<string, unknown>)[k] = draft[k];
      }
    }
    save.mutate(changed);
  };

  return (
    <Card
      title="Advanced"
      description="Runtime knobs consumed by the event processor, storage manager and ML worker. Changes apply within about 30 seconds — no restart. These used to be database-only."
    >
      <div className="grid gap-3">
        {ADVANCED_GROUPS.map(({ group, rows }) => (
          <div key={group} className="space-y-2">
            <div className="text-xs uppercase tracking-wide text-neutral-500">{group}</div>
            {rows.map((r) => (
              <FormRow key={r.key} label={r.label} hint={r.hint}>
                {r.text ? (
                  <input
                    type="text"
                    pattern="^([01]?\d|2[0-3]):[0-5]\d$"
                    className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 w-24"
                    value={String(draft[r.key])}
                    onChange={(e) => setDraft((d) => d && { ...d, [r.key]: e.target.value })}
                  />
                ) : (
                  <input
                    type="number"
                    min={r.min}
                    max={r.max}
                    step={r.step}
                    className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 w-24"
                    value={Number(draft[r.key])}
                    onChange={(e) =>
                      setDraft((d) => d && { ...d, [r.key]: Number(e.target.value) })
                    }
                  />
                )}
              </FormRow>
            ))}
          </div>
        ))}
        <SaveBar dirty={dirty} saving={save.isPending} onSave={doSave} onDiscard={discard} />
      </div>
    </Card>
  );
}

function SystemInfoCard() {
  const { data: info } = useQuery({ queryKey: ["info"], queryFn: api.systemInfo });
  return (
    <Card
      title="System"
      headerRight={
        <Link to="/storage" className="text-xs text-blue-400 hover:underline whitespace-nowrap">
          Storage &amp; retention →
        </Link>
      }
    >
      {info ? (
        <div className="grid gap-1.5">
          <FormRow label="Version">
            <span className="text-neutral-200">{info.version}</span>
          </FormRow>
          <FormRow label="Milestone">
            <span className="text-neutral-200">{info.milestone}</span>
          </FormRow>
          <FormRow label="Server time">
            <span className="text-neutral-200 tabular-nums">
              {new Date(info.time).toLocaleString()}
            </span>
          </FormRow>
          <details className="text-xs text-neutral-500 mt-1">
            <summary className="cursor-pointer hover:text-neutral-300">raw</summary>
            <pre className="bg-neutral-900 rounded p-2 mt-1">{JSON.stringify(info, null, 2)}</pre>
          </details>
        </div>
      ) : (
        <p className="text-sm text-neutral-500">Loading…</p>
      )}
    </Card>
  );
}

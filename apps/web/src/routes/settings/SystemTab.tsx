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
        hint: "Cosine-similarity floor for a face to match an enrolled person. Default 0.55 (aligned TopoFR embeddings).",
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
    group: "Face enrolment",
    rows: [
      {
        key: "faces.enrol.dedup_similarity",
        label: "Enrol dedup similarity",
        hint: "Samples this similar to an already-enrolled one (or to each other) are skipped at enrol time — near-copies fake the matcher's top-3 corroboration. Default 0.90.",
        min: 0.5, max: 0.999, step: 0.01,
      },
      {
        key: "faces.enrol.max_per_action",
        label: "Max samples per enrol",
        hint: "Cap on new embeddings added by one enrol action (cluster or multi-select) after dedup, keeping the most representative first. Default 8.",
        min: 1, max: 50, step: 1,
      },
      {
        key: "faces.enrol.min_det_score",
        label: "Enrol min detector score",
        hint: "Samples below this face-detector confidence are excluded from enrolment (matching still uses them). Default 0.5.",
        min: 0, max: 0.99, step: 0.05,
      },
      {
        key: "faces.enrol.max_abs_yaw",
        label: "Enrol max head turn",
        hint: "Nose offset from the eye midpoint in interocular units; ~0 is frontal. Samples more turned than this don't enter the enrolment pool. Default 0.35.",
        min: 0.05, max: 1, step: 0.05,
      },
      {
        key: "faces.enrol.min_blur",
        label: "Enrol min sharpness",
        hint: "Laplacian variance of the aligned face; motion blur scores under ~30. Samples below the floor are excluded from enrolment. 0 disables. Default 30.",
        min: 0, max: 500, step: 5,
      },
    ],
  },
  {
    group: "Face capture",
    rows: [
      {
        key: "faces.capture.interval_ms",
        label: "Capture window (ms)",
        hint: "After a person's first face publishes immediately, only the best face per window is kept. Default 1500. Takes effect on pipeline restart.",
        min: 250, max: 10000, step: 250,
      },
      {
        key: "faces.capture.max_per_track",
        label: "Max faces per appearance",
        hint: "Budget per tracked person; after this, one face every 30s while they stay in frame. Default 12. Takes effect on pipeline restart.",
        min: 1, max: 100, step: 1,
      },
      {
        key: "faces.capture.min_confidence",
        label: "Min face confidence",
        hint: "Faces below this detector score are never captured. Default 0.55. Takes effect on pipeline restart.",
        min: 0, max: 0.99, step: 0.05,
      },
      {
        key: "faces.capture.min_px",
        label: "Min face size (px)",
        hint: "Faces smaller than this on the inference canvas are skipped — below ~30px the embedder output is noise. Default 30. Takes effect on pipeline restart.",
        min: 10, max: 200, step: 5,
      },
    ],
  },
  {
    group: "Print monitoring",
    rows: [
      {
        key: "printing.defect.interval_sec",
        label: "Check interval (s)",
        hint: "How often each printer camera's preview is scored for print failures (Obico model). Default 10.",
        min: 5, max: 120, step: 5,
      },
      {
        key: "printing.defect.alert_threshold",
        label: "Alert threshold",
        hint: "Smoothed failure score that raises a print_failure event; lower = more sensitive (and more false alerts on supports/complex geometry). Default 0.40.",
        min: 0.1, max: 0.99, step: 0.05,
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
      {
        key: "faces.thumbs_retention_days",
        label: "Face thumbnail retention (days)",
        hint: "Days to keep face crop JPEGs not attached to an enrolled person. Enrolled-evidence thumbnails are always kept. Default 30.",
        min: 8, max: 365, step: 1,
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

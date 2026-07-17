import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, DetectorSettings } from "@/lib/api";
import { Card, FormRow, SaveBar } from "@/components/ui/Card";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { useDraft } from "@/lib/useDraft";
import { CalibrationPanel } from "./CalibrationPanel";
import { useReportDirty } from "./dirty";

// Short description shown in the dropdown. mAP numbers from Ultralytics'
// published COCO benchmarks for YOLO26 (standard mode).
const YOLO_VARIANTS: { value: string; label: string }[] = [
  { value: "yolo26n", label: "YOLO26-n · 40.9 mAP · fastest" },
  { value: "yolo26s", label: "YOLO26-s · 48.6 mAP" },
  { value: "yolo26m", label: "YOLO26-m · 53.1 mAP" },
  { value: "yolo26l", label: "YOLO26-l · 55.0 mAP" },
  { value: "yolo26x", label: "YOLO26-x · 57.5 mAP · most accurate" },
];

const INTERVAL_OPTIONS = [
  { value: 0, label: "0 — every frame (default)" },
  { value: 1, label: "1 — every 2nd frame (≈ halves detector GPU)" },
  { value: 2, label: "2 — every 3rd frame" },
  { value: 3, label: "3 — every 4th frame" },
  { value: 4, label: "4 — every 5th frame" },
];

export function DetectorCard({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { data: current } = useQuery({
    queryKey: ["detector"],
    queryFn: api.getDetectorSettings,
  });
  const { data: pipelineState } = useQuery({
    queryKey: ["pipeline-state"],
    queryFn: api.getPipelineState,
    refetchInterval: 3_000,
  });

  const { draft, setDraft, dirty, discard } = useDraft<DetectorSettings>(current);
  useReportDirty("detector", dirty);

  const patch = (p: Partial<DetectorSettings>) =>
    setDraft((d) => (d ? { ...d, ...p } : d));

  const save = useMutation({
    mutationFn: async (body: DetectorSettings) => {
      await api.updateDetectorSettings(body);
      try {
        await api.restartPipeline();
      } catch {
        toast.error("Saved, but the pipeline restart failed", {
          action: { label: "Retry restart", onClick: () => api.restartPipeline() },
        });
        return;
      }
      toast.success("Detector settings saved — pipeline restarting");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["detector"] });
      qc.invalidateQueries({ queryKey: ["pipeline-state"] });
      qc.invalidateQueries({ queryKey: ["cameras"] });
    },
    onError: (e) => toast.error(String((e as Error)?.message ?? "save failed")),
  });

  if (!draft) {
    return (
      <Card title="Object detector">
        <p className="text-sm text-neutral-500">Loading…</p>
      </Card>
    );
  }

  const family = draft.model_family ?? "yolo26";
  const variant = draft.yolo26_variant;
  // Legacy fp8/nvfp4 rows are readable but no longer writable — the
  // runtime silently ran them as FP16 anyway. Coerce for display and
  // save; the amber chip tells the admin what saving will do.
  const legacyPrecision = draft.yolo26_precision !== "fp16" && draft.yolo26_precision !== "int8";
  const precision = legacyPrecision ? "fp16" : draft.yolo26_precision;

  const tritonInvalid = draft.inference_backend === "triton" && family !== "rfdetr";

  const doSave = async () => {
    const ok = await confirm({
      title: "Save and restart the pipeline?",
      body: "Recording and live view pause for roughly 10–30 seconds while workers respawn.",
      confirmLabel: "Save & restart",
    });
    if (!ok) return;
    save.mutate({ ...draft, model_family: family, yolo26_precision: precision });
  };

  return (
    <Card
      title="Object detector"
      description="Primary detector run on every camera (unless disabled per-camera). COCO label space for both families. Changes apply on pipeline restart."
    >
      <div className="grid gap-3">
        <FormRow label="Model family">
          <div className="flex items-center gap-2">
            <select
              className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
              value={family}
              disabled={!isAdmin}
              title="RF-DETR (Roboflow, NMS-free DETR) is the newer family; YOLO26 remains the proven fallback. Switching restarts the pipeline and builds a TensorRT engine on first use."
              onChange={(e) => patch({ model_family: e.target.value as "yolo26" | "rfdetr" })}
            >
              <option value="yolo26">YOLO26</option>
              <option value="rfdetr">RF-DETR</option>
            </select>
            {family === "rfdetr" && (
              <select
                className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
                value={draft.rfdetr_variant ?? "base"}
                disabled={!isAdmin}
                title="base + medium ship in the image; other sizes need an image rebuild"
                onChange={(e) =>
                  patch({ rfdetr_variant: e.target.value as DetectorSettings["rfdetr_variant"] })
                }
              >
                <option value="base">base</option>
                <option value="medium">medium</option>
              </select>
            )}
          </div>
        </FormRow>

        {family === "yolo26" && (
          <>
            <FormRow label="Model size">
              <select
                className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
                value={YOLO_VARIANTS.find((v) => v.value === variant) ? variant : "__custom__"}
                disabled={!isAdmin}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "__custom__") {
                    patch({
                      yolo26_variant: variant.startsWith("fnvr-") ? variant : "fnvr-v1",
                    });
                  } else {
                    patch({ yolo26_variant: v });
                  }
                }}
              >
                {YOLO_VARIANTS.map((v) => (
                  <option key={v.value} value={v.value}>{v.label}</option>
                ))}
                <option value="__custom__">Custom fine-tuned (fnvr-v1, fnvr-v2, …)</option>
              </select>
            </FormRow>

            {variant.startsWith("fnvr-") && (
              <FormRow label="Custom name">
                <input
                  type="text"
                  className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
                  value={variant}
                  placeholder="fnvr-v1"
                  disabled={!isAdmin}
                  onChange={(e) => patch({ yolo26_variant: e.target.value.trim().toLowerCase() })}
                />
              </FormRow>
            )}

            <FormRow label="Precision">
              <div className="flex items-center gap-4">
                <label className="inline-flex items-center gap-1">
                  <input
                    type="radio"
                    name="precision"
                    checked={precision === "fp16"}
                    disabled={!isAdmin}
                    onChange={() => patch({ yolo26_precision: "fp16" })}
                  />
                  FP16
                </label>
                <label
                  className="inline-flex items-center gap-1"
                  title="Quantised to INT8 via offline trtexec calibration. Needs a batch of calibration images first — see the Calibration panel below."
                >
                  <input
                    type="radio"
                    name="precision"
                    checked={precision === "int8"}
                    disabled={!isAdmin}
                    onChange={() => patch({ yolo26_precision: "int8" })}
                  />
                  INT8
                </label>
                {legacyPrecision && (
                  <span className="text-xs bg-amber-900/60 border border-amber-700 text-amber-200 rounded px-2 py-0.5">
                    stored precision "{draft.yolo26_precision}" is deprecated — saving writes FP16
                  </span>
                )}
              </div>
            </FormRow>
          </>
        )}

        <FormRow
          label="Inference backend"
          hint="nvinfer runs TensorRT inside each worker; triton shares one engine copy for the whole fleet via a central Triton server (RF-DETR only). Takes effect on pipeline restart."
        >
          <select
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
            value={draft.inference_backend ?? "nvinfer"}
            disabled={!isAdmin}
            onChange={(e) =>
              patch({ inference_backend: e.target.value as "nvinfer" | "triton" })
            }
          >
            <option value="nvinfer">nvinfer — in-process TensorRT (default)</option>
            <option value="triton">triton — shared Triton server</option>
          </select>
          {tritonInvalid && (
            <p className="text-xs text-amber-400 mt-1">
              The Triton backend requires the RF-DETR family (it serves only the
              RF-DETR engine). Switch the backend to nvinfer or the family back
              to RF-DETR.
            </p>
          )}
        </FormRow>

        <FormRow
          label="Detection interval"
          hint="The tracker bridges skipped frames, so detections still land on every frame in Live. Raise this when many cameras saturate the GPU. Takes effect on pipeline restart."
        >
          <select
            className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1"
            value={draft.interval ?? 0}
            disabled={!isAdmin}
            onChange={(e) => patch({ interval: Number(e.target.value) })}
          >
            {INTERVAL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </FormRow>

        <FormRow label="ANPR">
          <label
            className="inline-flex items-center gap-2"
            title="Adds a global plate detector + fast-plate-ocr CCT (65+ countries) after the object detector."
          >
            <input
              type="checkbox"
              checked={!!draft.anpr_enabled}
              disabled={!isAdmin}
              onChange={(e) => patch({ anpr_enabled: e.target.checked })}
            />
            <span>Read licence plates (global ANPR)</span>
          </label>
        </FormRow>

        <FormRow label="Face ID">
          <label
            className="inline-flex items-center gap-2"
            title="Adds a RetinaFace detector + AdaFace IR-101 embedder after the object detector. Enrol + match persons from the Faces tab."
          >
            <input
              type="checkbox"
              checked={!!draft.face_id_enabled}
              disabled={!isAdmin}
              onChange={(e) => patch({ face_id_enabled: e.target.checked })}
            />
            <span>Detect &amp; recognise faces (RetinaFace + AdaFace)</span>
          </label>
        </FormRow>

        {isAdmin && (
          <SaveBar
            dirty={dirty || legacyPrecision}
            saving={save.isPending}
            saveLabel="Save & restart pipeline"
            onSave={doSave}
            onDiscard={discard}
            disabled={tritonInvalid}
          />
        )}

        <PipelineStatusChip state={pipelineState?.state} />

        {family === "yolo26" && precision === "int8" && (
          <CalibrationPanel isAdmin={isAdmin} />
        )}
      </div>
    </Card>
  );
}

export function PipelineStatusChip({ state }: { state?: { state: string; variant?: string; precision?: string; message?: string } }) {
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

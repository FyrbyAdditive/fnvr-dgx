import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

// CalibrationPanel drives the yolo26 INT8 calibration workflow:
// - sampler trigger ("Prepare calibration images from recent recordings")
// - image_count progress
// - last-run timestamp and last-error surface (from the entrypoint's
//   POST to /api/v1/internal/detector/calibration_report)
//
// Rendered ONLY when the draft is yolo26 + int8 — under the RF-DETR
// family (the fleet default) none of this applies, and hiding it also
// stops the 2s status poll.
export function CalibrationPanel({ isAdmin }: { isAdmin: boolean }) {
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
          Applies to the YOLO26 family only — required for INT8 inference.
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
          Save with precision INT8 to run trtexec.
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

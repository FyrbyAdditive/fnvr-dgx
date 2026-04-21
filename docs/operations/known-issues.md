# Known issues

Upstream bugs we can't fix ourselves. Each entry has the workaround we ship + the resume path.

## YOLO26 INT8 calibration crashes inside TensorRT 10.3

**Status (2026-04-21):** blocked. Pipeline runs on FP16 with no code change required.

**Symptom.** Setting `detector.yolo26_precision = int8` triggers calibration; TRT 10.3 throws

```
[E] Error[2]: [checkSanity.cpp::checkLinks::218] Error Code 2:
    Internal Error (Assertion item.second != nullptr failed.
    region should have been removed from Graph::regions)
[E] Engine could not be created from network
```

Reproduced via both the in-process calibrator (`NvDsInferYoloCudaEngineGet`) and the offline `trtexec --int8 --calib=...` path. The bug is in TRT's calibration-graph optimiser, not in our wrapper.

**What we've tried.** In-process calibrator. Offline `trtexec` with `--skipInference`. Pinning shape with `--minShapes / --optShapes / --maxShapes`. Same assertion every time.

**Why we can't just upgrade TRT.**

- JetPack 6.2's apt repo (`repo.download.nvidia.com/jetson/common r36.5/main`) ships **TRT 10.3.0.30** only. No newer version on this JetPack line.
- Bug tracked as [NVIDIA/TensorRT#3937](https://github.com/NVIDIA/TensorRT/issues/3937) — open, reproduced on 10.1 + 10.3. No fix version announced in 10.4 / 10.10 / 10.12 / 10.13.x release notes.
- Newer DS containers (`deepstream-l4t:8.0-*` = TRT 10.13 / JP 7.0; `:9.0-*` = JP 7.1) need **L4T r38** tegra libs on the host. Orin doesn't have them — **JetPack 6.3 does not exist**, the 6.x line is frozen at 6.2.1. Orin's next real upgrade is **JetPack 7.2**, targeted Q2 2026.
- DeepStream-Yolo's issue tracker has the same assertion open ([#585](https://github.com/marcoslucianops/DeepStream-Yolo/issues/585), [#675](https://github.com/marcoslucianops/DeepStream-Yolo/issues/675)).

**Current runtime behaviour.**

- API validator accepts `int8`.
- Entrypoint attempts offline calibration.
- Calibration fails with the assertion above.
- Entrypoint catches the failure, POSTs the log tail to `/api/v1/internal/detector/calibration_report`, flips `PRECISION` in-memory to `fp16`, renders the effective nvinfer config for FP16, proceeds.
- **Container never crash-loops.** Worst case you run FP16 with a red banner in Settings.

**Resume path.** When any of the below happens, flip `detector.yolo26_precision = int8` in Settings and the existing slice will re-run calibration:

1. JetPack 7.2 for Orin lands (Q2 2026) — newer DS + TRT 10.13+.
2. NVIDIA closes TRT#3937 with a fixed-in-X version that reaches a JP 6.2 patch.
3. DeepStream-Yolo publishes a YOLO26 export / per-layer quantisation override avoiding the problematic graph pattern.

**Infrastructure still in place, waiting:**
- [apps/api-server/internal/calibration/sampler.go](../../apps/api-server/internal/calibration/sampler.go) — frame sampler from recent recordings.
- [deploy/docker/calibrate-yolo26.sh](../../deploy/docker/calibrate-yolo26.sh) — offline trtexec driver.
- [deploy/docker/pipeline-entrypoint.sh](../../deploy/docker/pipeline-entrypoint.sh) — INT8 branch + fallback + report POST.
- [apps/web/src/routes/settings/Settings.tsx](../../apps/web/src/routes/settings/Settings.tsx) — INT8 radio + CalibrationPanel.
- [apps/api-server/internal/db/migrations/0018_calibration_status.sql](../../apps/api-server/internal/db/migrations/0018_calibration_status.sql).

**FP16 capacity workarounds** if you need more cameras before INT8 unblocks:

- **`interval=N`** on the primary nvinfer — skip inference on N−1 of every N frames. Tracker smooths the gaps. 2× cheaper at `interval=1`.
- **Lower nvstreammux resolution** — yolo26 runs on the muxed resolution, not source. 1280×720 → 960×540 halves inference cost with small loss on large subjects.
- **Per-camera detector whitelist** — `cameras.enabled_detectors` array lets you skip face / ANPR per camera.

## Pipeline NVDEC/NVENC initialisation on Jetson (historical)

**Status (2026-04):** resolved. No action needed on current builds.

The first integration on this host failed because libv4l was loading the dGPU (`libv4l2_nvcuvidvideocodec.so`) video plugin alphabetically ahead of the Tegra (`libv4l2_nvvideocodec.so`) one, and the dGPU plugin fails with `S_EXT_CTRLS for CUDA_GPU_ID failed` on Jetson.

Fix (in [deploy/docker/pipeline-entrypoint.sh](../../deploy/docker/pipeline-entrypoint.sh)): delete the cuvid plugin symlink before starting the supervisor. Shipped; kept in the tree as belt-and-braces.

## Blocked integrations (no workaround required)

These features are intentionally not built because we don't have the external resource to integrate with. Listed here so you don't look for them.

- **Telegram / Signal / SIP channels** — no accounts / no SIP server configured.
- **TAO fine-tune loop** — needs a training box (not the Orin, which is inference-only). Scaffolding exists under `apps/ml-worker/fnvr_ml/tao_stub.py`. Data model (`fine_tune_jobs`, `ml.drift.baseline_self_match`, `fnvr.models.faceid.reload`) is in place so the work can resume with no schema change when the hardware does.
- **OIDC / WebAuthn** — local auth only today.
- **Cross-camera ReID / CLIP semantic search / federation hub** — PLAN.md M5 items, not yet started.

See [architecture/README.md § what's shipped](../architecture/README.md#whats-shipped-and-what-isnt) for the full picture.

# nvinfer configs

DeepStream `nvinfer` plugin configs for the bundled model slots.

## Primary object detector

| File | Used when | Notes |
|---|---|---|
| `yolo26.txt.template` | `detector.yolo26_variant` is set (default) | Rendered by the entrypoint into `yolo26.effective.txt` with the chosen variant (n/s/m/l/x) + precision (fp16/int8). **This is the active detector in all current deploys.** |
| `yolo11.txt` | Legacy / fallback | Needs `/var/lib/fnvr/models/yolo11s.onnx` placed first. Kept as a drop-in for dev experiments. |
| `peoplenet.txt` | Legacy | TAO 2.6 PeopleNet (person + bag + face). |
| `trafficcamnet.txt` | Legacy | TAO TrafficCamNet (car + bicycle + person + roadsign). |

## Secondary detectors (SGIEs)

| File | Used when | Notes |
|---|---|---|
| `lpdnet.txt` + `lpdnet.labels` | `settings.detector.anpr_enabled = true` | TAO LPDNet for US plates. |
| `lprnet.txt` + `lprnet.labels` | Same as LPDNet | TAO LPRNet OCR. US format. |
| `scrfd.txt.template` + `scrfd.labels` | `settings.detector.face_id_enabled = true` | SCRFD-10G face detector, bbox-only in-graph. No embedder SGIE — ml-worker aligns + embeds the published crop (docs/architecture/face-id.md). |

## Tracker

`tracker_NvDCF.yml` — NvDCF with tuned minimum object dimensions. Ships with every pipeline instance.

## Swapping detectors

The yolo26 template renders to `yolo26.effective.txt` on container start, reading `detector.yolo26_variant` + `detector.yolo26_precision` from the `settings` table via the `/api/v1/internal/detector` endpoint. To drop in a different ONNX, copy the template, edit `onnx-file` + `num-detected-classes` + the custom parser, and set `FNVR_INFER_CONFIG` to point at it.

INT8 is currently blocked on a TRT 10.3 bug — see [docs/operations/known-issues.md](../../../docs/operations/known-issues.md). The template + calibration path remain in place, waiting for JetPack 7.2.

# nvinfer configs

DeepStream `nvinfer` plugin configs for the bundled model slots.

| Slot | File | Classes | First-run | Notes |
|------|------|---------|-----------|-------|
| Default primary | `peoplenet.txt` | person, bag, face | Builds INT8 engine from TAO ETLT in DS samples | TAO 2.6, well-tuned for CCTV-height cameras |
| Traffic primary | `trafficcamnet.txt` | car, bicycle, person, roadsign | Same | Good for driveway / street-facing cameras |
| General primary | `yolo11.txt` | 80 (COCO) | Needs `/var/lib/fnvr/models/yolo11s.onnx` placed first | YOLO11 = latest stable Ultralytics line (2025). FP16 on GPU. |

Per-camera slot selection lives in Postgres (`cameras.primary_model` column — lands in a migration with M3). For M2, the process-wide slot is chosen via `FNVR_INFER_CONFIG`.

## Newer-than-YOLO11

The `yolo11.txt` config is structurally identical to anything from v8 onwards — only `onnx-file`, `num-detected-classes`, and optionally the custom parser lib change. To drop in a newer model, copy this file, update those fields, point `model-engine-file` somewhere new, and select it via `FNVR_INFER_CONFIG`.

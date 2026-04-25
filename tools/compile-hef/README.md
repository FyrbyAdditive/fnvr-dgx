# compile-hef

Convert a trained YOLOv11 ONNX into a Hailo-8L `.hef`. Runs Hailo's
Dataflow Compiler in a container.

**linux/amd64 only** — Hailo's compiler isn't ported to ARM. Run on
the x86 box at `tim@172.16.4.4` (or any other linux/amd64 + Docker
host). The HEF artefact is architecture-agnostic; rsync it back to
the Orin afterwards.

## Inputs

- A trained ONNX from `tools/train-detector/runs/fnvr-vN/weights/best.onnx`
- The dataset tree (for INT8 calibration sampling)

## Workflow

```sh
# From your laptop, push this directory to the x86 host:
rsync -avz tools/compile-hef/ tim@172.16.4.4:~/fnvr-compile-hef/

# Then on the x86 box (tim@172.16.4.4):
ssh tim@172.16.4.4
cd ~/fnvr-compile-hef

# 1. Build the compiler image (one-time, ~3 min — pulls hailomz).
sudo docker build -t fnvr-compile-hef .

# 2. Pull the ONNX + dataset from the DGX Spark. Layout:
#    ~/hef-build/onnx-src/best.onnx
#    ~/hef-build/dataset/images/train/...
mkdir -p ~/hef-build/onnx-src ~/hef-build/out
rsync -avz tim@172.16.4.6:~/fnvr-train/runs/fnvr-v1/weights/best.onnx \
    ~/hef-build/onnx-src/
rsync -avz tim@172.16.4.6:~/fnvr-train/dataset ~/hef-build/

# 3. Compile (~10–20 min).
sudo docker run --rm -it \
    -v "$HOME/hef-build:/work" \
    -v "$HOME/hef-build/onnx-src:/work/onnx-src:ro" \
    -v "$HOME/hef-build/dataset:/work/dataset:ro" \
    fnvr-compile-hef \
    /work/compile.sh fnvr-v1

# 4. Output: ~/hef-build/out/fnvr-v1.hef. Ship to the Orin:
rsync -avz ~/hef-build/out/fnvr-v1.hef \
    tim@172.16.4.23:/var/lib/docker/volumes/fnvr-data/_data/models/hailo/

# 5. Flip the broker over to it via Settings → Object detector
#    ("Hailo model" field: type "fnvr-v1" and Save).
#    Or via API:
curl -X PUT -b /tmp/cookie -H 'Content-Type: application/json' \
    -d '{"hailo_model_version":"fnvr-v1"}' \
    http://172.16.4.23:8081/api/v1/settings/detector
```

The broker re-reads `detector.hailo_model_version` on next worker
respawn (or restart the broker container directly: `sudo docker
compose restart hailo-broker`). To roll back, set the version to
`stock` and the broker loads the original `yolov11l.hef`.

## Notes

- Calibration set: 1024 random frames from `images/train/`,
  letterboxed to 640 × 640. Re-runs reuse the existing `calib/` dir
  to skip the resampling step. Wipe `calib/` if you want a fresh
  sample.
- Compile time: ~10–20 min on a modern x86 (Hailo's compiler is
  CPU-bound and single-threaded for the heavy graph-optimisation
  passes).
- The class count is auto-detected from the ONNX output shape, so
  changing the trimmed taxonomy on the Orin and re-training "just
  works" — no manual editing of compile flags.

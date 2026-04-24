// In-process Hailo-8 inference for fnvr. Replaces `nvinfer` PGIE on cameras
// whose `detector_backend == "hailo"` without introducing the hailonet
// GStreamer plugin (which breaks GstBuffer identity and so drops
// NvDsBatchMeta on the output side — fatal for DeepStream integration).
//
// Design:
// - One process-wide HailoInference singleton owns the VDevice and the
//   ConfiguredInferModel for the one HEF we ship (`yolov11l.hef`). Multiple
//   worker threads (one per camera) call `Infer()` concurrently; libhailort's
//   internal scheduler serialises accesses to the single Hailo-8 PCIe device.
// - Infer() takes an RGB 640x640 buffer (row-major uint8), blocks on the
//   async-infer completion, and returns decoded detections in network-space
//   (coordinates normalised to [0, 1] via bbox/640). The caller is responsible
//   for scaling into source pixel space.
// - The HEF is expected to have on-device NMS (yolov11l from Hailo Model Zoo
//   v2.13.0 does — single output tensor of shape [num_classes][max_bboxes][5]
//   with rows (y_min, x_min, y_max, x_max, confidence), all float32 in [0,1]).
//   Rows with confidence == 0 are padding and are skipped.
// - No dependency on the hailonet / hailofilter GStreamer plugins or on
//   TAPPAS. Links only against /usr/local/lib/libhailort.so (source-built by
//   deploy/hailo/install-hailo-host.sh).
//
// Non-goals:
// - Async batching across frames. DeepStream per-camera batch-size=1, and the
//   Hailo-8 serves ~60fps yolov11l at batch-1 — good enough for 4-6 cameras
//   on the accelerator before saturation. Move to batched if we ever need it.
// - Hailo-side tracking or multi-model scheduling. Tracking stays in
//   nvtracker downstream, which is where our tripwire / ReID logic already
//   lives.
#pragma once

#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace fnvr {

struct HailoDetection {
    // Network-space normalised bbox, corners in [0, 1].
    float x_min, y_min, x_max, y_max;
    float confidence;       // [0, 1]
    int   class_id;         // COCO class id (0=person, 2=car, ...)
};

class HailoInference {
public:
    // Returns the process-wide singleton, lazily constructed on first call.
    // Throws std::runtime_error on unrecoverable device / HEF errors — the
    // caller (pipeline worker) should catch-log-fallback-to-trt in that case,
    // so a single Hailo camera misconfiguration doesn't kill the supervisor.
    static HailoInference& Instance(const std::string& hef_path);

    // Runs inference on an RGB 640x640 frame. Thread-safe. Blocking.
    // - rgb must point to 640*640*3 bytes laid out as RGB24 row-major
    //   (R, G, B interleaved per pixel, no padding between rows).
    // - `out` is cleared then filled with zero or more detections. Entries
    //   below `score_threshold` are already filtered.
    // Returns true on success. On failure, `out` is left empty; the probe
    // will forward the buffer with no detections for this frame (better
    // than dropping the frame and starving the tracker).
    bool Infer(const uint8_t* rgb, std::vector<HailoDetection>& out,
               float score_threshold = 0.35f);

    // Input dimensions expected by our shipped HEF. Exposed so the upstream
    // NVMM→RGB scaler can be configured to exactly this resolution.
    static constexpr int kInputWidth  = 640;
    static constexpr int kInputHeight = 640;

private:
    explicit HailoInference(const std::string& hef_path);
    ~HailoInference();

    HailoInference(const HailoInference&) = delete;
    HailoInference& operator=(const HailoInference&) = delete;

    struct Impl;
    std::unique_ptr<Impl> impl_;

    // infer() serialises against itself — not because libhailort requires
    // it (the scheduler handles device contention) but because we reuse a
    // single Bindings object and output buffer. One ConfiguredInferModel
    // per device, one Bindings per call would be the next step if contention
    // ever matters.
    std::mutex mu_;
};

} // namespace fnvr

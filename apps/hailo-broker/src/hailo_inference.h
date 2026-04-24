// In-process Hailo-8 inference used by the fnvr-hailo-broker. Public API is
// simple blocking Infer(rgb, out). Internally a dedicated inference thread
// pulls requests from a queue and submits them as a batch of up to
// kMaxBatch frames in one `run_async(vector<Bindings>)` call — concurrent
// callers naturally coalesce when the device is the bottleneck.
//
// Design:
// - One process-wide HailoInference singleton owns the VDevice and the
//   ConfiguredInferModel for the one HEF we ship (`yolov11l.hef`).
// - Multiple broker threads (one per client/camera) call Infer()
//   concurrently; each enqueues a request and blocks on a per-request
//   promise. The single inference thread drains up to kMaxBatch requests
//   per pass and issues one batched libhailort call.
// - Infer() takes an RGB 640x640 buffer (row-major uint8), blocks on the
//   inference completion, and returns decoded detections in network-space
//   (coordinates normalised to [0, 1] via bbox/640). The caller is
//   responsible for scaling into source pixel space.
// - The HEF is expected to have on-device NMS (yolov11l from Hailo Model
//   Zoo — single output tensor: per-class float bbox_count followed by
//   hailo_bbox_float32_t[count]).
// - No dependency on hailonet / hailofilter / TAPPAS. Links only against
//   /usr/local/lib/libhailort.so.
#pragma once

#include <cstdint>
#include <memory>
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
};

} // namespace fnvr

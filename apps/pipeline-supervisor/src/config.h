#pragma once

#include <set>
#include <string>
#include <vector>

namespace fnvr {

struct CameraConfig {
    std::string id;
    std::string url;
    std::string substream_url;   // optional
    std::string recording_mode;  // continuous | motion | event | scheduled | hybrid
    // Classes to drop at the InferSrcProbe before NATS publish. Resolved
    // at worker startup using the same formula as the Go rules engine:
    //   ((global ∪ bucket(location_kind)) \ unmute_override) ∪ mute_override
    // Empty = no mutes; probe short-circuits cheaply.
    std::set<std::string> muted_classes;
    // Clockwise software rotation applied to the decoded stream before
    // encode/record. Valid: 0, 90, 180, 270. Zero is the hot path.
    int rotation = 0;
    // Per-camera detector whitelist from cameras.enabled_detectors.
    // Encoding convention (matches event-processor + UI):
    //   empty        — all SGIE chains permitted (subject to pipeline-
    //                  level kill switches)
    //   ["none"]     — no inference at all; pipeline builds a
    //                  passthrough record branch
    //   ["object"]   — PGIE only, no ANPR/face SGIEs
    //   ["object","anpr","face"] etc — whitelist
    std::vector<std::string> enabled_detectors;
    // When true, the pipeline rewrites the rtspsrc URL to
    // rtsp://mediamtx:8554/proxy_<id> — MediaMTX has already been
    // configured by api-server to proxy the real upstream URL. Used to
    // launder broken RTSP bitstreams through a software re-muxer.
    bool mtx_proxy = false;
    // Primary-detector backend: "trt" (default, DeepStream nvinfer on
    // the Orin GPU) or "hailo" (hailonet via Hailo-8 PCIe
    // accelerator). Per-camera so operators migrate one camera at a
    // time and choose which cameras get the scarce Hailo compute.
    std::string detector_backend = "trt";
};

struct Config {
    std::string nats_url;         // e.g. "nats://nats:4222"
    std::string database_url;     // e.g. "postgres://fnvr:fnvr@postgres:5432/fnvr?sslmode=disable"
    std::string recordings_dir;   // e.g. "/var/lib/fnvr/recordings"
    std::string inference_config; // path to nvinfer config file
    bool        use_deepstream;   // false on non-Jetson dev (record-only)
    // Inserts the LPDNet + LPRNet SGIE chain after the tracker. When
    // off, the pipeline is unchanged from the object-only shape.
    bool        use_anpr;
    // Inserts the SCRFD + ArcFace chain. Independent of ANPR — both
    // can be on at once.
    bool        use_face_id;
    int         reconcile_interval_sec;
};

Config LoadFromEnv();

}  // namespace fnvr

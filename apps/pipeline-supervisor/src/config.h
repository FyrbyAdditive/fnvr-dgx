#pragma once

#include <string>
#include <vector>

namespace fnvr {

struct CameraConfig {
    std::string id;
    std::string url;
    std::string substream_url;   // optional
    std::string recording_mode;  // continuous | motion | event | scheduled | hybrid
};

struct Config {
    std::string nats_url;         // e.g. "nats://nats:4222"
    std::string database_url;     // e.g. "postgres://fnvr:fnvr@postgres:5432/fnvr?sslmode=disable"
    std::string recordings_dir;   // e.g. "/var/lib/fnvr/recordings"
    std::string inference_config; // path to nvinfer config file
    bool        use_deepstream;   // false on non-Jetson dev (record-only)
    int         reconcile_interval_sec;
};

Config LoadFromEnv();

}  // namespace fnvr

#include "config.h"

#include <cstdlib>
#include <string>

namespace fnvr {

static std::string env_or(const char* k, const std::string& def) {
    const char* v = std::getenv(k);
    return (v && *v) ? std::string(v) : def;
}

static int env_int(const char* k, int def) {
    const char* v = std::getenv(k);
    if (!v || !*v) return def;
    try { return std::stoi(v); } catch (...) { return def; }
}

Config LoadFromEnv() {
    Config cfg;
    cfg.nats_url         = env_or("FNVR_NATS_URL", "nats://nats:4222");
    cfg.database_url     = env_or("FNVR_DATABASE_URL",
        "postgres://fnvr:fnvr@postgres:5432/fnvr?sslmode=disable");
    cfg.recordings_dir   = env_or("FNVR_RECORDINGS_DIR", "/var/lib/fnvr/recordings");
    cfg.inference_config = env_or("FNVR_INFER_CONFIG", "/etc/fnvr/nvinfer/trafficcamnet.txt");
    cfg.use_deepstream   = env_or("FNVR_USE_DEEPSTREAM", "1") != "0";
    cfg.use_anpr         = env_or("FNVR_USE_ANPR", "0") == "1";
    cfg.reconcile_interval_sec = env_int("FNVR_RECONCILE_SEC", 5);
    return cfg;
}

}  // namespace fnvr

#pragma once

#include <set>
#include <string>
#include <vector>

#include "config.h"

namespace fnvr {

// ReadEnabledCameras returns the list of enabled cameras from Postgres.
// Returns an empty vector on any error (logged to stderr) — reconcile
// treats "I don't know" as "change nothing", not "tear everything down".
std::vector<CameraConfig> ReadEnabledCameras(const std::string& database_url);

// ReadMutedClassesForCamera resolves the class-mute hierarchy for one
// camera: global bucket ∪ matching indoor/outdoor bucket, minus the
// camera's unmute_override, plus its mute_override. Called once per
// worker at startup so the result is a point-in-time snapshot — changes
// take effect on the next pipeline restart. Errors (missing keys,
// unreachable DB) return empty; the probe treats empty as "publish
// everything", which is the safe default.
std::set<std::string> ReadMutedClassesForCamera(
    const std::string& database_url, const std::string& camera_id);

// ReadRotationForCamera fetches the `rotation` column for one camera,
// returning 0 on any error (missing row, DB unreachable, unparseable
// value). Workers call this at startup so the per-camera config loaded
// via argv doesn't need a separate plumbing hop through the supervisor.
int ReadRotationForCamera(
    const std::string& database_url, const std::string& camera_id);

// ReadEnabledDetectorsForCamera fetches the `enabled_detectors` text[]
// column. Returns an empty vector on any error — callers treat empty
// as "all detectors enabled" (the friendly default shared with the
// event-processor + UI). A returned ["none"] means the operator
// explicitly opted this camera out of inference.
std::vector<std::string> ReadEnabledDetectorsForCamera(
    const std::string& database_url, const std::string& camera_id);

// ReadMtxProxyForCamera returns the cameras.mtx_proxy flag. Defaults
// to false on any error. When true, the worker rewrites the rtspsrc
// URL to pull via MediaMTX instead of the source directly.
bool ReadMtxProxyForCamera(
    const std::string& database_url, const std::string& camera_id);

}  // namespace fnvr

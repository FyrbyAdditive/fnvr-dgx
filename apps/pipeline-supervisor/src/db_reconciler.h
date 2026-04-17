#pragma once

#include <string>
#include <vector>

#include "config.h"

namespace fnvr {

// ReadEnabledCameras returns the list of enabled cameras from Postgres.
// Returns an empty vector on any error (logged to stderr) — reconcile
// treats "I don't know" as "change nothing", not "tear everything down".
std::vector<CameraConfig> ReadEnabledCameras(const std::string& database_url);

}  // namespace fnvr

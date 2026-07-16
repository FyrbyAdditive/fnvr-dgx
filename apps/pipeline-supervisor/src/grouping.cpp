#include "grouping.h"

#include <algorithm>
#include <map>
#include <sstream>

namespace fnvr {

namespace {

bool isNone(const CameraConfig& cam) {
    return cam.enabled_detectors.size() == 1 &&
           cam.enabled_detectors[0] == "none";
}

bool needsTranscode(const CameraConfig& cam) {
    return cam.rotation != 0 || cam.mtx_proxy;
}

std::string detectorsKey(const CameraConfig& cam) {
    if (cam.enabled_detectors.empty()) return "all";
    std::set<std::string> s(cam.enabled_detectors.begin(),
                            cam.enabled_detectors.end());
    std::string out;
    for (const auto& d : s) {
        if (!out.empty()) out += "+";
        out += d;
    }
    return out;
}

}  // namespace

std::string ShapeKey(const CameraConfig& cam) {
    if (isNone(cam)) return "none";
    if (needsTranscode(cam)) return "transcode";
    return detectorsKey(cam);
}

std::vector<GroupPlan> PlanGroups(const std::vector<CameraConfig>& cameras,
                                  const std::set<std::string>& quarantined,
                                  const std::set<std::string>& probation,
                                  int group_max) {
    if (group_max < 1) group_max = 1;

    std::vector<GroupPlan> out;
    std::map<std::string, std::vector<CameraConfig>> batchable;

    for (const auto& cam : cameras) {
        if (quarantined.count(cam.id)) continue;
        if (probation.count(cam.id)) {
            GroupPlan p;
            p.group_id  = "probation-" + cam.id;
            p.members   = {cam};
            p.probation = true;
            out.push_back(std::move(p));
            continue;
        }
        const std::string key = ShapeKey(cam);
        // Record-only and transcode cameras get bespoke graphs — solo,
        // with a stable id independent of fleet ordering.
        if (key == "none" || key == "transcode") {
            GroupPlan p;
            p.group_id = "solo-" + cam.id;
            p.members  = {cam};
            out.push_back(std::move(p));
            continue;
        }
        batchable[key].push_back(cam);
    }

    for (auto& [key, members] : batchable) {
        std::sort(members.begin(), members.end(),
                  [](const CameraConfig& a, const CameraConfig& b) {
                      return a.id < b.id;
                  });
        int chunk = 0;
        for (size_t off = 0; off < members.size();
             off += size_t(group_max), chunk++) {
            GroupPlan p;
            p.group_id = key + "-" + std::to_string(chunk);
            const size_t end = std::min(members.size(),
                                        off + size_t(group_max));
            p.members.assign(members.begin() + off, members.begin() + end);
            out.push_back(std::move(p));
        }
    }

    // Deterministic overall order (group_id is unique).
    std::sort(out.begin(), out.end(),
              [](const GroupPlan& a, const GroupPlan& b) {
                  return a.group_id < b.group_id;
              });
    return out;
}

std::string Signature(const GroupPlan& plan) {
    std::ostringstream os;
    os << plan.group_id << (plan.probation ? "!p" : "");
    for (const auto& m : plan.members) {
        os << "|" << m.id << ";" << m.url << ";" << m.substream_url << ";"
           << m.rotation << ";" << (m.mtx_proxy ? 1 : 0) << ";"
           << m.recording_mode << ";" << detectorsKey(m);
    }
    return os.str();
}

}  // namespace fnvr

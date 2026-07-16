#pragma once

// Camera → worker-group planning for the batched-mux architecture.
//
// Cameras whose GStreamer graph has the same SHAPE (same SGIE chain,
// no transcode) share one worker process with a single batched
// nvstreammux + one TensorRT engine. Cameras that need a bespoke graph
// stay solo:
//   - enabled_detectors == ["none"]  → record-only graph, nothing to batch
//   - rotation != 0 or mtx_proxy     → per-source transcode graph
//
// Grouping policy follows the analysis in
// tools/benchmark/baseline-2026-05-03.txt §6 (the Orin-era plan this
// implements) with one refinement: quarantined members are excluded
// from their natural group and re-admitted through a solo "probation"
// group, so one chronically-faulting camera cannot keep restarting its
// healthy siblings.

#include <set>
#include <string>
#include <vector>

#include "config.h"

namespace fnvr {

struct GroupPlan {
    // Stable identifier: "<shape>-<chunk>" for batched groups,
    // "solo-<camera_id>" for bespoke graphs, "probation-<camera_id>"
    // for quarantine re-admission.
    std::string group_id;
    // Members sorted by camera id — deterministic membership means the
    // reconcile diff only fires on real changes.
    std::vector<CameraConfig> members;
    // True when this is a quarantine re-admission group: the supervisor
    // clears the member's quarantine entry once it has run healthily,
    // letting the next replan merge it back into its natural group.
    bool probation = false;
};

// ShapeKey buckets a camera by the graph shape it needs. Cameras with
// equal keys can share a batched pipeline.
std::string ShapeKey(const CameraConfig& cam);

// PlanGroups partitions `cameras` into worker groups.
//   quarantined — camera ids to leave out entirely (still backing off)
//   probation   — camera ids to plan as solo probation groups
//   group_max   — max members per batched group (engine max batch is
//                 sized to this; see FNVR_GROUP_MAX / $BATCH)
std::vector<GroupPlan> PlanGroups(const std::vector<CameraConfig>& cameras,
                                  const std::set<std::string>& quarantined,
                                  const std::set<std::string>& probation,
                                  int group_max);

// Signature returns a canonical string covering everything about a
// plan that requires a worker restart when it changes: membership and
// each member's url/rotation/detectors/mtx_proxy/recording_mode.
std::string Signature(const GroupPlan& plan);

}  // namespace fnvr

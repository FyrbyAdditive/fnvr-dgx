#pragma once

#include <atomic>
#include <chrono>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include <gst/gst.h>

#include "config.h"
#include "nats_publisher.h"

namespace fnvr {

// Set the grace window (seconds) used by the bus-error hard-exit path
// to suppress its "failed" NATS publish. Called by the worker child
// process at startup with the value from settings.pipeline.startup_grace_sec.
void SetWorkerStartupGraceSec(int sec);

// Per-member runtime state inside a group pipeline. Owned by
// GroupPipeline; referenced (never owned) by the pad probes.
struct SourceRuntime {
    CameraConfig cam;
    // Codec carried on this member's tee ("h264"/"h265"); probed
    // before graph construction, drives depay/parse element choice.
    std::string codec = "h264";
    // Probed source dimensions (0 = unknown).
    int probed_w = 0, probed_h = 0;
    // Substream (inference) codec/dims when cam.substream_url is set —
    // the decode leg then reads the substream and the main stream is
    // relayed to MediaMTX without ever touching NVDEC.
    std::string sub_codec = "h264";
    int sub_w = 0, sub_h = 0;
    // Frames observed for this source at the detection probe. The
    // heartbeat thread derives per-camera running/stalled from this;
    // the flow watchdog sums across sources.
    std::atomic<std::uint64_t> frames{0};
    // Set when this member's source chain posted a bus ERROR. The
    // branch is dead until the group's debounced self-heal restart;
    // siblings keep streaming meanwhile.
    std::atomic<bool> dead{false};
    // Push-leg health counters: encoded frames entering the member's
    // chain (depay src) vs frames actually handed to rtspclientsink
    // (push sink pad). A healthy relay keeps these in lockstep; a
    // stress window (GPU contention, mediamtx hiccup) can leave the
    // sink pacing below the input rate PERMANENTLY while the leaky
    // queue eats the difference — live tiles then stutter at a
    // fraction of real fps until the process restarts. The push
    // watchdog in main.cpp compares the two and self-heals.
    std::atomic<std::uint64_t> input_frames{0};
    std::atomic<std::uint64_t> push_frames{0};
};

// GroupPipeline — the batched-mux shape. N member cameras share one
// process: per-member rtspsrc → depay → parse → tee with (a) a decode
// leg into nvstreammux sink_i and (b) a push leg to MediaMTX; one
// nvstreammux batch-size=N → nvinfer → nvtracker → optional SGIEs →
// fakesink, with the detection/preview probes walking the batch and
// attributing frames to members via frame_meta->pad_index.
//
// N==1 degenerates to the old SingleCameraPipeline shape, including
// the bespoke solo graphs (record-only "none" cameras and
// rotation/mtx_proxy transcode cameras — the planner never batches
// those).
class GroupPipeline {
public:
    GroupPipeline(std::string group_id, std::vector<CameraConfig> members,
                  std::string recordings_dir, std::string infer_config,
                  bool use_deepstream, bool use_anpr, bool use_face_id,
                  NatsPublisher* nats);
    ~GroupPipeline();

    bool Start();
    void Stop();

    size_t MemberCount() const { return sources_.size(); }
    const CameraConfig& Member(size_t i) const { return sources_[i]->cam; }
    std::uint64_t FramesForSource(size_t i) const {
        return sources_[i]->frames.load(std::memory_order_relaxed);
    }
    std::uint64_t InputFramesForSource(size_t i) const {
        return sources_[i]->input_frames.load(std::memory_order_relaxed);
    }
    std::uint64_t PushFramesForSource(size_t i) const {
        return sources_[i]->push_frames.load(std::memory_order_relaxed);
    }
    bool MemberDead(size_t i) const {
        return sources_[i]->dead.load(std::memory_order_relaxed);
    }
    std::uint64_t TotalFrames() const {
        std::uint64_t t = 0;
        for (const auto& s : sources_) t += s->frames.load(std::memory_order_relaxed);
        return t;
    }
    // True when the graph contains an inference branch (frames counters
    // advance). Record-only solo graphs have no counters to watch.
    bool HasInference() const { return has_inference_; }

    bool Faulted() const { return faulted_.load(); }
    bool Playing() const { return playing_.load(); }
    void Fault() { faulted_.store(true); }
    // Member-death bookkeeping for the debounced self-heal restart.
    int DeadMembers() const { return dead_members_.load(); }
    // Monotonic time of the FIRST unhealed member death (0 = none).
    std::chrono::steady_clock::time_point FirstDeathAt() const {
        return first_death_at_;
    }

private:
    GstElement* BuildPipeline();
    // Builds the per-member source string (rtspsrc → ... → tee legs)
    // for member i, appending to `p`. Solo bespoke shapes are handled
    // inside BuildPipeline directly.
    static gboolean BusHandler(GstBus*, GstMessage*, gpointer user_data);

    std::string      group_id_;
    std::vector<std::unique_ptr<SourceRuntime>> sources_;
    std::string      recordings_dir_;
    std::string      infer_config_;
    bool             use_deepstream_;
    bool             use_anpr_ = false;
    bool             use_face_id_ = false;
    bool             has_inference_ = false;
    NatsPublisher*   nats_ = nullptr;
    GstElement*      pipeline_ = nullptr;
    guint            bus_watch_id_ = 0;
    std::atomic<bool> faulted_{false};
    std::atomic<bool> playing_{false};
    std::atomic<int>  dead_members_{0};
    std::chrono::steady_clock::time_point first_death_at_{};

    // Mux canvas. N==1: probed source dims (aspect-exact, no
    // letterbox). N>1: fixed canvas; sources letterbox into it and the
    // probes invert the mapping when normalising bboxes.
    int mux_w_ = 0;
    int mux_h_ = 0;
};

}  // namespace fnvr

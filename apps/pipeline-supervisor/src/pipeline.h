#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>

#include <gst/gst.h>

#include "config.h"
#include "nats_publisher.h"

namespace fnvr {

// Set the grace window (seconds) used by the bus-error hard-exit path
// to suppress its "failed" NATS publish. Called by the worker child
// process at startup with the value from settings.pipeline.startup_grace_sec.
// Without this, a slow-to-connect source (MediaMTX-proxied, cold-boot
// TLS, etc.) fires `failed` in the UI on its first warmup exit even
// though the supervisor is about to respawn and succeed.
void SetWorkerStartupGraceSec(int sec);

class WhepServer;

// SingleCameraPipeline is the M2 shape: one camera in, record + (if DeepStream
// is available) detect. One pipeline per camera keeps the M2 blast-radius tiny;
// M3 replaces this with batched nvstreammux across a group of cameras.
class SingleCameraPipeline {
public:
    SingleCameraPipeline(CameraConfig cam, std::string recordings_dir,
                         std::string infer_config, bool use_deepstream,
                         bool use_anpr, bool use_face_id,
                         NatsPublisher* nats);
    ~SingleCameraPipeline();

    bool Start();
    void Stop();

    // Port the WHEP server is listening on, or 0 if disabled.
    int WhepPort() const;

private:
    GstElement* BuildPipeline();
    static gboolean BusHandler(GstBus*, GstMessage*, gpointer user_data);

    CameraConfig     cam_;
    std::string      recordings_dir_;
    std::string      infer_config_;
    bool             use_deepstream_;
    bool             use_anpr_ = false;
    bool             use_face_id_ = false;
    NatsPublisher*   nats_ = nullptr;
    GstElement*      pipeline_ = nullptr;
    guint            bus_watch_id_ = 0;
    std::atomic<bool> faulted_{false};
    // Flips true the first time the bus reports GST_STATE_PLAYING.
    // Used by main.cpp's watchdog to detect "pipeline never rolled"
    // — e.g. rtspsrc hung between TCP connect and SETUP reply.
    std::atomic<bool> playing_{false};
    // Incremented by a pad probe on recparse (last pre-mux element
    // in the record branch) for every buffer that flows. main.cpp's
    // flow_watchdog samples this every 5 s; if it doesn't advance
    // for 20 s while Playing() is true, the worker hard-exits so
    // the supervisor respawns. Catches NvMedia wedges where the
    // pipeline goes silent without firing a bus ERROR.
    std::atomic<std::uint64_t> buffersPassed_{0};
    std::unique_ptr<WhepServer> whep_;

    // Target dimensions for the recording / inference branch. Zero until
    // BuildPipeline has probed the source; caps for nvstreammux and the
    // inference encoder key off these so aspect is preserved end-to-end.
    int rec_width_ = 0;
    int rec_height_ = 0;
    // Codec carried on the gst tee — "h264" or "h265". Set during
    // BuildPipelineString based on probed source codec + transcode
    // decision; consumed when the WHEP server is constructed in
    // Start() so it can advertise the matching encoding-name in
    // the SDP it returns to browsers.
    std::string pipeline_codec_ = "h264";

public:
    bool Faulted() const { return faulted_.load(); }
    bool Playing() const { return playing_.load(); }
    void Fault() { faulted_.store(true); }
    // Buffers that have passed the record-branch parse element since
    // worker startup. Sampled by the flow watchdog.
    std::uint64_t BuffersPassed() const { return buffersPassed_.load(); }
};

}  // namespace fnvr

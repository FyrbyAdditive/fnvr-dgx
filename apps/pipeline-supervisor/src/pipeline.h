#pragma once

#include <atomic>
#include <memory>
#include <string>

#include <gst/gst.h>

#include "config.h"
#include "nats_publisher.h"

namespace fnvr {

// SingleCameraPipeline is the M2 shape: one camera in, record + (if DeepStream
// is available) detect. One pipeline per camera keeps the M2 blast-radius tiny;
// M3 replaces this with batched nvstreammux across a group of cameras.
class SingleCameraPipeline {
public:
    SingleCameraPipeline(CameraConfig cam, std::string recordings_dir,
                         std::string infer_config, bool use_deepstream,
                         NatsPublisher* nats);
    ~SingleCameraPipeline();

    bool Start();
    void Stop();

private:
    GstElement* BuildPipeline();
    static gboolean BusHandler(GstBus*, GstMessage*, gpointer user_data);

    CameraConfig     cam_;
    std::string      recordings_dir_;
    std::string      infer_config_;
    bool             use_deepstream_;
    NatsPublisher*   nats_ = nullptr;
    GstElement*      pipeline_ = nullptr;
    guint            bus_watch_id_ = 0;
    std::atomic<bool> faulted_{false};

public:
    bool Faulted() const { return faulted_.load(); }
};

}  // namespace fnvr

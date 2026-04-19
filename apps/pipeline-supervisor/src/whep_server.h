#pragma once

#include <atomic>
#include <memory>
#include <string>
#include <thread>

#include <gst/gst.h>

namespace fnvr {

// WhepServer hosts a WHEP-like HTTP endpoint for a single camera. On
// `POST /whep` with an SDP offer in the body, it creates a fresh
// `webrtcbin` linked to a shared RTP payloader (fed by the main
// recording pipeline), runs the SDP offer/answer dance, and returns
// the answer SDP. Each concurrent viewer gets its own webrtcbin.
//
// The server binds to 127.0.0.1 on an OS-chosen port; the worker
// logs the port + publishes it on NATS so api-server can proxy
// browser requests here.
class WhepServer {
public:
    // `rtp_tee` is a `tee` element the main pipeline exposes; new
    // webrtcbins get linked to a fresh src pad on this tee.
    WhepServer(std::string camera_id, GstElement* pipeline, GstElement* rtp_tee);
    ~WhepServer();

    bool Start();
    void Stop();

    int port() const { return port_; }

private:
    void acceptLoop();
    std::string handleOffer(const std::string& offer_sdp);

    std::string camera_id_;
    GstElement* pipeline_ = nullptr;
    GstElement* rtp_tee_  = nullptr;

    int               port_ = 0;
    int               listen_fd_ = -1;
    std::atomic<bool> stop_{false};
    std::thread       thread_;
};

}  // namespace fnvr

#pragma once

#include <atomic>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include <gst/gst.h>

namespace fnvr {

// WhepSession ties a single viewer's webrtcbin + queue + tee request pad
// together so they can be torn down as a unit when the browser goes away.
// Created on POST /whep, removed on DELETE /whep/<sid> (or by the
// backstop sweeper when the session's peer connection enters a terminal
// state). Each session is keyed by a random 16-hex-char `sid`; that sid
// is returned to the client in the Location header of the 201 response.
struct WhepSession {
    std::string  sid;
    GstElement*  webrtc = nullptr;        // not owned; held by pipeline
    GstElement*  queue  = nullptr;        // not owned
    GstPad*      tee_src = nullptr;       // owned (release on teardown)
    // Time we last observed the peer connection in a non-terminal state.
    // The backstop sweeper compares against now() to age out broken
    // sessions whose DELETE never arrived.
    int64_t      last_alive_ms = 0;
};

// WhepServer hosts a WHEP-compliant HTTP endpoint for a single camera.
//
//   POST   /whep             SDP offer in body, returns 201 + Location:
//                            /whep/<sid> + SDP answer.
//   DELETE /whep/<sid>       Tears down the session synchronously; the
//                            webrtcbin is pad-blocked + removed.
//
// The session map + a periodic backstop sweeper protect against
// browsers that crash or close without sending DELETE.
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
    void sweeperLoop();
    // Negotiates a fresh session. Returns empty `sid` on failure.
    // `out_sid` filled with the new session id; `out_sdp` with the SDP
    // answer to send back.
    bool handleOffer(const std::string& offer_sdp,
                     std::string* out_sid, std::string* out_sdp);
    // Synchronously tears down the named session. Returns true if the
    // session existed and was removed.
    bool handleDelete(const std::string& sid);
    // Pad-block + remove an entire WhepSession from the pipeline. Safe
    // to call from any thread; uses gst_pad_add_probe to wait for the
    // tee_src pad to be idle before unlinking.
    void teardownSession(std::unique_ptr<WhepSession> sess);

    std::string camera_id_;
    GstElement* pipeline_ = nullptr;
    GstElement* rtp_tee_  = nullptr;

    int               port_ = 0;
    int               listen_fd_ = -1;
    std::atomic<bool> stop_{false};
    std::thread       thread_;
    std::thread       sweeper_thread_;

    // Active sessions, keyed by sid. Guarded by sessions_mu_. The map
    // owns each WhepSession via unique_ptr; teardown moves it out
    // before the pad-block + remove sequence.
    std::mutex                                          sessions_mu_;
    std::map<std::string, std::unique_ptr<WhepSession>> sessions_;
};

}  // namespace fnvr

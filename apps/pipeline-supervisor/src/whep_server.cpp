#include "whep_server.h"

#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <memory>
#include <mutex>
#include <random>
#include <sstream>
#include <string>
#include <vector>

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <gst/sdp/sdp.h>
#include <gst/webrtc/webrtc.h>

namespace fnvr {

namespace {

// Read an HTTP request off a connected socket. Returns headers + body.
// Minimal parser — handles Content-Length; no chunked, no TLS.
struct HttpReq {
    std::string method;
    std::string path;
    std::string body;
};

bool ReadRequest(int fd, HttpReq* out) {
    std::string buf;
    std::array<char, 4096> chunk;
    size_t headers_end = std::string::npos;
    while (headers_end == std::string::npos) {
        ssize_t n = read(fd, chunk.data(), chunk.size());
        if (n <= 0) return false;
        buf.append(chunk.data(), n);
        headers_end = buf.find("\r\n\r\n");
        if (buf.size() > 64 * 1024) return false;  // runaway protection
    }
    // Parse request line.
    size_t sp1 = buf.find(' ');
    size_t sp2 = buf.find(' ', sp1 + 1);
    size_t crlf = buf.find("\r\n");
    if (sp1 == std::string::npos || sp2 == std::string::npos || crlf == std::string::npos) return false;
    out->method = buf.substr(0, sp1);
    out->path = buf.substr(sp1 + 1, sp2 - sp1 - 1);

    // Parse Content-Length.
    size_t clen = 0;
    const std::string headers = buf.substr(0, headers_end);
    size_t pos = 0;
    while (pos < headers.size()) {
        size_t eol = headers.find("\r\n", pos);
        if (eol == std::string::npos) break;
        std::string line = headers.substr(pos, eol - pos);
        pos = eol + 2;
        if (line.size() >= 16) {
            std::string lower;
            lower.reserve(line.size());
            for (char c : line.substr(0, 15)) lower += char(c | 0x20);
            if (lower == "content-length:") {
                try { clen = std::stoul(line.substr(15)); } catch (...) { clen = 0; }
            }
        }
    }

    size_t body_start = headers_end + 4;
    out->body = buf.substr(body_start);
    while (out->body.size() < clen) {
        ssize_t n = read(fd, chunk.data(), chunk.size());
        if (n <= 0) return false;
        out->body.append(chunk.data(), n);
    }
    out->body.resize(clen);  // exact
    return true;
}

void WriteResponse(int fd, int code, const std::string& content_type,
                   const std::string& body,
                   const std::string& extra_headers = {}) {
    std::ostringstream os;
    os << "HTTP/1.1 " << code << " OK\r\n"
       << "Content-Type: " << content_type << "\r\n"
       << "Access-Control-Allow-Origin: *\r\n"
       << "Access-Control-Allow-Methods: POST, OPTIONS, DELETE\r\n"
       << "Access-Control-Allow-Headers: Content-Type\r\n"
       << "Access-Control-Expose-Headers: Location\r\n";
    if (!extra_headers.empty()) os << extra_headers;
    os << "Content-Length: " << body.size() << "\r\n"
       << "\r\n"
       << body;
    const std::string s = os.str();
    size_t sent = 0;
    while (sent < s.size()) {
        ssize_t n = write(fd, s.data() + sent, s.size() - sent);
        if (n <= 0) break;
        sent += n;
    }
}

// Random 16-hex-char session id. Not cryptographically authenticated
// (the worker only sees pre-authenticated requests via api-server's WHEP
// proxy), just unique enough to key the session map without collision.
std::string GenerateSid() {
    static thread_local std::mt19937_64 rng{
        static_cast<uint64_t>(
            std::chrono::steady_clock::now().time_since_epoch().count()) ^
        static_cast<uint64_t>(::getpid())};
    uint64_t v = rng();
    char buf[17];
    std::snprintf(buf, sizeof(buf), "%016lx", static_cast<unsigned long>(v));
    return std::string(buf, 16);
}

// Monotonic-clock millisecond timestamp.
int64_t NowMs() {
    auto now = std::chrono::steady_clock::now().time_since_epoch();
    return std::chrono::duration_cast<std::chrono::milliseconds>(now).count();
}

// State for the pad-block + remove sequence. Lives on the heap because
// the GStreamer probe callback may run on a streaming thread that
// outlives the function that scheduled the teardown. Freed by the
// callback after element removal.
struct TeardownCtx {
    GstElement* pipeline;
    GstElement* tee;
    GstPad*     tee_src;     // the request pad on the tee, to be released
    GstElement* queue;       // the queue downstream of the tee
    GstElement* webrtc;      // the webrtcbin downstream of the queue
};

// Pad-probe callback fired when the tee_src pad is idle (no buffer in
// flight). At this point it's safe to unlink, set elements to NULL,
// release the request pad, and remove from the bin. Runs on whichever
// thread happened to make the pad idle — typically the streaming thread
// — but only ever runs once per probe.
GstPadProbeReturn TeardownPadIdleCb(GstPad* /*pad*/, GstPadProbeInfo* /*info*/, gpointer user) {
    auto* ctx = static_cast<TeardownCtx*>(user);

    // Set both elements to NULL state first so any in-flight buffers
    // sitting in queues are flushed before unlink/remove.
    if (ctx->webrtc) gst_element_set_state(ctx->webrtc, GST_STATE_NULL);
    if (ctx->queue)  gst_element_set_state(ctx->queue,  GST_STATE_NULL);

    // Release the tee request pad — frees its src pad slot back to the
    // tee element so a future viewer can request a fresh one.
    if (ctx->tee && ctx->tee_src) {
        gst_element_release_request_pad(ctx->tee, ctx->tee_src);
        gst_object_unref(ctx->tee_src);
        ctx->tee_src = nullptr;
    }

    // Remove from the parent bin — drops the bin's owning reference, so
    // refcount goes to 0 and the elements are destroyed (along with all
    // their internal threads — webrtcbin/rtpsession-rtcp/jitterbuffer/etc).
    if (ctx->pipeline && ctx->webrtc) {
        gst_bin_remove(GST_BIN(ctx->pipeline), ctx->webrtc);
    }
    if (ctx->pipeline && ctx->queue) {
        gst_bin_remove(GST_BIN(ctx->pipeline), ctx->queue);
    }

    delete ctx;
    return GST_PAD_PROBE_REMOVE;
}

}  // namespace

WhepServer::WhepServer(std::string camera_id, GstElement* pipeline, GstElement* rtp_tee,
                       std::string codec)
    : camera_id_(std::move(camera_id)), pipeline_(pipeline), rtp_tee_(rtp_tee),
      codec_(std::move(codec)) {}

WhepServer::~WhepServer() { Stop(); }

bool WhepServer::Start() {
    listen_fd_ = socket(AF_INET, SOCK_STREAM, 0);
    if (listen_fd_ < 0) return false;
    int one = 1;
    setsockopt(listen_fd_, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_addr.s_addr = htonl(INADDR_ANY);
    a.sin_port = 0;  // OS-chosen
    if (bind(listen_fd_, (sockaddr*)&a, sizeof(a)) < 0) {
        std::cerr << "whep[" << camera_id_ << "]: bind failed\n";
        close(listen_fd_); listen_fd_ = -1;
        return false;
    }
    socklen_t slen = sizeof(a);
    getsockname(listen_fd_, (sockaddr*)&a, &slen);
    port_ = ntohs(a.sin_port);
    if (listen(listen_fd_, 8) < 0) {
        close(listen_fd_); listen_fd_ = -1;
        return false;
    }
    std::cerr << "whep[" << camera_id_ << "]: listening on port " << port_ << "\n";
    thread_ = std::thread([this] { acceptLoop(); });
    sweeper_thread_ = std::thread([this] { sweeperLoop(); });
    return true;
}

void WhepServer::Stop() {
    stop_ = true;
    if (listen_fd_ >= 0) {
        shutdown(listen_fd_, SHUT_RDWR);
        close(listen_fd_);
        listen_fd_ = -1;
    }
    if (thread_.joinable()) thread_.join();
    if (sweeper_thread_.joinable()) sweeper_thread_.join();

    // Drain any sessions still active at shutdown so their elements are
    // removed before the parent pipeline goes away.
    std::map<std::string, std::unique_ptr<WhepSession>> drained;
    {
        std::lock_guard<std::mutex> lk(sessions_mu_);
        sessions_.swap(drained);
    }
    for (auto& kv : drained) {
        teardownSession(std::move(kv.second));
    }
}

void WhepServer::acceptLoop() {
    while (!stop_) {
        sockaddr_in c{};
        socklen_t clen = sizeof(c);
        int fd = accept(listen_fd_, (sockaddr*)&c, &clen);
        if (fd < 0) {
            if (stop_) break;
            continue;
        }
        HttpReq req;
        if (!ReadRequest(fd, &req)) {
            WriteResponse(fd, 400, "text/plain", "bad request");
            close(fd);
            continue;
        }
        if (req.method == "OPTIONS") {
            WriteResponse(fd, 204, "text/plain", "");
            close(fd);
            continue;
        }
        if (req.method == "POST" && req.path == "/whep") {
            std::string sid, answer;
            if (!handleOffer(req.body, &sid, &answer)) {
                WriteResponse(fd, 500, "text/plain", "negotiation failed");
            } else {
                std::ostringstream loc;
                loc << "Location: /whep/" << sid << "\r\n";
                WriteResponse(fd, 201, "application/sdp", answer, loc.str());
            }
            close(fd);
            continue;
        }
        // DELETE /whep/<sid> — WHEP-spec session termination. Drops the
        // matching webrtcbin/queue from the pipeline, releases the tee
        // request pad. Synchronous: we don't return until the teardown
        // sequence is scheduled (pad-block probe added) and the
        // session's removed from the map.
        if (req.method == "DELETE" && req.path.rfind("/whep/", 0) == 0 &&
            req.path.size() > 6) {
            std::string sid = req.path.substr(6);
            if (handleDelete(sid)) {
                WriteResponse(fd, 200, "text/plain", "");
            } else {
                WriteResponse(fd, 404, "text/plain", "session not found");
            }
            close(fd);
            continue;
        }
        WriteResponse(fd, 404, "text/plain", "not found");
        close(fd);
    }
}

bool WhepServer::handleOffer(const std::string& offer_sdp,
                             std::string* out_sid, std::string* out_sdp) {
    // Create a fresh webrtcbin per viewer, link a new pad off the shared
    // RTP tee into it, set the remote offer, create answer, wait for
    // ICE gathering, return the local SDP.
    GstElement* webrtc = gst_element_factory_make("webrtcbin", nullptr);
    if (!webrtc) return false;
    g_object_set(webrtc,
                 "bundle-policy", 3 /* max-bundle */,
                 "stun-server", "stun://stun.l.google.com:19302",
                 nullptr);

    GstElement* queue = gst_element_factory_make("queue", nullptr);
    gst_bin_add_many(GST_BIN(pipeline_), webrtc, queue, nullptr);

    GstPad* tee_src = gst_element_request_pad_simple(rtp_tee_, "src_%u");
    GstPad* q_sink  = gst_element_get_static_pad(queue, "sink");
    if (gst_pad_link(tee_src, q_sink) != GST_PAD_LINK_OK) {
        std::cerr << "whep: tee link failed\n";
        gst_object_unref(tee_src); gst_object_unref(q_sink);
        return false;
    }
    gst_object_unref(q_sink);

    // RTP caps for the queue → webrtcbin link. Determines the SDP
    // the browser sees. H.265 doesn't take packetization-mode (that's
    // H.264-specific); use payload type 97 to match how rtph265pay
    // is wired upstream in pipeline.cpp.
    GstCaps* caps = (codec_ == "h265")
        ? gst_caps_from_string(
              "application/x-rtp,media=video,encoding-name=H265,payload=97,"
              "clock-rate=90000")
        : gst_caps_from_string(
              "application/x-rtp,media=video,encoding-name=H264,payload=96,"
              "clock-rate=90000,packetization-mode=(string)1");
    if (!gst_element_link_filtered(queue, webrtc, caps)) {
        std::cerr << "whep: queue→webrtcbin link failed\n";
        gst_caps_unref(caps);
        return false;
    }
    gst_caps_unref(caps);

    gst_element_sync_state_with_parent(queue);
    gst_element_sync_state_with_parent(webrtc);

    // Parse browser offer into a GstWebRTCSessionDescription.
    GstSDPMessage* sdp_msg = nullptr;
    if (gst_sdp_message_new(&sdp_msg) != GST_SDP_OK) return false;
    if (gst_sdp_message_parse_buffer((const guint8*)offer_sdp.data(), offer_sdp.size(), sdp_msg) != GST_SDP_OK) {
        gst_sdp_message_free(sdp_msg);
        return false;
    }
    GstWebRTCSessionDescription* remote =
        gst_webrtc_session_description_new(GST_WEBRTC_SDP_TYPE_OFFER, sdp_msg);

    // Set remote offer synchronously via promise.
    GstPromise* promise = gst_promise_new();
    g_signal_emit_by_name(webrtc, "set-remote-description", remote, promise);
    gst_promise_wait(promise);
    gst_promise_unref(promise);
    gst_webrtc_session_description_free(remote);

    // Create answer.
    promise = gst_promise_new();
    g_signal_emit_by_name(webrtc, "create-answer", nullptr, promise);
    gst_promise_wait(promise);
    const GstStructure* reply = gst_promise_get_reply(promise);
    GstWebRTCSessionDescription* answer = nullptr;
    gst_structure_get(reply, "answer", GST_TYPE_WEBRTC_SESSION_DESCRIPTION, &answer, nullptr);
    gst_promise_unref(promise);
    if (!answer) {
        std::cerr << "whep: create-answer failed\n";
        return false;
    }

    promise = gst_promise_new();
    g_signal_emit_by_name(webrtc, "set-local-description", answer, promise);
    gst_promise_wait(promise);
    gst_promise_unref(promise);

    // Wait briefly for ICE gathering to complete so we return a non-trivlial
    // answer. Full trickle ICE isn't implemented here.
    for (int i = 0; i < 20; i++) {
        GstWebRTCICEGatheringState state;
        g_object_get(webrtc, "ice-gathering-state", &state, nullptr);
        if (state == GST_WEBRTC_ICE_GATHERING_STATE_COMPLETE) break;
        g_usleep(100 * 1000);
    }

    gchar* answer_sdp_text = gst_sdp_message_as_text(answer->sdp);
    std::string answer_str(answer_sdp_text);
    g_free(answer_sdp_text);
    gst_webrtc_session_description_free(answer);

    // Stash the session so DELETE / sweeper can find it later.
    auto sess = std::make_unique<WhepSession>();
    sess->sid           = GenerateSid();
    sess->webrtc        = webrtc;
    sess->queue         = queue;
    sess->tee_src       = tee_src;       // ownership transferred
    sess->last_alive_ms = NowMs();
    *out_sid = sess->sid;
    *out_sdp = std::move(answer_str);
    {
        std::lock_guard<std::mutex> lk(sessions_mu_);
        sessions_.emplace(sess->sid, std::move(sess));
    }
    return true;
}

bool WhepServer::handleDelete(const std::string& sid) {
    std::unique_ptr<WhepSession> sess;
    {
        std::lock_guard<std::mutex> lk(sessions_mu_);
        auto it = sessions_.find(sid);
        if (it == sessions_.end()) return false;
        sess = std::move(it->second);
        sessions_.erase(it);
    }
    teardownSession(std::move(sess));
    return true;
}

void WhepServer::teardownSession(std::unique_ptr<WhepSession> sess) {
    if (!sess || !sess->webrtc) return;

    // Build a context that owns the bookkeeping needed for the actual
    // teardown. The pad-block probe takes ownership of `ctx` and frees
    // it when the teardown completes.
    auto* ctx = new TeardownCtx{
        .pipeline = pipeline_,
        .tee      = rtp_tee_,
        .tee_src  = sess->tee_src,
        .queue    = sess->queue,
        .webrtc   = sess->webrtc,
    };

    // Schedule the unlink-and-remove sequence to run when the tee_src
    // pad goes idle (no buffer in flight). This is the only race-free
    // way to remove an element from a running pipeline — direct
    // unref/remove from a random thread crashes during the next buffer
    // push.
    //
    // gst_pad_add_probe semantics for IDLE: if the pad is currently
    // idle the callback fires synchronously on *this* thread and the
    // function returns 0 (because we return PROBE_REMOVE). Otherwise
    // the callback fires later on the streaming thread once the pad
    // goes idle. Either way the callback owns `ctx` and frees it; we
    // must not touch `ctx` after the call returns. A return of 0 here
    // does NOT mean "failed to install" — it just means "ran inline."
    if (sess->tee_src) {
        gst_pad_add_probe(
            sess->tee_src,
            static_cast<GstPadProbeType>(GST_PAD_PROBE_TYPE_IDLE),
            TeardownPadIdleCb,
            ctx,
            nullptr);
        // Probe owns tee_src now (callback unrefs it). Drop our handle.
        sess->tee_src = nullptr;
        return;
    }
    // No tee_src — rare degenerate case; clean up directly.
    TeardownPadIdleCb(nullptr, nullptr, ctx);
}

void WhepServer::sweeperLoop() {
    using namespace std::chrono_literals;
    while (!stop_) {
        // Wake every 30s and walk active sessions. Any whose peer
        // connection has been in a terminal state (FAILED/CLOSED/
        // DISCONNECTED) for more than 30s — we age via last_alive_ms —
        // gets torn down. Catches browsers that crashed or networks
        // that dropped without sending DELETE.
        for (int i = 0; i < 30 && !stop_; ++i) std::this_thread::sleep_for(1s);
        if (stop_) break;

        std::vector<std::string> doomed;
        const int64_t now = NowMs();
        {
            std::lock_guard<std::mutex> lk(sessions_mu_);
            for (auto& kv : sessions_) {
                GstWebRTCPeerConnectionState state =
                    GST_WEBRTC_PEER_CONNECTION_STATE_NEW;
                g_object_get(kv.second->webrtc, "connection-state", &state, nullptr);
                const bool terminal =
                    state == GST_WEBRTC_PEER_CONNECTION_STATE_FAILED ||
                    state == GST_WEBRTC_PEER_CONNECTION_STATE_CLOSED ||
                    state == GST_WEBRTC_PEER_CONNECTION_STATE_DISCONNECTED;
                if (!terminal) {
                    kv.second->last_alive_ms = now;
                    continue;
                }
                if (now - kv.second->last_alive_ms > 30'000) {
                    doomed.push_back(kv.first);
                }
            }
        }

        for (const auto& sid : doomed) {
            std::unique_ptr<WhepSession> sess;
            {
                std::lock_guard<std::mutex> lk(sessions_mu_);
                auto it = sessions_.find(sid);
                if (it == sessions_.end()) continue;
                sess = std::move(it->second);
                sessions_.erase(it);
            }
            std::cerr << "whep[" << camera_id_ << "]: sweeping stale session " << sid << "\n";
            teardownSession(std::move(sess));
        }
    }
}

}  // namespace fnvr

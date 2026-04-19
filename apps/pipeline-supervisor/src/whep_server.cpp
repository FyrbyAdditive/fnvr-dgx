#include "whep_server.h"

#include <array>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <memory>
#include <mutex>
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

void WriteResponse(int fd, int code, const std::string& content_type, const std::string& body) {
    std::ostringstream os;
    os << "HTTP/1.1 " << code << " OK\r\n"
       << "Content-Type: " << content_type << "\r\n"
       << "Access-Control-Allow-Origin: *\r\n"
       << "Access-Control-Allow-Methods: POST, OPTIONS, DELETE\r\n"
       << "Access-Control-Allow-Headers: Content-Type\r\n"
       << "Content-Length: " << body.size() << "\r\n"
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

// (intentionally empty — per-viewer state stays in handleOffer stack frame)

}  // namespace

WhepServer::WhepServer(std::string camera_id, GstElement* pipeline, GstElement* rtp_tee)
    : camera_id_(std::move(camera_id)), pipeline_(pipeline), rtp_tee_(rtp_tee) {}

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
        if (req.method == "POST" && req.path.find("/whep") != std::string::npos) {
            std::string answer = handleOffer(req.body);
            if (answer.empty()) {
                WriteResponse(fd, 500, "text/plain", "negotiation failed");
            } else {
                WriteResponse(fd, 201, "application/sdp", answer);
            }
            close(fd);
            continue;
        }
        WriteResponse(fd, 404, "text/plain", "not found");
        close(fd);
    }
}

std::string WhepServer::handleOffer(const std::string& offer_sdp) {
    // Create a fresh webrtcbin per viewer, link a new pad off the shared
    // RTP tee into it, set the remote offer, create answer, wait for
    // ICE gathering, return the local SDP.
    GstElement* webrtc = gst_element_factory_make("webrtcbin", nullptr);
    if (!webrtc) return {};
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
        return {};
    }
    gst_object_unref(q_sink);

    GstCaps* caps = gst_caps_from_string(
        "application/x-rtp,media=video,encoding-name=H264,payload=96,"
        "clock-rate=90000,packetization-mode=(string)1");
    if (!gst_element_link_filtered(queue, webrtc, caps)) {
        std::cerr << "whep: queue→webrtcbin link failed\n";
        gst_caps_unref(caps);
        return {};
    }
    gst_caps_unref(caps);

    gst_element_sync_state_with_parent(queue);
    gst_element_sync_state_with_parent(webrtc);

    // Parse browser offer into a GstWebRTCSessionDescription.
    GstSDPMessage* sdp_msg = nullptr;
    if (gst_sdp_message_new(&sdp_msg) != GST_SDP_OK) return {};
    if (gst_sdp_message_parse_buffer((const guint8*)offer_sdp.data(), offer_sdp.size(), sdp_msg) != GST_SDP_OK) {
        gst_sdp_message_free(sdp_msg);
        return {};
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
        return {};
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
    std::string out(answer_sdp_text);
    g_free(answer_sdp_text);
    gst_webrtc_session_description_free(answer);

    return out;
}

}  // namespace fnvr

// Client half of the fnvr-hailo-broker protocol. The pipeline-supervisor
// fork+execs one OS process per camera and libhailort's multi_process
// service path is broken for our NMS-on-chip yolov11l workload on v4.23.0
// (hits HAILO_INTERNAL_FAILURE on first run_async — investigated deeply,
// cause appears to be in ConfiguredInferModelImpl wrapping an RPC-backed
// network group). Rather than fork libhailort, all Hailo access goes
// through a single broker process (apps/hailo-broker/) which owns the
// VDevice directly. This file is the thin protocol client.
//
// HailoInference keeps the same public shape (Instance + Infer) so
// hailo_probe.cpp doesn't need to change. Internally we open a unix
// socket to /var/run/fnvr/hailo.sock lazily on first Infer(), keep it
// persistent, and reconnect on I/O failure so broker restarts are
// transparent.

#include "hailo_inference.h"

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <cstring>
#include <iostream>
#include <stdexcept>

#include <arpa/inet.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

namespace fnvr {

// Wire protocol — must exactly match apps/hailo-broker/src/wire.h.
// Duplicated here (rather than shared-included) to keep the supervisor's
// include path from reaching into another app's source tree; if the two
// drift, `static_assert`s below trip on both sides.
namespace {
constexpr uint32_t kMagic        = 0xFA1C0001;
constexpr uint32_t kInputWidth   = 640;
constexpr uint32_t kInputHeight  = 640;
constexpr uint32_t kInputBytes   = kInputWidth * kInputHeight * 3;  // 1,228,800
constexpr uint32_t kMaxDetections = 1024;
constexpr const char* kSocketPath = "/var/run/fnvr/hailo.sock";

#pragma pack(push, 1)
struct WireDetection {
    uint8_t  class_id;
    float    score;
    float    x0;
    float    y0;
    float    x1;
    float    y1;
};
struct WireReplyHeader {
    uint32_t magic;
    uint32_t status;
    uint16_t n_detections;
};
#pragma pack(pop)
static_assert(sizeof(WireDetection)   == 21, "WireDetection must be 21B packed");
static_assert(sizeof(WireReplyHeader) == 10, "WireReplyHeader must be 10B packed");

static_assert(kInputWidth == HailoInference::kInputWidth,  "input width mismatch");
static_assert(kInputHeight == HailoInference::kInputHeight, "input height mismatch");

bool read_full(int fd, void* buf, size_t n) {
    auto* p = static_cast<uint8_t*>(buf);
    size_t got = 0;
    while (got < n) {
        ssize_t r = ::read(fd, p + got, n - got);
        if (r == 0) return false;
        if (r < 0) {
            if (errno == EINTR) continue;
            return false;
        }
        got += static_cast<size_t>(r);
    }
    return true;
}

bool write_full(int fd, const void* buf, size_t n) {
    const auto* p = static_cast<const uint8_t*>(buf);
    size_t sent = 0;
    while (sent < n) {
        ssize_t w = ::write(fd, p + sent, n - sent);
        if (w < 0) {
            if (errno == EINTR) continue;
            return false;
        }
        sent += static_cast<size_t>(w);
    }
    return true;
}

} // namespace

struct HailoInference::Impl {
    std::string hef_path;   // purely informational — client doesn't open a HEF
    int fd = -1;            // persistent socket to the broker

    bool connect_locked() {
        close_locked();
        fd = ::socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
        if (fd < 0) {
            std::cerr << "hailo-client: socket() failed: "
                      << std::strerror(errno) << "\n";
            return false;
        }
        sockaddr_un addr{};
        addr.sun_family = AF_UNIX;
        std::strncpy(addr.sun_path, kSocketPath, sizeof(addr.sun_path) - 1);
        if (::connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
            std::cerr << "hailo-client: connect(" << kSocketPath << "): "
                      << std::strerror(errno) << " — is fnvr-hailo-broker up?\n";
            ::close(fd);
            fd = -1;
            return false;
        }
        return true;
    }

    void close_locked() {
        if (fd >= 0) {
            ::close(fd);
            fd = -1;
        }
    }

    ~Impl() { close_locked(); }
};

HailoInference& HailoInference::Instance(const std::string& hef_path) {
    static HailoInference* instance = nullptr;
    static std::once_flag init_flag;
    static std::exception_ptr init_err;

    std::call_once(init_flag, [&]{
        try {
            instance = new HailoInference(hef_path);
        } catch (...) {
            init_err = std::current_exception();
        }
    });
    if (init_err) std::rethrow_exception(init_err);
    return *instance;
}

HailoInference::HailoInference(const std::string& hef_path)
    : impl_(std::make_unique<Impl>())
{
    impl_->hef_path = hef_path;
    // Eagerly try to connect so a missing broker is a startup-time error
    // (logged + propagated to hailo_probe_ctx_new, which then skips probe
    // attachment — the camera runs without detections but the pipeline
    // stays healthy).
    if (!impl_->connect_locked()) {
        throw std::runtime_error(
            "HailoInference(client): initial connect to fnvr-hailo-broker "
            "at " + std::string(kSocketPath) + " failed");
    }
    std::cerr << "hailo-client: connected to broker at " << kSocketPath << "\n";
}

HailoInference::~HailoInference() = default;

bool HailoInference::Infer(const uint8_t* rgb,
                           std::vector<HailoDetection>& out,
                           float score_threshold)
{
    out.clear();
    std::lock_guard<std::mutex> lock(mu_);

    // One retry: if a prior send/recv observed a broken socket, we'll have
    // dropped it; reconnect once and retry the request.
    for (int attempt = 0; attempt < 2; ++attempt) {
        if (impl_->fd < 0) {
            if (!impl_->connect_locked()) return false;
        }

        uint32_t magic = kMagic;
        if (!write_full(impl_->fd, &magic, sizeof(magic))) {
            impl_->close_locked();
            continue;
        }
        if (!write_full(impl_->fd, rgb, kInputBytes)) {
            impl_->close_locked();
            continue;
        }

        WireReplyHeader rh{};
        if (!read_full(impl_->fd, &rh, sizeof(rh))) {
            impl_->close_locked();
            continue;
        }
        if (rh.magic != kMagic) {
            std::cerr << "hailo-client: bad reply magic 0x" << std::hex
                      << rh.magic << std::dec << "\n";
            impl_->close_locked();
            return false;
        }
        if (rh.status != 0) {
            std::cerr << "hailo-client: broker reported status="
                      << rh.status << "\n";
            return false;
        }
        if (rh.n_detections == 0) return true;
        if (rh.n_detections > kMaxDetections) {
            std::cerr << "hailo-client: implausible n_detections="
                      << rh.n_detections << "\n";
            impl_->close_locked();
            return false;
        }

        std::vector<WireDetection> wire(rh.n_detections);
        if (!read_full(impl_->fd, wire.data(), wire.size() * sizeof(WireDetection))) {
            impl_->close_locked();
            continue;
        }

        out.reserve(wire.size());
        for (const auto& wd : wire) {
            if (wd.score < score_threshold) continue;
            HailoDetection d;
            d.class_id   = static_cast<int>(wd.class_id);
            d.confidence = wd.score;
            d.x_min      = wd.x0;
            d.y_min      = wd.y0;
            d.x_max      = wd.x1;
            d.y_max      = wd.y1;
            out.push_back(d);
        }
        return true;
    }

    return false;
}

} // namespace fnvr

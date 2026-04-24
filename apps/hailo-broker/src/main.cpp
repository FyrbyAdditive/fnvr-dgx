// fnvr-hailo-broker — tiny unix-socket broker for the Hailo-8 PCIe
// accelerator. Owns the VDevice exclusively (so /dev/hailo0 stays busy
// on exactly one process) and serves pipeline-supervisor worker
// processes over /var/run/fnvr/hailo.sock. Each worker sends a raw RGB
// 640x640 frame; the broker runs yolov11l on-chip and returns decoded
// NMS detections.
//
// Why we need this: libhailort v4.23.0's multi_process_service code path
// (the stock way to share one Hailo across processes) returns
// HAILO_INTERNAL_FAILURE on the first run_async when the HEF uses
// on-chip NMS. Rather than fork libhailort, we route all access through
// this broker, using the direct (known-working) VDevice path inside.
//
// Concurrency: HailoInference serialises with an internal mutex, so
// many connections can be served concurrently — libhailort's scheduler
// interleaves them and we get ~18 FPS shared across all cameras.

#include "hailo_inference.h"
#include "wire.h"

#include <atomic>
#include <cerrno>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <arpa/inet.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

using namespace fnvr;
using namespace fnvr::hailo_wire;

namespace {

std::atomic<bool> g_stop{false};

void handle_signal(int) { g_stop.store(true); }

// read exactly n bytes or return false on EOF/error.
bool read_full(int fd, void* buf, size_t n) {
    auto* p = static_cast<uint8_t*>(buf);
    size_t got = 0;
    while (got < n) {
        ssize_t r = ::read(fd, p + got, n - got);
        if (r == 0) return false;               // peer closed
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

void serve_connection(int fd, const std::string& hef_path) {
    std::vector<uint8_t> rgb(kInputBytes);
    std::vector<HailoDetection> dets;
    dets.reserve(256);

    int frame_count = 0;
    const int client_fd = fd;

    while (!g_stop.load()) {
        uint32_t magic;
        if (!read_full(fd, &magic, sizeof(magic))) break;
        if (magic != kMagic) {
            std::cerr << "broker: bad magic 0x" << std::hex << magic
                      << " on fd " << std::dec << client_fd
                      << " — dropping client\n";
            break;
        }
        if (!read_full(fd, rgb.data(), rgb.size())) break;

        ReplyHeader rh{};
        rh.magic = kMagic;
        rh.status = 0;
        rh.n_detections = 0;

        dets.clear();
        bool ok = false;
        try {
            ok = HailoInference::Instance(hef_path).Infer(rgb.data(), dets);
        } catch (const std::exception& e) {
            std::cerr << "broker: infer threw: " << e.what() << "\n";
            ok = false;
        }
        if (!ok) {
            rh.status = 1;  // generic failure; hailort status isn't surfaced
                            // by Infer() yet, good enough for now
        }

        uint32_t n = std::min<uint32_t>(dets.size(), kMaxDetections);
        rh.n_detections = static_cast<uint16_t>(n);

        if (!write_full(fd, &rh, sizeof(rh))) break;

        // Pack detections into the wire format.
        std::vector<Detection> wire_dets(n);
        for (uint32_t i = 0; i < n; ++i) {
            const auto& d = dets[i];
            wire_dets[i] = Detection{
                .class_id = static_cast<uint8_t>(d.class_id),
                .score    = d.confidence,
                .x0       = d.x_min,
                .y0       = d.y_min,
                .x1       = d.x_max,
                .y1       = d.y_max,
            };
        }
        if (n > 0) {
            if (!write_full(fd, wire_dets.data(), n * sizeof(Detection))) break;
        }
        frame_count++;
    }

    ::close(fd);
    std::cerr << "broker: connection closed after " << frame_count << " frame(s)\n";
}

} // namespace

int main(int argc, char** argv) {
    // Single arg: HEF path. Defaults to the pipeline's staged location,
    // which is the fnvr-data docker volume the install script populates.
    std::string hef_path = "/var/lib/fnvr/models/hailo/yolov11l.hef";
    if (argc >= 2) hef_path = argv[1];

    std::signal(SIGINT,  handle_signal);
    std::signal(SIGTERM, handle_signal);
    std::signal(SIGPIPE, SIG_IGN);

    std::cerr << "fnvr-hailo-broker starting. hef=" << hef_path << "\n";

    // Prime the inference singleton up front so a configure error is a
    // startup failure, not a first-client surprise.
    try {
        (void)HailoInference::Instance(hef_path);
    } catch (const std::exception& e) {
        std::cerr << "broker: HailoInference init failed: " << e.what() << "\n";
        return 1;
    }

    // Socket path lives on a shared volume visible to both the broker and
    // pipeline containers. Create the parent dir idempotently, clean up a
    // stale socket from a previous run (bind() fails otherwise).
    std::filesystem::path sp(kSocketPath);
    std::error_code ec;
    std::filesystem::create_directories(sp.parent_path(), ec);
    ::unlink(kSocketPath);

    int listen_fd = ::socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (listen_fd < 0) {
        std::cerr << "broker: socket() failed: " << std::strerror(errno) << "\n";
        return 1;
    }

    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    std::strncpy(addr.sun_path, kSocketPath, sizeof(addr.sun_path) - 1);

    if (::bind(listen_fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
        std::cerr << "broker: bind(" << kSocketPath << "): " << std::strerror(errno) << "\n";
        return 1;
    }
    ::chmod(kSocketPath, 0666);  // let non-root containers connect

    if (::listen(listen_fd, 32) < 0) {
        std::cerr << "broker: listen: " << std::strerror(errno) << "\n";
        return 1;
    }

    std::cerr << "broker: listening on " << kSocketPath << "\n";

    while (!g_stop.load()) {
        int fd = ::accept4(listen_fd, nullptr, nullptr, SOCK_CLOEXEC);
        if (fd < 0) {
            if (errno == EINTR) continue;
            std::cerr << "broker: accept: " << std::strerror(errno) << "\n";
            break;
        }
        std::cerr << "broker: client connected, fd=" << fd << "\n";
        // Detach a thread per connection. HailoInference::Infer is thread-safe
        // (guarded by an internal mutex) so concurrent connections interleave
        // on the Hailo's round-robin scheduler.
        std::thread(serve_connection, fd, hef_path).detach();
    }

    ::close(listen_fd);
    ::unlink(kSocketPath);
    std::cerr << "broker: shutting down\n";
    return 0;
}

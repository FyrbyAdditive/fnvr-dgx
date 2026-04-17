// pipeline-supervisor — M2.5 shape.
//
// DB-driven reconciler. Every N seconds, reads the cameras table from
// Postgres, diffs against a map of running per-camera threads, and starts
// or stops workers to match. Each worker independently restarts its
// GStreamer pipeline with exponential backoff on EOS/error.
//
// Jetson build wires the DeepStream nvinfer chain; non-Jetson falls back
// to pass-through record via software encoder.

#include <chrono>
#include <csignal>
#include <iostream>
#include <string>
#include <thread>

#include <glib.h>
#include <gst/gst.h>

#include "config.h"
#include "nats_publisher.h"
#include "pipeline.h"
#include "supervisor.h"

namespace {
volatile std::sig_atomic_t g_stop = 0;
void HandleSignal(int) { g_stop = 1; }
}  // namespace

int main(int argc, char** argv) {
    // Worker mode: one subprocess per camera. Isolates splitmuxsink / nvinfer
    // asserts so a single bad camera can't crash the whole supervisor.
    // Invoked as: pipeline-supervisor --worker <camera_id> <url> <record_mode>
    if (argc >= 5 && std::string(argv[1]) == "--worker") {
        gst_init(nullptr, nullptr);
        std::signal(SIGINT, HandleSignal);
        std::signal(SIGTERM, HandleSignal);

        auto cfg = fnvr::LoadFromEnv();
        fnvr::NatsPublisher nats(cfg.nats_url);

        fnvr::CameraConfig cam;
        cam.id = argv[2];
        cam.url = argv[3];
        cam.recording_mode = argv[4];

        fnvr::SingleCameraPipeline p(cam, cfg.recordings_dir, cfg.inference_config,
                                      cfg.use_deepstream, &nats);
        if (!p.Start()) {
            std::cerr << "worker[" << cam.id << "]: start failed\n";
            return 2;
        }
        // Run until parent signals us or the pipeline faults.
        while (!g_stop && !p.Faulted()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(500));
        }
        p.Stop();
        gst_deinit();
        return p.Faulted() ? 3 : 0;
    }

    // Parent (supervisor) mode.
    gst_init(&argc, &argv);
    std::signal(SIGINT, HandleSignal);
    std::signal(SIGTERM, HandleSignal);

    auto cfg = fnvr::LoadFromEnv();
    std::cerr << "pipeline-supervisor starting. db=" << cfg.database_url
              << " nats=" << cfg.nats_url
              << " recordings=" << cfg.recordings_dir
              << " deepstream=" << (cfg.use_deepstream ? "yes" : "no")
              << "\n";

    fnvr::NatsPublisher nats(cfg.nats_url);
    if (!nats.Connected()) {
        std::cerr << "pipeline-supervisor: continuing without NATS (degraded mode)\n";
    }

    fnvr::Supervisor sup(cfg, &nats);
    std::thread runner([&sup] { sup.Run(); });

    while (!g_stop) pause();

    std::cerr << "pipeline-supervisor: shutting down\n";
    sup.Stop();
    if (runner.joinable()) runner.join();
    gst_deinit();
    return 0;
}

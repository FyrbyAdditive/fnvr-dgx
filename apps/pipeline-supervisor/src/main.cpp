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

        // Announce "starting" before Start() so the UI can show progress
        // during the TRT engine build (first run after cache wipe: 60-90s).
        // Pipeline will publish "running" itself on reaching PLAYING.
        //
        // Subject: fnvr.state.camera.<id>. This is a JetStream-backed
        // last-value stream (declared by api-server) so a fresh api-server
        // subscriber immediately sees the current state for every camera,
        // instead of being stuck at "unknown" until a worker happens to
        // (re)start.
        const std::string subj = "fnvr.state.camera." + cam.id;
        {
            std::string payload = "{\"camera_id\":\"" + cam.id + "\",\"state\":\"starting\"}";
            nats.Publish(subj, payload);
        }
        if (!p.Start()) {
            std::string payload = "{\"camera_id\":\"" + cam.id + "\",\"state\":\"failed\"}";
            nats.Publish(subj, payload);
            std::cerr << "worker[" << cam.id << "]: start failed\n";
            return 2;
        }

        // Run a GMainLoop on the main thread. GStreamer bus watches
        // (added via gst_bus_add_watch) dispatch only when the main
        // context iterates. Without this the pipeline starves on state-
        // change messages and never emits buffers past nvinfer — which
        // is exactly what was making USB cams hang while standalone
        // gst-launch (which auto-iterates) worked fine.
        GMainLoop* loop = g_main_loop_new(nullptr, FALSE);
        guint watch_id = g_timeout_add(500, [](gpointer) -> gboolean {
            if (g_stop) {
                return FALSE;
            }
            return TRUE;
        }, nullptr);
        std::thread stop_watcher([&loop, &p] {
            while (!g_stop && !p.Faulted()) {
                std::this_thread::sleep_for(std::chrono::milliseconds(500));
            }
            g_main_loop_quit(loop);
        });
        g_main_loop_run(loop);
        g_source_remove(watch_id);
        if (stop_watcher.joinable()) stop_watcher.join();
        g_main_loop_unref(loop);

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

    // Subscribe to the restart signal published by api-server when the
    // operator picks a new YOLO variant / precision. On receipt, set the
    // stop flag — docker compose's restart=unless-stopped brings us back
    // up, and the entrypoint re-reads settings from the DB before the
    // supervisor starts.
    natsConnection* restart_conn = nullptr;
    natsSubscription* restart_sub = nullptr;
    if (nats.Connected()) {
        natsStatus st = natsConnection_ConnectTo(&restart_conn, cfg.nats_url.c_str());
        if (st == NATS_OK) {
            natsConnection_Subscribe(&restart_sub, restart_conn,
                "fnvr.system.pipeline.restart",
                [](natsConnection*, natsSubscription*, natsMsg* msg, void*) {
                    std::cerr << "pipeline-supervisor: received restart signal\n";
                    g_stop = 1;
                    natsMsg_Destroy(msg);
                }, nullptr);
        } else {
            std::cerr << "pipeline-supervisor: restart subscriber failed: "
                      << natsStatus_GetText(st) << "\n";
        }
    }

    // Announce ready to the pipeline-state stream so the UI banner clears.
    nats.Publish("fnvr.state.pipeline", "{\"state\":\"ready\"}");

    fnvr::Supervisor sup(cfg, &nats);
    std::thread runner([&sup] { sup.Run(); });

    while (!g_stop) pause();

    std::cerr << "pipeline-supervisor: shutting down\n";
    if (restart_sub) natsSubscription_Destroy(restart_sub);
    if (restart_conn) natsConnection_Destroy(restart_conn);
    sup.Stop();
    if (runner.joinable()) runner.join();
    gst_deinit();
    return 0;
}

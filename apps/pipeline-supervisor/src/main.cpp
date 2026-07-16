// pipeline-supervisor — batched-mux shape.
//
// DB-driven reconciler. Every N seconds, reads the cameras table from
// Postgres, plans worker GROUPS (cameras with identical graph shapes
// share a process with one batched nvstreammux — see grouping.h), and
// starts or stops group workers to match. Each worker independently
// restarts its child process with exponential backoff on faults;
// member-attributable faults quarantine just the broken camera.
//
// DeepStream builds wire the nvinfer chain; GPU-less dev builds fall
// back to record/push-only graphs.

#include <chrono>
#include <csignal>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include <signal.h>   // kill()
#include <unistd.h>   // getpid()

#include <glib.h>
#include <gst/gst.h>

#include "config.h"
#include "db_reconciler.h"
#include "grouping.h"
#include "nats_publisher.h"
#include "pipeline.h"
#include "supervisor.h"

namespace {
volatile std::sig_atomic_t g_stop = 0;
void HandleSignal(int) { g_stop = 1; }

std::vector<std::string> splitCsv(const std::string& s) {
    std::vector<std::string> out;
    std::stringstream ss(s);
    std::string item;
    while (std::getline(ss, item, ',')) {
        if (!item.empty()) out.push_back(item);
    }
    return out;
}
}  // namespace

// runWorkerGroup is the child-process body: build one GroupPipeline for
// the given member cameras, run it, publish per-camera state.
static int runWorkerGroup(const std::string& group_id,
                          const std::vector<std::string>& member_ids) {
    gst_init(nullptr, nullptr);
    std::signal(SIGINT, HandleSignal);
    std::signal(SIGTERM, HandleSignal);

    auto cfg = fnvr::LoadFromEnv();
    fnvr::NatsPublisher nats(cfg.nats_url);

    // Resolve member configs from the DB. The supervisor passed ids
    // only; url/rotation/detectors/mtx_proxy/mutes come from Postgres
    // so the child always runs the current config.
    auto all = fnvr::ReadEnabledCameras(cfg.database_url);
    std::vector<fnvr::CameraConfig> members;
    for (const auto& id : member_ids) {
        for (auto& c : all) {
            if (c.id == id) {
                fnvr::CameraConfig cam = c;
                cam.muted_classes =
                    fnvr::ReadMutedClassesForCamera(cfg.database_url, id);
                members.push_back(std::move(cam));
                break;
            }
        }
    }
    if (members.empty()) {
        std::cerr << "group[" << group_id
                  << "]: no enabled members resolve — exiting clean\n";
        return 0;
    }

    fnvr::SetWorkerStartupGraceSec(
        fnvr::ReadPipelineStartupGraceSec(cfg.database_url));

    fnvr::GroupPipeline p(group_id, members, cfg.recordings_dir,
                          cfg.inference_config, cfg.use_deepstream,
                          cfg.use_anpr, cfg.use_face_id, &nats);

    // Announce "starting" for every member before Start() so the UI can
    // show progress during the TRT engine build.
    for (const auto& m : members) {
        const std::string subj = "fnvr.state.camera." + m.id;
        nats.Publish(subj, "{\"camera_id\":\"" + m.id +
                               "\",\"state\":\"starting\"}",
                     /*flush=*/true);
    }
    if (!p.Start()) {
        for (const auto& m : members) {
            const std::string subj = "fnvr.state.camera." + m.id;
            nats.Publish(subj, "{\"camera_id\":\"" + m.id +
                                   "\",\"state\":\"failed\"}",
                         /*flush=*/true);
        }
        std::cerr << "group[" << group_id << "]: start failed\n";
        return 2;
    }

    // Healthy marker: written once the pipeline is PLAYING and (when an
    // inference branch exists) frames are actually flowing. The
    // supervisor's probation-graduation logic keys off this file —
    // NOT off child uptime, which lies when rtspsrc spends 60+ s
    // slow-failing against a dead host.
    std::thread healthy_marker([&p, &group_id] {
        while (!g_stop && !p.Faulted()) {
            if (p.Playing() && (!p.HasInference() || p.TotalFrames() > 0)) {
                const char* rd = std::getenv("FNVR_RUN_DIR");
                std::string dir = (rd && *rd) ? rd : "/tmp/fnvr-run";
                std::error_code ec;
                std::filesystem::create_directories(dir, ec);
                std::ofstream mk(dir + "/group-" + group_id + ".healthy",
                                 std::ios::trunc);
                mk << "ok\n";
                return;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(500));
        }
    });

    // GMainLoop on the main thread so bus watches dispatch.
    GMainLoop* loop = g_main_loop_new(nullptr, FALSE);
    guint watch_id = g_timeout_add(500, [](gpointer) -> gboolean {
        if (g_stop) {
            return FALSE;
        }
        return TRUE;
    }, nullptr);

    // Startup watchdog: if the pipeline doesn't reach PLAYING within
    // 60 s of Start(), fault so the supervisor respawns instead of
    // wedging on a silent rtspsrc SETUP hang.
    std::thread stop_watcher([&loop, &p, &group_id] {
        const auto startup_deadline =
            std::chrono::steady_clock::now() + std::chrono::seconds(60);
        while (!g_stop && !p.Faulted()) {
            if (!p.Playing() &&
                std::chrono::steady_clock::now() > startup_deadline) {
                std::cerr << "group[" << group_id
                          << "]: did not reach PLAYING within 60s — faulting\n";
                p.Fault();
                break;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(500));
        }
        g_main_loop_quit(loop);
    });

    // Self-heal: a member whose source chain bus-errored is marked dead
    // (siblings keep streaming — see BusHandler). One debounced restart
    // per incident revives the branch: after the FIRST death has aged
    // 120 s, exit rc=3 so the supervisor respawns the whole group once.
    // Multiple deaths within the window share the same single restart.
    std::thread self_heal([&p, &group_id] {
        // Push-leg degradation tracking: per member, consecutive 30 s
        // windows where the MediaMTX relay consumed < 60 % of the
        // frames the camera delivered. The degraded state is sticky
        // once entered (observed twice on the fleet: a stress window
        // leaves rtspclientsink pacing below input rate forever, the
        // leaky queue eats the difference, live tiles stutter at a
        // fraction of real fps) and invisible to the flow watchdog,
        // which only sees the inference leg. 4 consecutive bad
        // windows (2 min) → debounced restart.
        const size_t n = p.MemberCount();
        std::vector<std::uint64_t> last_in(n, 0), last_push(n, 0);
        std::vector<int> bad_windows(n, 0);
        auto last_window = std::chrono::steady_clock::now();
        while (!g_stop && !p.Faulted()) {
            if (p.DeadMembers() > 0) {
                auto age = std::chrono::duration_cast<std::chrono::seconds>(
                    std::chrono::steady_clock::now() - p.FirstDeathAt()).count();
                if (age >= 120) {
                    std::cerr << "group[" << group_id << "]: self-heal restart ("
                              << p.DeadMembers() << " dead member(s) for "
                              << age << "s)\n";
                    std::_Exit(3);
                }
            }
            const auto now = std::chrono::steady_clock::now();
            if (p.Playing() && now - last_window >= std::chrono::seconds(30)) {
                last_window = now;
                for (size_t i = 0; i < n; i++) {
                    const std::uint64_t in_now   = p.InputFramesForSource(i);
                    const std::uint64_t push_now = p.PushFramesForSource(i);
                    const std::uint64_t d_in   = in_now - last_in[i];
                    const std::uint64_t d_push = push_now - last_push[i];
                    last_in[i]   = in_now;
                    last_push[i] = push_now;
                    // Need real input flow to judge (≥2 fps for 30 s);
                    // a camera that is down/reconnecting is the bus
                    // handler's problem, not ours.
                    if (d_in < 60) { bad_windows[i] = 0; continue; }
                    if (d_push * 10 < d_in * 6) {
                        bad_windows[i]++;
                        std::cerr << "group[" << group_id << "]: push leg ["
                                  << p.Member(i).id << "] degraded — "
                                  << d_push << "/" << d_in
                                  << " frames relayed in 30s (window "
                                  << bad_windows[i] << "/4)\n";
                        if (bad_windows[i] >= 4) {
                            std::cerr << "group[" << group_id
                                      << "]: push-leg self-heal restart ["
                                      << p.Member(i).id << "]\n";
                            std::_Exit(3);
                        }
                    } else {
                        bad_windows[i] = 0;
                    }
                }
            }
            std::this_thread::sleep_for(std::chrono::seconds(5));
        }
    });

    // Data-flow watchdog (revived from the Orin build, where it was
    // disabled after recording moved to MediaMTX). The detection probe
    // bumps a per-source frame counter; if the SUM stalls for 20 s
    // while Playing(), the group is a zombie (bus silent, NvMedia/CUDA
    // wedge) — hard-exit so the supervisor respawns. A zombie now costs
    // every member in the group, so this matters more than ever.
    std::thread flow_watchdog([&p, &group_id] {
        if (!p.HasInference()) return;  // no counters to watch
        while (!g_stop && !p.Faulted() && !p.Playing()) {
            std::this_thread::sleep_for(std::chrono::seconds(1));
        }
        std::uint64_t last_seen = p.TotalFrames();
        auto last_progress = std::chrono::steady_clock::now();
        const auto stall_threshold = std::chrono::seconds(20);
        while (!g_stop && !p.Faulted()) {
            std::this_thread::sleep_for(std::chrono::seconds(5));
            std::uint64_t now_count = p.TotalFrames();
            if (now_count != last_seen) {
                last_seen = now_count;
                last_progress = std::chrono::steady_clock::now();
                continue;
            }
            if (std::chrono::steady_clock::now() - last_progress > stall_threshold) {
                std::cerr << "group[" << group_id
                          << "]: data-flow stalled 20s — hard exit rc=3\n";
                std::_Exit(3);
            }
        }
    });

    // Per-camera heartbeats: every 30 s publish `running` for members
    // whose frame counter advanced; a member stalled >60 s while the
    // group is PLAYING gets `failed` (its rtspsrc is retrying — the
    // rest of the group keeps working). Groups without inference (no
    // counters) heartbeat all members on liveness alone.
    std::thread heartbeat([&p, &nats, &group_id] {
        const size_t n = p.MemberCount();
        std::vector<std::uint64_t> last_frames(n, 0);
        std::vector<std::chrono::steady_clock::time_point> last_advance(
            n, std::chrono::steady_clock::now());
        std::this_thread::sleep_for(std::chrono::seconds(5));
        while (!g_stop && !p.Faulted()) {
            if (p.Playing()) {
                const auto now = std::chrono::steady_clock::now();
                for (size_t i = 0; i < n; i++) {
                    const std::string& id = p.Member(i).id;
                    bool advanced = true;
                    if (p.HasInference()) {
                        const auto f = p.FramesForSource(i);
                        advanced = f != last_frames[i];
                        if (advanced) {
                            last_frames[i] = f;
                            last_advance[i] = now;
                        }
                    }
                    const bool stalled =
                        p.HasInference() &&
                        now - last_advance[i] > std::chrono::seconds(60);
                    const char* state = stalled ? "failed" : "running";
                    if (advanced || stalled) {
                        nats.Publish("fnvr.state.camera." + id,
                                     "{\"camera_id\":\"" + id +
                                         "\",\"state\":\"" + state + "\"}");
                    }
                }
            }
            for (int i = 0; i < 60 && !g_stop && !p.Faulted(); i++) {
                std::this_thread::sleep_for(std::chrono::milliseconds(500));
            }
        }
    });

    // Pipeline metrics: one JSON blob per group every 15 s on
    // fnvr.metrics.pipeline.<group_id>. api-server re-exports the
    // fields as Prometheus gauges — no new scrape target, and the
    // per-member input/push/infer rates make silent degradation
    // (the class of bug the push watchdog now catches) visible on a
    // dashboard instead of only in a post-mortem.
    std::thread metrics([&p, &nats, &group_id] {
        const size_t n = p.MemberCount();
        std::vector<std::uint64_t> li(n, 0), lp(n, 0), lf(n, 0);
        auto last = std::chrono::steady_clock::now();
        while (!g_stop && !p.Faulted()) {
            for (int i = 0; i < 30 && !g_stop && !p.Faulted(); i++) {
                std::this_thread::sleep_for(std::chrono::milliseconds(500));
            }
            if (g_stop || p.Faulted() || !p.Playing()) continue;
            const auto now = std::chrono::steady_clock::now();
            const double dt =
                std::chrono::duration<double>(now - last).count();
            last = now;
            if (dt <= 0) continue;
            std::ostringstream j;
            j << "{\"group_id\":\"" << group_id << "\",\"dead_members\":"
              << p.DeadMembers() << ",\"members\":[";
            for (size_t i = 0; i < n; i++) {
                const auto in = p.InputFramesForSource(i);
                const auto pu = p.PushFramesForSource(i);
                const auto fr = p.FramesForSource(i);
                char buf[192];
                std::snprintf(buf, sizeof buf,
                              "%s{\"camera_id\":\"%s\",\"input_fps\":%.1f,"
                              "\"push_fps\":%.1f,\"infer_fps\":%.1f,"
                              "\"dead\":%s}",
                              i ? "," : "", p.Member(i).id.c_str(),
                              double(in - li[i]) / dt,
                              double(pu - lp[i]) / dt,
                              double(fr - lf[i]) / dt,
                              p.MemberDead(i) ? "true" : "false");
                j << buf;
                li[i] = in; lp[i] = pu; lf[i] = fr;
            }
            j << "]}";
            nats.Publish("fnvr.metrics.pipeline." + group_id, j.str());
        }
    });

    g_main_loop_run(loop);
    g_source_remove(watch_id);
    if (stop_watcher.joinable()) stop_watcher.join();
    if (metrics.joinable()) metrics.join();
    if (heartbeat.joinable()) heartbeat.join();
    if (flow_watchdog.joinable()) flow_watchdog.join();
    if (healthy_marker.joinable()) healthy_marker.join();
    if (self_heal.joinable()) self_heal.join();
    g_main_loop_unref(loop);

    p.Stop();
    gst_deinit();
    return p.Faulted() ? 3 : 0;
}

int main(int argc, char** argv) {
    // Lightweight publish mode — used by pipeline-entrypoint.sh to
    // announce calibrating / compiling_engine / ready states before the
    // supervisor is actually up.
    if (argc >= 4 && std::string(argv[1]) == "--publish") {
        auto cfg = fnvr::LoadFromEnv();
        fnvr::NatsPublisher nats(cfg.nats_url);
        if (!nats.Connected()) return 1;
        bool ok = nats.Publish(argv[2], argv[3], /*flush=*/true);
        return ok ? 0 : 2;
    }

    // Group-worker mode: one subprocess per camera GROUP.
    // Retro-analytics: --worker-replay <camera_id> <file> <base_epoch_ms>
    // Runs one recording through the detector stack at max speed and
    // exits. FNVR_USE_ANPR / FNVR_USE_FACEID / FNVR_INFER_CONFIG env
    // select the chains (the retro runner sets them).
    if (argc >= 5 && std::string(argv[1]) == "--worker-replay") {
        gst_init(&argc, &argv);
        const char* nurl = std::getenv("FNVR_NATS_URL");
        fnvr::NatsPublisher nats(nurl ? nurl : "nats://nats:4222");
        const char* cfg = std::getenv("FNVR_INFER_CONFIG");
        const bool use_anpr =
            [] { const char* e = std::getenv("FNVR_USE_ANPR");
                 return e && std::string(e) == "1"; }();
        const bool use_face =
            [] { const char* e = std::getenv("FNVR_USE_FACEID");
                 return e && std::string(e) == "1"; }();
        return fnvr::RunReplayFile(
            argv[2], argv[3], std::atoll(argv[4]), use_anpr, use_face,
            cfg ? cfg : "/var/lib/fnvr/models/rfdetr/rfdetr.effective.txt",
            &nats);
    }

    // Invoked as: pipeline-supervisor --worker-group <group_id> <cam1,cam2,...>
    if (argc >= 4 && std::string(argv[1]) == "--worker-group") {
        return runWorkerGroup(argv[2], splitCsv(argv[3]));
    }

    // Legacy single-camera worker form — kept as an alias for manual
    // debugging: pipeline-supervisor --worker <camera_id> <url> <mode>
    // (url/mode are re-read from the DB like any group member).
    if (argc >= 3 && std::string(argv[1]) == "--worker") {
        return runWorkerGroup(std::string("solo-") + argv[2], {argv[2]});
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
    // operator changes detector settings.
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
                    kill(getpid(), SIGTERM);
                    natsMsg_Destroy(msg);
                }, nullptr);
        } else {
            std::cerr << "pipeline-supervisor: restart subscriber failed: "
                      << natsStatus_GetText(st) << "\n";
        }
    }

    // Announce ready to the pipeline-state stream once the engine exists.
    auto engine_path = [&]() -> std::string {
        const char* cfg_env = std::getenv("FNVR_INFER_CONFIG");
        if (!cfg_env || !*cfg_env) return {};
        std::ifstream cf(cfg_env);
        std::string line;
        while (std::getline(cf, line)) {
            const char* KEY = "model-engine-file=";
            auto pos = line.find(KEY);
            if (pos == std::string::npos) continue;
            std::string val = line.substr(pos + std::strlen(KEY));
            while (!val.empty() && (val.back() == '\r' || val.back() == '\n' || val.back() == ' '))
                val.pop_back();
            return val;
        }
        return {};
    }();

    std::thread ready_watcher;
    if (engine_path.empty() || std::filesystem::exists(engine_path)) {
        nats.Publish("fnvr.state.pipeline", "{\"state\":\"ready\"}", /*flush=*/true);
    } else {
        std::cerr << "pipeline-supervisor: engine missing, watching "
                  << engine_path << " for ready signal\n";
        ready_watcher = std::thread([&nats, engine_path]() {
            auto deadline = std::chrono::steady_clock::now() + std::chrono::minutes(30);
            while (!g_stop &&
                   std::chrono::steady_clock::now() < deadline &&
                   !std::filesystem::exists(engine_path)) {
                std::this_thread::sleep_for(std::chrono::seconds(3));
            }
            if (!g_stop && std::filesystem::exists(engine_path)) {
                std::cerr << "pipeline-supervisor: engine appeared — publishing ready\n";
                nats.Publish("fnvr.state.pipeline", "{\"state\":\"ready\"}", /*flush=*/true);
            }
        });
    }

    fnvr::Supervisor sup(cfg, &nats);
    std::thread runner([&sup] { sup.Run(); });

    while (!g_stop) pause();

    std::cerr << "pipeline-supervisor: shutting down\n";
    if (restart_sub) natsSubscription_Destroy(restart_sub);
    if (restart_conn) natsConnection_Destroy(restart_conn);
    sup.Stop();
    if (runner.joinable()) runner.join();
    if (ready_watcher.joinable()) ready_watcher.join();
    gst_deinit();
    return 0;
}

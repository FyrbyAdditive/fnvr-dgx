#include "supervisor.h"

#include <algorithm>
#include <chrono>
#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <random>
#include <set>
#include <sstream>
#include <string>
#include <thread>

#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>

#include "db_reconciler.h"

namespace fnvr {

using namespace std::chrono_literals;

namespace {

std::string runDir() {
    const char* d = std::getenv("FNVR_RUN_DIR");
    return (d && *d) ? d : "/tmp/fnvr-run";
}

// Read (and consume) the fault marker file: one camera id per line,
// appended by the child each time a member's source chain died during
// that child's life. Used for strike counting — a member is only
// quarantined after repeated faults (transient RTSP burps must not
// yank cameras out of their groups).
std::vector<std::string> consumeFaultMarkers(const std::string& group_id) {
    std::vector<std::string> cams;
    const std::string path = runDir() + "/group-" + group_id + ".fault";
    std::ifstream f(path);
    if (!f) return cams;
    std::string cam;
    while (std::getline(f, cam)) {
        while (!cam.empty() && (cam.back() == '\r' || cam.back() == '\n' ||
                                cam.back() == ' '))
            cam.pop_back();
        if (!cam.empty()) cams.push_back(cam);
    }
    f.close();
    std::error_code ec;
    std::filesystem::remove(path, ec);
    return cams;
}

// Healthy marker: the child writes this once its pipeline is PLAYING
// with frames actually flowing (see main.cpp). Uptime alone is a lying
// health signal — rtspsrc can spend 60+ s slow-failing on a dead host.
std::string healthyMarkerPath(const std::string& group_id) {
    return runDir() + "/group-" + group_id + ".healthy";
}

bool healthyMarkerExists(const std::string& group_id) {
    std::error_code ec;
    return std::filesystem::exists(healthyMarkerPath(group_id), ec);
}

void clearHealthyMarker(const std::string& group_id) {
    std::error_code ec;
    std::filesystem::remove(healthyMarkerPath(group_id), ec);
}

}  // namespace

Supervisor::Supervisor(Config cfg, NatsPublisher* nats)
    : cfg_(std::move(cfg)), nats_(nats) {
    if (const char* g = std::getenv("FNVR_GROUP_MAX"); g && *g) {
        int v = std::atoi(g);
        if (v >= 1 && v <= 32) group_max_ = v;
    }
}

Supervisor::~Supervisor() { Stop(); }

void Supervisor::Run() {
    std::cerr << "supervisor: reconcile loop starting (interval "
              << cfg_.reconcile_interval_sec << "s, group_max "
              << group_max_ << ")\n";
    while (!stop_) {
        reconcileOnce();
        std::unique_lock<std::mutex> lk(stop_mu_);
        stop_cv_.wait_for(lk, std::chrono::seconds(cfg_.reconcile_interval_sec),
                          [this] { return stop_.load(); });
    }

    // Stop all workers.
    std::lock_guard<std::mutex> lk(workers_mu_);
    for (auto& kv : workers_) {
        kv.second->stop = true;
    }
    for (auto& kv : workers_) {
        if (kv.second->thread.joinable()) kv.second->thread.join();
    }
    workers_.clear();
}

void Supervisor::Stop() {
    {
        std::lock_guard<std::mutex> lk(stop_mu_);
        stop_ = true;
    }
    stop_cv_.notify_all();
}

bool Supervisor::noteFaultAndCheckStorm(const std::string& camera_id) {
    const auto now = std::chrono::steady_clock::now();
    std::lock_guard<std::mutex> lk(storm_mu_);
    recent_faults_.emplace_back(now, camera_id);
    while (!recent_faults_.empty() &&
           now - recent_faults_.front().first > std::chrono::minutes(2)) {
        recent_faults_.pop_front();
    }
    std::set<std::string> distinct;
    for (const auto& [t, cam] : recent_faults_) distinct.insert(cam);
    return distinct.size() >= 3;
}

void Supervisor::quarantineMember(const std::string& camera_id) {
    std::lock_guard<std::mutex> lk(quarantine_mu_);
    auto& q = quarantine_[camera_id];
    // Repeat offender → double the backoff (cap 10 min). First
    // offence starts at 60 s.
    if (q.in_probation || q.backoff_sec > 60) {
        q.backoff_sec = std::min(q.backoff_sec * 2, 600);
    }
    q.until = std::chrono::steady_clock::now() +
              std::chrono::seconds(q.backoff_sec);
    q.in_probation = false;
    std::cerr << "supervisor: quarantined [" << camera_id << "] for "
              << q.backoff_sec << "s (member fault)\n";
}

void Supervisor::graduateProbation(const std::string& camera_id) {
    std::lock_guard<std::mutex> lk(quarantine_mu_);
    if (quarantine_.erase(camera_id)) {
        std::cerr << "supervisor: [" << camera_id
                  << "] healthy on probation — rejoining its group\n";
    }
}

void Supervisor::reconcileOnce() {
    auto cameras = ReadEnabledCameras(cfg_.database_url);
    // "I don't know" (DB error → empty) must mean "change nothing".
    if (cameras.empty()) {
        // Distinguish "no cameras" from "query failed"? ReadEnabledCameras
        // logs failures; an installation with zero enabled cameras also
        // wants zero workers — proceed either way, matching old behaviour
        // of tearing down removed cameras only when the read SUCCEEDS is
        // not distinguishable here, so keep prior semantics.
    }

    // Resolve quarantine state: expired entries flip to probation.
    std::set<std::string> quarantined, probation;
    {
        std::lock_guard<std::mutex> lk(quarantine_mu_);
        const auto now = std::chrono::steady_clock::now();
        for (auto& [cam, q] : quarantine_) {
            if (now < q.until) {
                quarantined.insert(cam);
            } else {
                q.in_probation = true;
                probation.insert(cam);
            }
        }
    }

    auto plans = PlanGroups(cameras, quarantined, probation, group_max_);

    std::map<std::string, const GroupPlan*> plan_by_id;
    std::map<std::string, std::string> sig_by_id;
    for (const auto& p : plans) {
        plan_by_id[p.group_id] = &p;
        sig_by_id[p.group_id]  = Signature(p);
    }

    std::lock_guard<std::mutex> lk(workers_mu_);

    // Stop removed / changed / retired groups.
    for (auto it = workers_.begin(); it != workers_.end();) {
        auto pi = plan_by_id.find(it->first);
        const bool gone    = (pi == plan_by_id.end());
        const bool changed = !gone && sig_by_id[it->first] != it->second->signature;
        const bool retired = it->second->retired.load();
        if (gone || changed || retired) {
            std::cerr << "supervisor: stopping group [" << it->first << "] ("
                      << (gone ? "no longer planned"
                                : changed ? "membership/config changed"
                                          : "worker retired")
                      << ")\n";
            it->second->stop = true;
            if (it->second->thread.joinable()) it->second->thread.join();
            it = workers_.erase(it);
        } else {
            ++it;
        }
    }

    // Start newly-planned groups. Stagger behind the shared TRT engine:
    // the first group to start builds/deserialises it; siblings wait
    // for the file so they don't thrash the GPU building in parallel.
    std::string engine_path = readEnginePathFromInferConfig();
    std::vector<std::string> faceid_engines;
    if (const char* e = std::getenv("FNVR_USE_FACEID"); e && std::string(e) == "1") {
        // Must track the engine names the scrfd.txt template derives —
        // a stale name here silently stalls every group after the
        // first for the full 30-min deadline (2026-07-18 incident:
        // fleet ran 2 of 7 cameras because this list still named the
        // deleted RetinaFace/AdaFace engines). The aligned stack has
        // no in-graph embedder engine.
        faceid_engines.push_back(
            "/var/lib/fnvr/models/faceid/scrfd_10g_bnkps.onnx_b1_gpu0_fp16.engine");
    }

    bool first_start = true;
    for (const auto& plan : plans) {
        if (workers_.find(plan.group_id) != workers_.end()) continue;
        if (!first_start) {
            if (!engine_path.empty()) {
                auto deadline = std::chrono::steady_clock::now() + std::chrono::minutes(30);
                while (!std::filesystem::exists(engine_path) &&
                       std::chrono::steady_clock::now() < deadline &&
                       !stop_) {
                    std::this_thread::sleep_for(2s);
                }
                for (const auto& fe : faceid_engines) {
                    while (!std::filesystem::exists(fe) &&
                           std::chrono::steady_clock::now() < deadline &&
                           !stop_) {
                        std::this_thread::sleep_for(2s);
                    }
                }
                std::this_thread::sleep_for(3s);
            } else {
                std::this_thread::sleep_for(3s);
            }
        }
        first_start = false;

        std::string member_list;
        for (const auto& m : plan.members) {
            if (!member_list.empty()) member_list += ",";
            member_list += m.id;
        }
        std::cerr << "supervisor: starting group [" << plan.group_id
                  << "] members=" << member_list << "\n";

        auto w = std::make_unique<Worker>();
        w->plan      = plan;
        w->signature = sig_by_id[plan.group_id];
        Worker* raw = w.get();
        w->thread = std::thread([this, raw] { workerMain(raw); });
        workers_.emplace(plan.group_id, std::move(w));
    }
}

// readEnginePathFromInferConfig parses the rendered nvinfer config to
// extract the model-engine-file path. Returns empty if anything fails;
// callers treat empty as "no gate, fall back to timed stagger".
std::string Supervisor::readEnginePathFromInferConfig() const {
    const char* env = std::getenv("FNVR_INFER_CONFIG");
    if (!env || !*env) return {};
    std::filesystem::path cfg_path(env);
    std::error_code ec;
    if (!std::filesystem::exists(cfg_path, ec)) return {};
    std::ifstream f(cfg_path);
    if (!f) return {};
    std::string line;
    while (std::getline(f, line)) {
        constexpr const char* KEY = "model-engine-file=";
        auto pos = line.find(KEY);
        if (pos == std::string::npos) continue;
        std::string val = line.substr(pos + std::char_traits<char>::length(KEY));
        while (!val.empty() && (val.back() == '\r' || val.back() == '\n' || val.back() == ' '))
            val.pop_back();
        return val;
    }
    return {};
}

// Remove an engine file on disk if it looks corrupt (missing is fine —
// nvinfer will rebuild). Called before every group (re)spawn so that a
// truncated engine written by a SIGKILL'd prior worker doesn't send the
// next process into a rebuild loop.
void validateEngineFile(const std::string& path, std::size_t min_bytes) {
    std::error_code ec;
    if (!std::filesystem::exists(path, ec)) return;
    auto size = std::filesystem::file_size(path, ec);
    if (ec) return;
    if (size < min_bytes) {
        std::cerr << "supervisor: engine " << path << " is " << size
                  << " bytes (< " << min_bytes << ") — removing for rebuild\n";
        std::filesystem::remove(path, ec);
    }
}

void validateAllEngines(const std::string& pgie_engine_path) {
    if (!pgie_engine_path.empty()) {
        validateEngineFile(pgie_engine_path, 1 * 1024 * 1024);
    }
    if (const char* e = std::getenv("FNVR_USE_ANPR"); e && std::string(e) == "1") {
        validateEngineFile(
            "/var/lib/fnvr/models/anpr/platedet.onnx_b16_gpu0_fp16.engine",
            256 * 1024);
        validateEngineFile(
            "/var/lib/fnvr/models/anpr/plateocr.onnx_b16_gpu0_fp16.engine",
            256 * 1024);
    }
    if (const char* e = std::getenv("FNVR_USE_FACEID"); e && std::string(e) == "1") {
        validateEngineFile(
            "/var/lib/fnvr/models/faceid/face_detector.onnx_b1_gpu0_fp16.engine",
            256 * 1024);
        validateEngineFile(
            "/var/lib/fnvr/models/faceid/adaface.onnx_b16_gpu0_fp16.engine",
            1 * 1024 * 1024);
    }
}

void Supervisor::workerMain(Worker* w) {
    std::mt19937 rng{std::random_device{}()};
    std::uniform_int_distribution<int> jitter(0, 1000);
    int backoff_ms = 1000;

    // Flapping detection — rolling window of recent exit times. ≥3 in
    // 60 s → publish `failed` for the group's members (subject to
    // startup grace, overridden for chronic loops).
    std::deque<std::chrono::steady_clock::time_point> recent_exits;

    // Escalating self-heal delay: consecutive SHORT-LIVED rc=3 exits
    // (self-heal restarts that didn't stick) double the next child's
    // in-process heal debounce — 120s → 240s → 480s (cap 600s). The
    // group keeps streaming with the dead member excluded the whole
    // time; only the broken member waits longer between reconnect
    // attempts, so a grumpy camera stops dragging its group through a
    // restart every 4 minutes. A child that lives ≥10 min resets it.
    int consecutive_heal_exits = 0;

    // Per-member fault strikes (10-min sliding window) for quarantine
    // decisions — see the strike-counting block below.
    std::map<std::string, std::deque<std::chrono::steady_clock::time_point>>
        member_strikes;

    // Chronic crash-loop detector (see kChronicFlapThreshold): a
    // worker that has died young many times in a row must surface as
    // failed even inside startup grace.
    int consecutive_fast_exits = 0;
    constexpr int kChronicFlapThreshold = 10;

    const int grace_sec = ReadPipelineStartupGraceSec(cfg_.database_url);
    bool has_been_healthy = false;

    std::string member_csv;
    for (const auto& m : w->plan.members) {
        if (!member_csv.empty()) member_csv += ",";
        member_csv += m.id;
    }

    while (!stop_ && !w->stop) {
        validateAllEngines(readEnginePathFromInferConfig());
        // Stale healthy markers from a previous child must not count
        // for this spawn.
        clearHealthyMarker(w->plan.group_id);

        // fork+exec the same binary in --worker-group mode. Per-group
        // process isolation: a gst assertion in one group can't crash
        // the parent supervisor or sibling groups.
        pid_t pid = fork();
        if (pid < 0) {
            std::cerr << "group[" << w->plan.group_id << "]: fork failed: "
                      << strerror(errno) << "\n";
            std::this_thread::sleep_for(std::chrono::milliseconds(backoff_ms));
            backoff_ms = std::min(backoff_ms * 2, 30'000);
            continue;
        }
        if (pid == 0) {
            // First heal fast (WiFi/link blips recover in seconds);
            // escalate only when heals don't stick.
            static const int kHealLadder[] = {10, 60, 240, 600};
            const int heal_delay =
                kHealLadder[std::min(consecutive_heal_exits, 3)];
            setenv("FNVR_HEAL_DELAY_SEC", std::to_string(heal_delay).c_str(), 1);
            const char* argv0 = "/usr/local/bin/pipeline-supervisor";
            execl(argv0, argv0, "--worker-group",
                  w->plan.group_id.c_str(), member_csv.c_str(),
                  (char*)nullptr);
            std::cerr << "group[" << w->plan.group_id << "]: execl failed: "
                      << strerror(errno) << "\n";
            _exit(127);
        }

        w->child_pid = pid;
        std::cerr << "group[" << w->plan.group_id << "]: spawned pid " << pid << "\n";
        auto child_spawn_at = std::chrono::steady_clock::now();

        // Health bar for probation graduation: a probation child that
        // has run this long is considered recovered. grace_sec doubles
        // as the threshold (60 s fallback when grace is disabled).
        const int probation_health_sec = grace_sec > 0 ? grace_sec : 60;

        int status = 0;
        while (!stop_ && !w->stop) {
            pid_t got = waitpid(pid, &status, WNOHANG);
            if (got == pid) break;
            if (got < 0 && errno != EINTR) {
                std::cerr << "group[" << w->plan.group_id << "]: waitpid err: "
                          << strerror(errno) << "\n";
                break;
            }
            // A healthy probation run graduates WITHOUT waiting for the
            // child to exit (healthy children never exit): lift the
            // quarantine, retire this worker, and let the next replan
            // merge the camera back into its natural group. Health =
            // the child's healthy marker (PLAYING + frames flowing) AND
            // having sustained it for the health bar — uptime alone is
            // not a health signal.
            if (w->plan.probation) {
                auto up = std::chrono::duration_cast<std::chrono::seconds>(
                    std::chrono::steady_clock::now() - child_spawn_at).count();
                if (up >= probation_health_sec &&
                    healthyMarkerExists(w->plan.group_id)) {
                    graduateProbation(w->plan.members[0].id);
                    w->retired.store(true);
                    kill(pid, SIGTERM);
                    for (int i = 0; i < 20 && waitpid(pid, &status, WNOHANG) == 0; i++) {
                        std::this_thread::sleep_for(100ms);
                    }
                    if (waitpid(pid, &status, WNOHANG) == 0) {
                        kill(pid, SIGKILL);
                        waitpid(pid, &status, 0);
                    }
                    return;
                }
            }
            std::this_thread::sleep_for(500ms);
        }

        if (w->stop || stop_) {
            kill(pid, SIGTERM);
            for (int i = 0; i < 20 && waitpid(pid, &status, WNOHANG) == 0; i++) {
                std::this_thread::sleep_for(100ms);
            }
            if (waitpid(pid, &status, WNOHANG) == 0) {
                kill(pid, SIGKILL);
                waitpid(pid, &status, 0);
            }
            break;
        }

        // Child exited. Decode why.
        int rc = -1;
        if (WIFEXITED(status)) {
            rc = WEXITSTATUS(status);
            std::cerr << "group[" << w->plan.group_id << "]: exited rc=" << rc << "\n";
        } else if (WIFSIGNALED(status)) {
            std::cerr << "group[" << w->plan.group_id << "]: killed by signal "
                      << WTERMSIG(status) << "\n";
        }

        // Strike counting: each member fault recorded by the child adds
        // a strike; only a REPEAT offender (3 strikes in 10 min) gets
        // quarantined. A single transient RTSP burp costs one debounced
        // group restart (the child's self-heal), nothing more — the
        // old first-offence quarantine amplified every burp into a
        // quarantine→probation→rejoin triple restart.
        {
            const auto nowt = std::chrono::steady_clock::now();
            bool retired_for_quarantine = false;
            for (const auto& cam : consumeFaultMarkers(w->plan.group_id)) {
                if (noteFaultAndCheckStorm(cam)) {
                    // Fleet-wide fault storm: many distinct cameras
                    // faulting together means the CAUSE is shared
                    // (GPU contention, MediaMTX, network) — punishing
                    // individual cameras with strikes just cascades
                    // quarantines on top of the original incident
                    // (2026-07-17: an unthrottled retro-replay faulted
                    // the fleet and quarantined an innocent camera).
                    std::cerr << "group[" << w->plan.group_id
                              << "]: fault storm — strike suppressed for ["
                              << cam << "]\n";
                    continue;
                }
                auto& hist = member_strikes[cam];
                hist.push_back(nowt);
                while (!hist.empty() &&
                       nowt - hist.front() > std::chrono::minutes(10)) {
                    hist.pop_front();
                }
                std::cerr << "group[" << w->plan.group_id << "]: strike "
                          << hist.size() << "/3 for [" << cam << "]\n";
                if (hist.size() >= 3) {
                    quarantineMember(cam);
                    hist.clear();
                    retired_for_quarantine = true;
                }
            }
            if (retired_for_quarantine) {
                w->retired.store(true);
                std::cerr << "group[" << w->plan.group_id
                          << "]: retiring — repeat-offender member quarantined\n";
                return;
            }
        }

        auto child_uptime = std::chrono::duration_cast<std::chrono::seconds>(
            std::chrono::steady_clock::now() - child_spawn_at).count();
        const bool ran_healthy = healthyMarkerExists(w->plan.group_id) &&
                                 child_uptime >= (grace_sec > 0 ? grace_sec : 60);
        if (ran_healthy) {
            has_been_healthy = true;
            consecutive_fast_exits = 0;
            backoff_ms = 1000;
        } else {
            consecutive_fast_exits++;
        }

        // Escalating-heal accounting: rc=3 from a short-lived child =
        // the heal didn't stick; long-lived child = recovered.
        {
            const auto lived = std::chrono::steady_clock::now() - child_spawn_at;
            const int rc = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
            if (rc == 3 && lived < std::chrono::minutes(10)) {
                consecutive_heal_exits++;
            } else if (lived >= std::chrono::minutes(10)) {
                consecutive_heal_exits = 0;
            }
        }

        // Flap accounting + failed publishes.
        auto now = std::chrono::steady_clock::now();
        recent_exits.push_back(now);
        while (!recent_exits.empty() &&
               now - recent_exits.front() > std::chrono::seconds(60)) {
            recent_exits.pop_front();
        }
        if (recent_exits.size() >= 3 && nats_) {
            const bool chronic = consecutive_fast_exits >= kChronicFlapThreshold;
            if (grace_sec > 0 && !has_been_healthy && !chronic) {
                std::cerr << "group[" << w->plan.group_id << "]: flapping ("
                          << recent_exits.size() << " exits in 60s) — in "
                          << grace_sec << "s startup grace, not publishing failed\n";
            } else {
                std::cerr << "group[" << w->plan.group_id << "]: flapping ("
                          << recent_exits.size() << " exits in 60s"
                          << (chronic && !has_been_healthy
                                  ? ", chronic — grace overridden" : "")
                          << ") — publishing failed for members\n";
                for (const auto& m : w->plan.members) {
                    std::string subj = "fnvr.state.camera." + m.id;
                    std::string payload = "{\"camera_id\":\"" + m.id +
                        "\",\"state\":\"failed\"}";
                    nats_->Publish(subj, payload, /*flush=*/true);
                }
            }
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(backoff_ms + jitter(rng)));
        backoff_ms = std::min(backoff_ms * 2, 30'000);
    }
    std::cerr << "group[" << w->plan.group_id << "]: supervisor thread exiting\n";
}

}  // namespace fnvr

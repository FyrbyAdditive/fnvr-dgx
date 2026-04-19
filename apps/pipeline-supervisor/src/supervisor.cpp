#include "supervisor.h"

#include <algorithm>
#include <chrono>
#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <random>
#include <set>
#include <string>
#include <thread>

#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>

#include "db_reconciler.h"

namespace fnvr {

using namespace std::chrono_literals;

Supervisor::Supervisor(Config cfg, NatsPublisher* nats)
    : cfg_(std::move(cfg)), nats_(nats) {}

Supervisor::~Supervisor() { Stop(); }

void Supervisor::Run() {
    std::cerr << "supervisor: reconcile loop starting (interval "
              << cfg_.reconcile_interval_sec << "s)\n";
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

void Supervisor::reconcileOnce() {
    auto want = ReadEnabledCameras(cfg_.database_url);

    std::set<std::string> want_ids;
    for (auto& c : want) want_ids.insert(c.id);

    std::lock_guard<std::mutex> lk(workers_mu_);

    // Stop removed or disabled cameras.
    for (auto it = workers_.begin(); it != workers_.end();) {
        if (want_ids.find(it->first) == want_ids.end()) {
            std::cerr << "supervisor: stopping [" << it->first << "] (no longer enabled)\n";
            it->second->stop = true;
            if (it->second->thread.joinable()) it->second->thread.join();
            it = workers_.erase(it);
        } else {
            ++it;
        }
    }

    // Start newly-added cameras. Two reasons to stagger:
    //
    // 1. Fast path (engine cached): short delay avoids a millisecond
    //    race on the engine deserialize, which matters surprisingly
    //    little but costs nothing.
    //
    // 2. Slow path (first-use build): the first worker compiles the
    //    TRT engine — a multi-minute operation that eats most of the
    //    GPU. Spawning workers 2+ during this thrashes each other
    //    and can take 15+ minutes. Instead, workers 2+ wait until the
    //    engine file exists on disk before spawning, then all come up
    //    together in ~2s.
    //
    // The engine path comes from the FNVR_INFER_CONFIG env (a rendered
    // nvinfer config) — parse out model-engine-file= to get it. Empty
    // on failure disables the gate (falls back to old 3s stagger).
    std::string engine_path = readEnginePathFromInferConfig();

    bool first_start = true;
    for (const auto& cam : want) {
        if (workers_.find(cam.id) != workers_.end()) continue;
        if (!first_start) {
            if (!engine_path.empty()) {
                // Wait for the first worker to produce the engine file.
                // Cap at 30 min so a hung build doesn't block forever.
                auto deadline = std::chrono::steady_clock::now() + std::chrono::minutes(30);
                while (!std::filesystem::exists(engine_path) &&
                       std::chrono::steady_clock::now() < deadline &&
                       !stop_) {
                    std::this_thread::sleep_for(2s);
                }
                // Small additional delay so the first worker finishes
                // its own deserialize / nvinfer init before siblings load.
                std::this_thread::sleep_for(3s);
            } else {
                std::this_thread::sleep_for(3s);
            }
        }
        first_start = false;
        std::cerr << "supervisor: starting [" << cam.id << "] url=" << cam.url << "\n";

        auto w = std::make_unique<Worker>();
        w->cam = cam;
        Worker* raw = w.get();
        w->thread = std::thread([this, raw] { workerMain(raw); });
        workers_.emplace(cam.id, std::move(w));
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
        // Strip key + leading whitespace, trim trailing whitespace.
        std::string val = line.substr(pos + std::char_traits<char>::length(KEY));
        while (!val.empty() && (val.back() == '\r' || val.back() == '\n' || val.back() == ' '))
            val.pop_back();
        return val;
    }
    return {};
}

void Supervisor::startWorker(const CameraConfig& /*cam*/) { /* inlined above */ }
void Supervisor::stopWorker(const std::string& /*id*/)    { /* inlined above */ }

void Supervisor::workerMain(Worker* w) {
    std::mt19937 rng{std::random_device{}()};
    std::uniform_int_distribution<int> jitter(0, 1000);
    int backoff_ms = 1000;

    while (!stop_ && !w->stop) {
        // fork+exec the same binary in --worker mode. Per-camera process
        // isolation: a splitmuxsink / nvinfer / gst assertion in one camera
        // can't crash the parent supervisor or its sibling cameras.
        pid_t pid = fork();
        if (pid < 0) {
            std::cerr << "worker[" << w->cam.id << "]: fork failed: "
                      << strerror(errno) << "\n";
            std::this_thread::sleep_for(std::chrono::milliseconds(backoff_ms));
            backoff_ms = std::min(backoff_ms * 2, 30'000);
            continue;
        }
        if (pid == 0) {
            // Child: exec the worker form. On exec failure, _exit so we
            // don't run the supervisor destructor and double-close resources.
            const char* argv0 = "/usr/local/bin/pipeline-supervisor";
            const char* record_mode = w->cam.recording_mode.empty()
                ? "continuous"
                : w->cam.recording_mode.c_str();
            execl(argv0, argv0, "--worker",
                  w->cam.id.c_str(), w->cam.url.c_str(), record_mode,
                  (char*)nullptr);
            std::cerr << "worker[" << w->cam.id << "]: execl failed: "
                      << strerror(errno) << "\n";
            _exit(127);
        }

        // Parent: track the child PID so Stop() can kill it.
        w->child_pid = pid;
        std::cerr << "worker[" << w->cam.id << "]: spawned pid " << pid << "\n";

        // Remember the hour we started in; we force a restart at the top
        // of the next hour so the child writes into the new YYYY/MM/DD/HH
        // directory. Without this, a worker that's up for 24h writes a
        // 100+ GB rec.mp4 into its birth hour's folder.
        auto start_hour = std::chrono::time_point_cast<std::chrono::hours>(
            std::chrono::system_clock::now());
        bool hourly_rotate = false;

        // Wait for the child to exit, polling so we can react to w->stop.
        int status = 0;
        while (!stop_ && !w->stop) {
            pid_t got = waitpid(pid, &status, WNOHANG);
            if (got == pid) break;
            if (got < 0 && errno != EINTR) {
                std::cerr << "worker[" << w->cam.id << "]: waitpid err: "
                          << strerror(errno) << "\n";
                break;
            }
            auto now_hour = std::chrono::time_point_cast<std::chrono::hours>(
                std::chrono::system_clock::now());
            if (now_hour > start_hour) {
                std::cerr << "worker[" << w->cam.id
                          << "]: hourly rotation — restarting pid " << pid << "\n";
                hourly_rotate = true;
                kill(pid, SIGTERM);
                for (int i = 0; i < 50 && waitpid(pid, &status, WNOHANG) == 0; i++) {
                    std::this_thread::sleep_for(100ms);
                }
                if (waitpid(pid, &status, WNOHANG) == 0) {
                    kill(pid, SIGKILL);
                    waitpid(pid, &status, 0);
                }
                break;
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
        if (WIFEXITED(status)) {
            int rc = WEXITSTATUS(status);
            std::cerr << "worker[" << w->cam.id << "]: exited rc=" << rc << "\n";
            // rc == 0 means clean exit; still reconnect.
        } else if (WIFSIGNALED(status)) {
            int sig = WTERMSIG(status);
            std::cerr << "worker[" << w->cam.id << "]: killed by signal "
                      << sig << " — likely gst assertion\n";
        }

        if (hourly_rotate) {
            // Healthy restart; don't back off.
            backoff_ms = 1000;
            continue;
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(backoff_ms + jitter(rng)));
        backoff_ms = std::min(backoff_ms * 2, 30'000);
    }
    std::cerr << "worker[" << w->cam.id << "]: supervisor thread exiting\n";
}

}  // namespace fnvr

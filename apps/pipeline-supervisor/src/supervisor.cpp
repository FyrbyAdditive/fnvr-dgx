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
#include <string>
#include <thread>

#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>

#include "db_reconciler.h"

namespace fnvr {

using namespace std::chrono_literals;

// detectorsEqual compares two enabled_detectors lists ignoring order.
// The UI chip-picker writes items in click order (e.g. {"face","object"})
// while freshly-created rows default to {} or whatever psql ordering;
// we care about set equality, not sequence.
static bool detectorsEqual(const std::vector<std::string>& a,
                           const std::vector<std::string>& b) {
    if (a.size() != b.size()) return false;
    std::set<std::string> as(a.begin(), a.end());
    std::set<std::string> bs(b.begin(), b.end());
    return as == bs;
}

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

    // Index the desired configs so we can compare per-worker config
    // deltas in the stop loop below.
    std::map<std::string, const CameraConfig*> want_by_id;
    for (auto& c : want) want_by_id[c.id] = &c;

    // Stop removed, disabled, or reconfigured cameras. We only restart
    // workers on config changes that actually require rebuilding the
    // GStreamer graph — today just `rotation`, since changing it
    // toggles the transcode path. URL changes are left alone because
    // rtspsrc already reconnects on transport issues and some users
    // rewrite URLs temporarily for testing.
    for (auto it = workers_.begin(); it != workers_.end();) {
        auto wi = want_by_id.find(it->first);
        if (wi == want_by_id.end()) {
            std::cerr << "supervisor: stopping [" << it->first << "] (no longer enabled)\n";
            it->second->stop = true;
            if (it->second->thread.joinable()) it->second->thread.join();
            it = workers_.erase(it);
        } else if (wi->second->rotation != it->second->cam.rotation) {
            std::cerr << "supervisor: stopping [" << it->first
                      << "] (rotation changed " << it->second->cam.rotation
                      << " -> " << wi->second->rotation << ")\n";
            it->second->stop = true;
            if (it->second->thread.joinable()) it->second->thread.join();
            it = workers_.erase(it);
        } else if (wi->second->url != it->second->cam.url) {
            std::cerr << "supervisor: stopping [" << it->first
                      << "] (url changed)\n";
            it->second->stop = true;
            if (it->second->thread.joinable()) it->second->thread.join();
            it = workers_.erase(it);
        } else if (!detectorsEqual(wi->second->enabled_detectors,
                                    it->second->cam.enabled_detectors)) {
            // The per-camera detector whitelist shapes the graph (SGIE
            // chains present/absent, skip_inference tier). A change
            // means the worker must respawn with a rebuilt graph;
            // event-processor alone doesn't know about the pipeline
            // shape.
            std::cerr << "supervisor: stopping [" << it->first
                      << "] (enabled_detectors changed)\n";
            it->second->stop = true;
            if (it->second->thread.joinable()) it->second->thread.join();
            it = workers_.erase(it);
        } else if (wi->second->mtx_proxy != it->second->cam.mtx_proxy) {
            std::cerr << "supervisor: stopping [" << it->first
                      << "] (mtx_proxy changed "
                      << it->second->cam.mtx_proxy << " -> "
                      << wi->second->mtx_proxy << ")\n";
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

    // Optional face-id engine gates. When face_id is enabled, the SGIE
    // chain (face detector + arcface) also needs to build on worker #1
    // before siblings spawn — otherwise 3 workers each build these
    // concurrently, triple-spike GPU memory, and get OOM-killed. Both
    // engines are auto-written by nvinfer to derived paths next to
    // their ONNX.
    std::vector<std::string> faceid_engines;
    const char* face_env = std::getenv("FNVR_USE_FACEID");
    if (face_env && std::string(face_env) == "1") {
        faceid_engines.push_back(
            "/var/lib/fnvr/models/faceid/face_detector.onnx_b1_gpu0_fp16.engine");
        faceid_engines.push_back(
            "/var/lib/fnvr/models/faceid/arcface.onnx_b16_gpu0_fp16.engine");
    }

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
                for (const auto& fe : faceid_engines) {
                    while (!std::filesystem::exists(fe) &&
                           std::chrono::steady_clock::now() < deadline &&
                           !stop_) {
                        std::this_thread::sleep_for(2s);
                    }
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

// Remove an engine file on disk if it looks corrupt (missing is fine —
// nvinfer will rebuild). Called before every worker (re)exec so that a
// truncated engine written by a SIGKILL'd prior worker doesn't send the
// next process into a "deserialize fails → rebuild → SIGKILL mid-build"
// loop. Threshold is per-engine because engine sizes vary by ~1000x.
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

// Check all known engine files. Paths gated by their respective env
// vars so we don't complain about engines for features that are off.
void validateAllEngines(const std::string& pgie_engine_path) {
    // YOLO26 pgie engine: path parsed from the rendered nvinfer config.
    if (!pgie_engine_path.empty()) {
        validateEngineFile(pgie_engine_path, 1 * 1024 * 1024);
    }
    // ANPR chain: LPDNet + LPRNet live under /var/lib/fnvr/models/anpr/.
    if (const char* e = std::getenv("FNVR_USE_ANPR"); e && std::string(e) == "1") {
        validateEngineFile(
            "/var/lib/fnvr/models/anpr/LPDNet_usa.onnx_b16_gpu0_fp16.engine",
            256 * 1024);
        validateEngineFile(
            "/var/lib/fnvr/models/anpr/LPRNet_usa.onnx_b16_gpu0_fp16.engine",
            256 * 1024);
    }
    // Face chain: RetinaFace batch=1 + ArcFace batch=16.
    if (const char* e = std::getenv("FNVR_USE_FACEID"); e && std::string(e) == "1") {
        validateEngineFile(
            "/var/lib/fnvr/models/faceid/face_detector.onnx_b1_gpu0_fp16.engine",
            256 * 1024);
        validateEngineFile(
            "/var/lib/fnvr/models/faceid/arcface.onnx_b16_gpu0_fp16.engine",
            1 * 1024 * 1024);
    }
}

void Supervisor::workerMain(Worker* w) {
    std::mt19937 rng{std::random_device{}()};
    std::uniform_int_distribution<int> jitter(0, 1000);
    int backoff_ms = 1000;

    // Flapping detection — rolling window of recent (non-rotation)
    // worker-exit times. When a worker dies ≥3 times in a 60 s window,
    // we publish `failed` on the per-camera state subject so the UI
    // shows "pipeline failed" instead of forever-"starting". The worker
    // keeps retrying; the state clears on the next successful PLAYING
    // publish.
    std::deque<std::chrono::steady_clock::time_point> recent_exits;

    // Carries across loop iterations: when the previous worker exited
    // as part of an hourly segment rotation, tell the next child via
    // an extra argv so it suppresses its "starting" state publish. The
    // old `running` message stays live in the JetStream last-value
    // stream throughout the ~30 s respawn, so the UI doesn't flicker.
    bool rotation_respawn = false;

    // Per-camera deterministic stagger added onto the hour boundary so
    // three cameras don't rotate simultaneously. Up to 120 s after
    // HH:00. Belt-and-braces behind the silent-rotation publish: even
    // if that path regresses, a user sees one tile flash, not three.
    const auto stagger = std::chrono::seconds(
        std::hash<std::string>{}(w->cam.id) % 120);

    while (!stop_ && !w->stop) {
        // Defensive: if a prior worker died mid-engine-serialize (e.g.
        // SIGTERM from hourly rotation during a first-time TRT build),
        // the engine file on disk may be truncated. Deserialising it
        // fails deep inside nvinfer and falls back to a full rebuild,
        // which can itself be interrupted on the next rotation. Checking
        // here — before the new process runs nvinfer — breaks the loop.
        validateAllEngines(readEnginePathFromInferConfig());

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
            // When the previous worker died of hourly rotation, pass
            // --rotation so the child skips the "starting" publish.
            const char* argv0 = "/usr/local/bin/pipeline-supervisor";
            const char* record_mode = w->cam.recording_mode.empty()
                ? "continuous"
                : w->cam.recording_mode.c_str();
            if (rotation_respawn) {
                execl(argv0, argv0, "--worker",
                      w->cam.id.c_str(), w->cam.url.c_str(), record_mode,
                      "--rotation", (char*)nullptr);
            } else {
                execl(argv0, argv0, "--worker",
                      w->cam.id.c_str(), w->cam.url.c_str(), record_mode,
                      (char*)nullptr);
            }
            std::cerr << "worker[" << w->cam.id << "]: execl failed: "
                      << strerror(errno) << "\n";
            _exit(127);
        }
        // Rotation flag consumed by the exec above.
        rotation_respawn = false;

        // Parent: track the child PID so Stop() can kill it.
        w->child_pid = pid;
        std::cerr << "worker[" << w->cam.id << "]: spawned pid " << pid << "\n";

        // Remember the hour we started in; we force a restart at the top
        // of the next hour so the child writes into the new YYYY/MM/DD/HH
        // directory. Without this, a worker that's up for 24h writes a
        // 100+ GB rec.mp4 into its birth hour's folder.
        //
        // rotate_at = start_hour + 1h + stagger. The stagger (up to
        // 120 s, deterministic by cam.id) means three cameras don't all
        // rotate at the same wall-clock instant.
        auto start_hour = std::chrono::time_point_cast<std::chrono::hours>(
            std::chrono::system_clock::now());
        auto rotate_at = start_hour + std::chrono::hours(1) + stagger;
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
            if (std::chrono::system_clock::now() >= rotate_at) {
                std::cerr << "worker[" << w->cam.id
                          << "]: hourly rotation — rolled (silent; prior state retained) pid "
                          << pid << "\n";
                hourly_rotate = true;
                kill(pid, SIGTERM);
                // Generous grace (15s) — if nvinfer is serializing an
                // engine when we SIGTERM, a premature SIGKILL leaves a
                // truncated file on disk that the next worker can't
                // deserialize. Engines of our scale serialize in ≤10s.
                for (int i = 0; i < 150 && waitpid(pid, &status, WNOHANG) == 0; i++) {
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
            // Healthy restart; don't back off. Next exec gets
            // --rotation so the child skips the "starting" publish,
            // so the UI doesn't flash on the hour.
            backoff_ms = 1000;
            rotation_respawn = true;
            continue;
        }

        // Flapping check. Trim the window to the last 60 s, then count.
        auto now = std::chrono::steady_clock::now();
        recent_exits.push_back(now);
        while (!recent_exits.empty() &&
               now - recent_exits.front() > std::chrono::seconds(60)) {
            recent_exits.pop_front();
        }
        if (recent_exits.size() >= 3 && nats_) {
            std::cerr << "worker[" << w->cam.id << "]: flapping ("
                      << recent_exits.size() << " exits in 60s) — publishing failed\n";
            std::string subj = "fnvr.state.camera." + w->cam.id;
            std::string payload = "{\"camera_id\":\"" + w->cam.id +
                "\",\"state\":\"failed\"}";
            nats_->Publish(subj, payload, /*flush=*/true);
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(backoff_ms + jitter(rng)));
        backoff_ms = std::min(backoff_ms * 2, 30'000);
    }
    std::cerr << "worker[" << w->cam.id << "]: supervisor thread exiting\n";
}

}  // namespace fnvr

#include "supervisor.h"

#include <algorithm>
#include <chrono>
#include <iostream>
#include <random>
#include <set>
#include <thread>

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

    // Start newly-added cameras.
    for (const auto& cam : want) {
        if (workers_.find(cam.id) != workers_.end()) continue;
        std::cerr << "supervisor: starting [" << cam.id << "] url=" << cam.url << "\n";

        auto w = std::make_unique<Worker>();
        w->cam = cam;
        Worker* raw = w.get();
        w->thread = std::thread([this, raw] { workerMain(raw); });
        workers_.emplace(cam.id, std::move(w));
    }
}

void Supervisor::startWorker(const CameraConfig& /*cam*/) { /* inlined above */ }
void Supervisor::stopWorker(const std::string& /*id*/)    { /* inlined above */ }

void Supervisor::workerMain(Worker* w) {
    std::mt19937 rng{std::random_device{}()};
    std::uniform_int_distribution<int> jitter(0, 1000);
    int backoff_ms = 1000;

    while (!stop_ && !w->stop) {
        SingleCameraPipeline p(w->cam, cfg_.recordings_dir, cfg_.inference_config,
                               cfg_.use_deepstream, nats_);
        if (!p.Start()) {
            std::cerr << "worker[" << w->cam.id << "]: start failed, retry in "
                      << backoff_ms << "ms\n";
            std::this_thread::sleep_for(std::chrono::milliseconds(backoff_ms + jitter(rng)));
            backoff_ms = std::min(backoff_ms * 2, 30'000);
            continue;
        }
        backoff_ms = 1000;

        // Block until Faulted or external stop.
        while (!stop_ && !w->stop && !p.Faulted()) {
            std::this_thread::sleep_for(500ms);
        }
        p.Stop();

        if (w->stop || stop_) break;

        std::cerr << "worker[" << w->cam.id << "]: faulted, reconnecting in "
                  << backoff_ms << "ms\n";
        std::this_thread::sleep_for(std::chrono::milliseconds(backoff_ms + jitter(rng)));
        backoff_ms = std::min(backoff_ms * 2, 30'000);
    }
    std::cerr << "worker[" << w->cam.id << "]: exited\n";
}

}  // namespace fnvr

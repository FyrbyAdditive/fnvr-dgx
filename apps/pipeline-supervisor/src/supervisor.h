#pragma once

#include <atomic>
#include <condition_variable>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include <sys/types.h>

#include "config.h"
#include "nats_publisher.h"
#include "pipeline.h"

namespace fnvr {

// Supervisor owns one worker thread per camera. A periodic reconcile loop
// reads the DB, diffs against the running worker map, and starts/stops
// workers to match. Each worker independently restarts its pipeline with
// exponential backoff on EOS/error.
class Supervisor {
public:
    Supervisor(Config cfg, NatsPublisher* nats);
    ~Supervisor();

    // Run the reconcile loop. Blocks until Stop() is called.
    void Run();
    void Stop();

private:
    struct Worker {
        CameraConfig       cam;
        std::atomic<bool>  stop{false};
        std::thread        thread;
        pid_t              child_pid{0};  // set by workerMain after fork
    };

    void reconcileOnce();
    void startWorker(const CameraConfig& cam);
    void stopWorker(const std::string& id);
    void workerMain(Worker* w);

    Config         cfg_;
    NatsPublisher* nats_;

    std::mutex                                      workers_mu_;
    std::map<std::string, std::unique_ptr<Worker>>  workers_;  // id → worker

    std::atomic<bool>       stop_{false};
    std::mutex              stop_mu_;
    std::condition_variable stop_cv_;
};

}  // namespace fnvr

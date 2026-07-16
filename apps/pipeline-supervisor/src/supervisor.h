#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <thread>

#include <sys/types.h>

#include "config.h"
#include "grouping.h"
#include "nats_publisher.h"
#include "pipeline.h"

namespace fnvr {

// Supervisor owns one worker thread per camera GROUP (see grouping.h).
// A periodic reconcile loop reads the DB, plans groups, diffs plan
// signatures against the running worker map, and starts/stops group
// workers to match. Each worker independently respawns its child
// process with exponential backoff on faults.
//
// Member-fault quarantine: when a child attributes a bus error to one
// member's source chain (exit rc=4 + fault marker), that camera is
// quarantined with expanding backoff so the rest of its group stops
// being restarted along with it. Quarantine expiry re-admits the
// camera through a solo probation group; once it runs healthily it
// rejoins its natural group on the next replan.
class Supervisor {
public:
    Supervisor(Config cfg, NatsPublisher* nats);
    ~Supervisor();

    // Run the reconcile loop. Blocks until Stop() is called.
    void Run();
    void Stop();

private:
    struct Worker {
        GroupPlan          plan;
        std::string        signature;
        std::atomic<bool>  stop{false};
        std::thread        thread;
        pid_t              child_pid{0};  // set by workerMain after fork
        // Set true by workerMain when it retires itself (member fault
        // quarantined / probation graduated); reconcile reaps it.
        std::atomic<bool>  retired{false};
    };

    struct Quarantine {
        std::chrono::steady_clock::time_point until;
        int backoff_sec = 60;   // doubles per re-offence, capped
        bool in_probation = false;
    };

    void reconcileOnce();
    void workerMain(Worker* w);
    std::string readEnginePathFromInferConfig() const;

    // Quarantine helpers (lock quarantine_mu_).
    void quarantineMember(const std::string& camera_id);
    void graduateProbation(const std::string& camera_id);

    Config         cfg_;
    NatsPublisher* nats_;
    int            group_max_ = 8;

    std::mutex                                      workers_mu_;
    std::map<std::string, std::unique_ptr<Worker>>  workers_;  // group_id → worker

    std::mutex                          quarantine_mu_;
    std::map<std::string, Quarantine>   quarantine_;  // camera_id → entry

    std::atomic<bool>       stop_{false};
    std::mutex              stop_mu_;
    std::condition_variable stop_cv_;
};

}  // namespace fnvr

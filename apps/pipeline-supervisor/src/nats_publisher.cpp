#include "nats_publisher.h"

#include <iostream>

namespace fnvr {

NatsPublisher::NatsPublisher(const std::string& url) : url_(url) {
    connect();
}

NatsPublisher::~NatsPublisher() {
    teardown();
}

bool NatsPublisher::connect() {
    // Build options so reconnect is unlimited with a generous pending
    // buffer. Defaults give up after 60 attempts (~2 min), which is how
    // heartbeats previously went into the void for hours.
    natsOptions* opts = nullptr;
    if (natsOptions_Create(&opts) != NATS_OK || !opts) {
        std::cerr << "nats opts_create failed\n";
        return false;
    }
    natsOptions_SetURL(opts, url_.c_str());
    natsOptions_SetAllowReconnect(opts, true);
    natsOptions_SetMaxReconnect(opts, -1);           // unlimited
    natsOptions_SetReconnectWait(opts, 2000);        // 2 s between attempts
    natsOptions_SetReconnectBufSize(opts, 8 * 1024 * 1024); // 8 MB
    natsOptions_SetName(opts, "fnvr-pipeline");

    natsStatus s = natsConnection_Connect(&conn_, opts);
    natsOptions_Destroy(opts);
    if (s != NATS_OK) {
        std::cerr << "nats connect (" << url_ << "): " << natsStatus_GetText(s) << "\n";
        conn_ = nullptr;
        return false;
    }
    return true;
}

void NatsPublisher::teardown() {
    if (conn_) {
        natsConnection_Drain(conn_);
        natsConnection_Destroy(conn_);
        conn_ = nullptr;
    }
}

bool NatsPublisher::Publish(std::string_view subject, std::string_view payload, bool flush) {
    // Null-terminated copy for cnats, built before taking the lock so
    // the allocation doesn't extend the critical section.
    std::string subj(subject);
    // Whole-call lock: cheap for the hot flush=false path (publish is an
    // in-memory enqueue) and required for the rebuild path below, which
    // destroys conn_ out from under any concurrent publisher.
    std::lock_guard<std::mutex> lock(mu_);
    // Guard against the silent-drop state: nats-c marks the connection
    // CLOSED after reconnect retries are exhausted, but natsConnection_*
    // calls may still return NATS_OK from the client-side queue. Detect
    // CLOSED explicitly and rebuild the connection before publishing.
    if (!conn_ || natsConnection_Status(conn_) == NATS_CONN_STATUS_CLOSED) {
        auto now = std::chrono::steady_clock::now();
        if (now - last_closed_log_ > std::chrono::seconds(10)) {
            std::cerr << "nats: connection CLOSED, rebuilding\n";
            last_closed_log_ = now;
        }
        teardown();
        if (!connect()) {
            return false;
        }
    }
    natsStatus s = natsConnection_Publish(conn_, subj.c_str(), payload.data(),
                                          static_cast<int>(payload.size()));
    if (s != NATS_OK) {
        auto now = std::chrono::steady_clock::now();
        if (now - last_pub_fail_log_ > std::chrono::seconds(1)) {
            std::cerr << "nats: publish to " << subj << " failed: "
                      << natsStatus_GetText(s) << "\n";
            last_pub_fail_log_ = now;
        }
        return false;
    }
    if (flush) {
        // Short-lived callers (e.g. pipeline-supervisor --publish) would
        // Drain + Destroy before the async send reaches the broker
        // without this. 2s is plenty for a localhost bridge. Long-lived
        // callers (the probe) leave flush=false — otherwise every
        // detection pays one round-trip and the streaming thread stalls.
        natsConnection_FlushTimeout(conn_, 2000);
    }
    return true;
}

}  // namespace fnvr

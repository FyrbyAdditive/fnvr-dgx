#pragma once

#include <atomic>
#include <chrono>
#include <string>
#include <string_view>

#include <nats/nats.h>

namespace fnvr {

// NatsPublisher wraps a long-lived connection to the broker. Survives
// broker restarts by configuring the nats-c client with unlimited
// reconnects and a generous buffer. Publish() additionally guards
// against the pathological "connection CLOSED but object still alive"
// state that used to silently swallow heartbeats for hours — on
// CLOSED we tear down and rebuild the connection on the next call.
class NatsPublisher {
public:
    explicit NatsPublisher(const std::string& url);
    ~NatsPublisher();

    NatsPublisher(const NatsPublisher&) = delete;
    NatsPublisher& operator=(const NatsPublisher&) = delete;

    bool Connected() const { return conn_ != nullptr; }

    // Publish payload to the given subject. Returns true on success.
    // When `flush=true`, blocks until the message reaches the broker (2s
    // timeout) — needed for short-lived callers (`--publish` CLI) that
    // would otherwise Drain-and-Destroy before the async send flushes.
    // The hot probe path leaves flush=false so we don't pay the
    // round-trip per detection; shutdown Drain covers clean exit.
    bool Publish(std::string_view subject, std::string_view payload, bool flush = false);

private:
    // (Re)open conn_ with our reconnect-forever options. Returns true on
    // success. url_ is captured on construction so reconnect doesn't
    // need to be threaded through every caller.
    bool connect();
    void teardown();

    std::string url_;
    natsConnection* conn_ = nullptr;
    // Rate-limit noisy CLOSED-state log spam when the broker is actually
    // down for an extended window.
    std::chrono::steady_clock::time_point last_closed_log_{};
    // Same idea for publish-failure logs (every Publish call would log
    // otherwise; we want one line per second when something is wrong).
    std::chrono::steady_clock::time_point last_pub_fail_log_{};
};

}  // namespace fnvr

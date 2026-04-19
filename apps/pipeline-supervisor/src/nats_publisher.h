#pragma once

#include <string>
#include <string_view>

#include <nats/nats.h>

namespace fnvr {

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
    natsConnection* conn_ = nullptr;
};

}  // namespace fnvr

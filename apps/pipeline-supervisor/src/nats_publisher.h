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
    bool Publish(std::string_view subject, std::string_view payload);

private:
    natsConnection* conn_ = nullptr;
};

}  // namespace fnvr

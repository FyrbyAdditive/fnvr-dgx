#include "nats_publisher.h"

#include <iostream>

namespace fnvr {

NatsPublisher::NatsPublisher(const std::string& url) {
    natsStatus s = natsConnection_ConnectTo(&conn_, url.c_str());
    if (s != NATS_OK) {
        std::cerr << "nats connect (" << url << "): " << natsStatus_GetText(s) << "\n";
        conn_ = nullptr;
    }
}

NatsPublisher::~NatsPublisher() {
    if (conn_) {
        natsConnection_Drain(conn_);
        natsConnection_Destroy(conn_);
    }
}

bool NatsPublisher::Publish(std::string_view subject, std::string_view payload) {
    if (!conn_) return false;
    std::string subj(subject);
    natsStatus s = natsConnection_Publish(conn_, subj.c_str(), payload.data(),
                                          static_cast<int>(payload.size()));
    if (s != NATS_OK) return false;
    // Flush so short-lived callers (e.g. pipeline-supervisor --publish)
    // don't drain-and-destroy the connection before the buffered message
    // actually reaches the broker. 2s is plenty for a localhost bridge.
    natsConnection_FlushTimeout(conn_, 2000);
    return true;
}

}  // namespace fnvr

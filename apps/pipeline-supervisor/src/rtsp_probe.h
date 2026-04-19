#pragma once

#include <string>

namespace fnvr {

struct RtspProbeResult {
    std::string codec;  // "h264" | "h265" | "" (unknown)
    int width = 0;
    int height = 0;
};

// ProbeRtsp opens the given RTSP URL just long enough to read the video
// codec + dimensions from the SDP / first packets, then closes. On any
// failure the fields are left empty/zero and the caller should fall back
// to reasonable defaults.
RtspProbeResult ProbeRtsp(const std::string& url);

// Legacy helper — returns just the codec string. New code should use
// ProbeRtsp() above.
std::string ProbeRtspCodec(const std::string& url);

}  // namespace fnvr

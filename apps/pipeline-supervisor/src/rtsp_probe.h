#pragma once

#include <string>

namespace fnvr {

// ProbeRtspCodec opens the given RTSP URL just long enough to read the
// video codec from the SDP, then closes. Returns "h264" or "h265" on
// success; empty string on any failure (the caller should fall back to
// a default).
//
// The probe uses GStreamer's discoverer which speaks RTSP DESCRIBE and
// parses the SDP without starting a transport. Typical completion time
// is ~1 second against a healthy camera.
std::string ProbeRtspCodec(const std::string& url);

}  // namespace fnvr

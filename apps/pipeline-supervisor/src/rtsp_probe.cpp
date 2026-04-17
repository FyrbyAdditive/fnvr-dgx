#include "rtsp_probe.h"

#include <array>
#include <cstdio>
#include <iostream>
#include <memory>

#include <gst/gst.h>
#include <gst/pbutils/pbutils.h>

namespace fnvr {

// Fallback probe via ffprobe. gst_discoverer returns MISSING_PLUGINS on
// Jetson when the RTSP stream is H.265 (the H.265 SDP parser seems to
// need a plugin that isn't wired in the DS base image). ffprobe handles
// both codecs cleanly.
static std::string ProbeRtspCodecViaFfprobe(const std::string& url) {
    // Escape single-quotes in the URL (rare but possible with passwords).
    std::string esc;
    for (char c : url) { if (c == '\'') esc += "'\\''"; else esc += c; }
    std::string cmd = "ffprobe -rtsp_transport tcp -v error -select_streams v:0 "
                      "-show_entries stream=codec_name -of default=nw=1:nk=1 "
                      "'" + esc + "' 2>/dev/null";
    std::unique_ptr<FILE, decltype(&pclose)> pipe(popen(cmd.c_str(), "r"), pclose);
    if (!pipe) return {};
    std::array<char, 64> buf;
    std::string out;
    while (fgets(buf.data(), buf.size(), pipe.get())) out += buf.data();
    while (!out.empty() && (out.back() == '\n' || out.back() == '\r' || out.back() == ' ')) out.pop_back();
    if (out == "hevc" || out == "h265") return "h265";
    if (out == "h264") return "h264";
    return {};
}

std::string ProbeRtspCodec(const std::string& url) {
    // Try ffprobe first — handles auth + both H.264 and H.265 cleanly.
    auto via_ff = ProbeRtspCodecViaFfprobe(url);
    if (!via_ff.empty()) {
        std::cerr << "probe: ffprobe codec=" << via_ff << " url=" << url << "\n";
        return via_ff;
    }

    GError* err = nullptr;
    GstDiscoverer* d = gst_discoverer_new(5 * GST_SECOND, &err);
    if (!d) {
        if (err) { std::cerr << "probe: discoverer_new: " << err->message << "\n"; g_error_free(err); }
        return {};
    }
    GstDiscovererInfo* info = gst_discoverer_discover_uri(d, url.c_str(), &err);
    std::string codec;
    if (info) {
        GstDiscovererResult res = gst_discoverer_info_get_result(info);
        std::cerr << "probe: result=" << int(res) << " url=" << url << "\n";
        if (res == GST_DISCOVERER_OK) {
            GList* vstreams = gst_discoverer_info_get_video_streams(info);
            for (GList* it = vstreams; it; it = it->next) {
                GstDiscovererStreamInfo* si = static_cast<GstDiscovererStreamInfo*>(it->data);
                GstCaps* caps = gst_discoverer_stream_info_get_caps(si);
                if (caps) {
                    gchar* capstr = gst_caps_to_string(caps);
                    std::cerr << "probe: caps=" << (capstr ? capstr : "(null)") << "\n";
                    if (capstr) {
                        std::string s(capstr);
                        if (s.find("h265") != std::string::npos ||
                            s.find("hevc") != std::string::npos) codec = "h265";
                        else if (s.find("h264") != std::string::npos) codec = "h264";
                        g_free(capstr);
                    }
                    gst_caps_unref(caps);
                }
                if (!codec.empty()) break;
            }
            gst_discoverer_stream_info_list_free(vstreams);
        }
    }
    if (err) {
        std::cerr << "probe: discover_uri: " << err->message << "\n";
    }
    if (err) g_error_free(err);
    if (info) gst_discoverer_info_unref(info);
    g_object_unref(d);
    return codec;
}

}  // namespace fnvr

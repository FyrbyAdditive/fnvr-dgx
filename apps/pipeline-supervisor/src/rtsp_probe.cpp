#include "rtsp_probe.h"

#include <array>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <sstream>
#include <string>

#include <gst/gst.h>
#include <gst/pbutils/pbutils.h>

namespace fnvr {

// Shell out to ffprobe. gst_discoverer returns MISSING_PLUGINS on Jetson
// for H.265 RTSP; ffprobe handles both codecs plus gives us dimensions.
static RtspProbeResult ProbeRtspViaFfprobe(const std::string& url) {
    RtspProbeResult r;
    std::string esc;
    for (char c : url) { if (c == '\'') esc += "'\\''"; else esc += c; }
    std::string cmd = "ffprobe -rtsp_transport tcp -v error -select_streams v:0 "
                      "-show_entries stream=codec_name,width,height "
                      "-of default=nw=1 "
                      "'" + esc + "' 2>/dev/null";
    std::unique_ptr<FILE, decltype(&pclose)> pipe(popen(cmd.c_str(), "r"), pclose);
    if (!pipe) return r;
    std::array<char, 128> buf;
    std::string out;
    while (fgets(buf.data(), buf.size(), pipe.get())) out += buf.data();
    // Output format: key=value per line.
    std::istringstream iss(out);
    std::string line;
    while (std::getline(iss, line)) {
        auto eq = line.find('=');
        if (eq == std::string::npos) continue;
        std::string key = line.substr(0, eq);
        std::string val = line.substr(eq + 1);
        while (!val.empty() && (val.back() == '\r' || val.back() == '\n' || val.back() == ' '))
            val.pop_back();
        if (key == "codec_name") {
            if (val == "hevc" || val == "h265") r.codec = "h265";
            else if (val == "h264") r.codec = "h264";
        } else if (key == "width") {
            r.width = std::atoi(val.c_str());
        } else if (key == "height") {
            r.height = std::atoi(val.c_str());
        }
    }
    return r;
}

RtspProbeResult ProbeRtsp(const std::string& url) {
    auto r = ProbeRtspViaFfprobe(url);
    if (!r.codec.empty()) {
        std::cerr << "probe: ffprobe codec=" << r.codec
                  << " size=" << r.width << "x" << r.height
                  << " url=" << url << "\n";
        return r;
    }

    // Fallback via gst_discoverer (rarely needed now, kept for robustness).
    GError* err = nullptr;
    GstDiscoverer* d = gst_discoverer_new(5 * GST_SECOND, &err);
    if (!d) {
        if (err) { std::cerr << "probe: discoverer_new: " << err->message << "\n"; g_error_free(err); }
        return r;
    }
    GstDiscovererInfo* info = gst_discoverer_discover_uri(d, url.c_str(), &err);
    if (info) {
        GstDiscovererResult res = gst_discoverer_info_get_result(info);
        std::cerr << "probe: result=" << int(res) << " url=" << url << "\n";
        if (res == GST_DISCOVERER_OK) {
            GList* vstreams = gst_discoverer_info_get_video_streams(info);
            for (GList* it = vstreams; it; it = it->next) {
                GstDiscovererStreamInfo* si = static_cast<GstDiscovererStreamInfo*>(it->data);
                GstDiscovererVideoInfo* vi = GST_DISCOVERER_VIDEO_INFO(si);
                if (vi) {
                    r.width = gst_discoverer_video_info_get_width(vi);
                    r.height = gst_discoverer_video_info_get_height(vi);
                }
                GstCaps* caps = gst_discoverer_stream_info_get_caps(si);
                if (caps) {
                    gchar* capstr = gst_caps_to_string(caps);
                    if (capstr) {
                        std::string s(capstr);
                        if (s.find("h265") != std::string::npos ||
                            s.find("hevc") != std::string::npos) r.codec = "h265";
                        else if (s.find("h264") != std::string::npos) r.codec = "h264";
                        g_free(capstr);
                    }
                    gst_caps_unref(caps);
                }
                if (!r.codec.empty()) break;
            }
            gst_discoverer_stream_info_list_free(vstreams);
        }
    }
    if (err) {
        std::cerr << "probe: discover_uri: " << err->message << "\n";
        g_error_free(err);
    }
    if (info) gst_discoverer_info_unref(info);
    g_object_unref(d);
    return r;
}

std::string ProbeRtspCodec(const std::string& url) {
    return ProbeRtsp(url).codec;
}

}  // namespace fnvr

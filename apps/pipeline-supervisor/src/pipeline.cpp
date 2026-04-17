#include "pipeline.h"

#include <chrono>
#include <filesystem>
#include <iostream>
#include <random>
#include <sstream>
#include <utility>

// DeepStream metadata. Only include when building for Jetson — these headers
// come from the deepstream-l4t base image.
#if __has_include(<gstnvdsmeta.h>)
#  define FNVR_HAS_DEEPSTREAM 1
#  include <gstnvdsmeta.h>
#  include <nvdsmeta.h>
#endif

namespace fnvr {

namespace fs = std::filesystem;

SingleCameraPipeline::SingleCameraPipeline(CameraConfig cam, std::string recordings_dir,
                                           std::string infer_config, bool use_deepstream,
                                           NatsPublisher* nats)
    : cam_(std::move(cam)),
      recordings_dir_(std::move(recordings_dir)),
      infer_config_(std::move(infer_config)),
      use_deepstream_(use_deepstream),
      nats_(nats) {}

SingleCameraPipeline::~SingleCameraPipeline() { Stop(); }

#if FNVR_HAS_DEEPSTREAM
namespace {

// Generate a short random ID (no UUID lib dependency).
std::string short_id() {
    static thread_local std::mt19937_64 rng{std::random_device{}()};
    std::ostringstream os;
    os << std::hex << rng();
    return os.str();
}

struct ProbeCtx {
    std::string    camera_id;
    NatsPublisher* nats;
};

// JSON-escape minimal — only the fields we emit. Labels are small ASCII, IDs
// are hex. Good enough for M2; swap for a real encoder when we move to binary
// protobuf on the bus.
std::string json_escape(std::string_view s) {
    std::string out; out.reserve(s.size());
    for (char c : s) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            default:   out += c;
        }
    }
    return out;
}

// Called for every batched frame leaving the nvinfer element. We iterate the
// per-frame object metadata, map pixel bboxes to 0..1, and publish to NATS.
GstPadProbeReturn InferSrcProbe(GstPad*, GstPadProbeInfo* info, gpointer user) {
    auto* ctx = static_cast<ProbeCtx*>(user);
    GstBuffer* buf = gst_pad_probe_info_get_buffer(info);
    if (!buf) return GST_PAD_PROBE_OK;

    NvDsBatchMeta* batch = gst_buffer_get_nvds_batch_meta(buf);
    if (!batch) return GST_PAD_PROBE_OK;

    gint64 ts_ns = g_get_real_time() * 1000;  // µs → ns

    for (NvDsMetaList* fl = batch->frame_meta_list; fl; fl = fl->next) {
        auto* frame = static_cast<NvDsFrameMeta*>(fl->data);
        if (!frame) continue;
        const int W = frame->source_frame_width  ? frame->source_frame_width  : 1920;
        const int H = frame->source_frame_height ? frame->source_frame_height : 1080;

        for (NvDsMetaList* ol = frame->obj_meta_list; ol; ol = ol->next) {
            auto* obj = static_cast<NvDsObjectMeta*>(ol->data);
            if (!obj) continue;

            float x = obj->rect_params.left   / float(W);
            float y = obj->rect_params.top    / float(H);
            float w = obj->rect_params.width  / float(W);
            float h = obj->rect_params.height / float(H);

            const char* label = obj->obj_label[0] ? obj->obj_label : "object";

            std::ostringstream js;
            js << "{"
               << "\"id\":\""         << short_id() << "\","
               << "\"camera_id\":\""  << json_escape(ctx->camera_id) << "\","
               << "\"ts\":\""         << [ts_ns]{
                        std::time_t t = ts_ns / 1'000'000'000;
                        std::tm tm{}; gmtime_r(&t, &tm);
                        char b[32]; std::strftime(b, sizeof b, "%Y-%m-%dT%H:%M:%SZ", &tm);
                        return std::string(b);
                  }()                                         << "\","
               << "\"class_name\":\"" << json_escape(label)   << "\","
               << "\"confidence\":"   << obj->confidence      << ","
               << "\"bbox\":{\"x\":"  << x << ",\"y\":" << y
               <<          ",\"w\":"  << w << ",\"h\":" << h << "},"
               << "\"track_id\":\""   << obj->object_id       << "\""
               << "}";
            std::string payload = js.str();
            std::string subj = std::string("fnvr.events.detection.") + ctx->camera_id;
            if (ctx->nats) ctx->nats->Publish(subj, payload);
        }
    }
    return GST_PAD_PROBE_OK;
}

}  // namespace
#endif  // FNVR_HAS_DEEPSTREAM

GstElement* SingleCameraPipeline::BuildPipeline() {
    auto now_tm = [] {
        auto tt = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
        std::tm tm{};
        gmtime_r(&tt, &tm);
        return tm;
    }();
    char datebuf[64];
    std::strftime(datebuf, sizeof(datebuf), "%Y/%m/%d/%H", &now_tm);
    fs::path dir = fs::path(recordings_dir_) / datebuf / cam_.id;
    std::error_code ec;
    fs::create_directories(dir, ec);

    // Source selection: URL scheme picks the element. v4l2:// → v4l2src,
    // everything else → rtspsrc (good default for RTSP, and rtspsrc also
    // tolerates SRT/RTMP when paired with protocols=). Additional schemes
    // (rtmpsrc, srtsrc) land with the upstream source-factory rework in M3.
    const std::string url = cam_.url;
    const bool is_v4l2 = url.rfind("v4l2://", 0) == 0;
    const std::string v4l2_dev = is_v4l2 ? url.substr(7) : "";

    // Live-thumbnail sidecar. A tee branch downsamples to 1 fps and writes
    // a single JPEG file that gets rewritten each second. The
    // /cameras/<id>/snapshot.jpg endpoint prefers this over segment
    // extraction for near-real-time preview.
    const std::string live_jpg_done = "/var/lib/fnvr/live/" + cam_.id + ".jpg";
    fs::create_directories("/var/lib/fnvr/live", ec);

    std::ostringstream p;

    // Shared source → H.264 elementary stream with a `rawtee.` named tee
    // the live-JPEG branch taps. Common structure for both DeepStream and
    // fallback paths.
    if (is_v4l2) {
        // USB / local webcam emits raw frames; encode to H.264 first.
        // idrinterval=30 + insert-sps-pps=1 ensures a keyframe with SPS/PPS
        // every second; splitmuxsink asserts if the first buffer isn't
        // on a GOP boundary. h264parse config-interval=1 also repeats the
        // parameter sets so downstream decoders are always happy on join.
        if (use_deepstream_) {
            p << "v4l2src device=" << v4l2_dev << " ! videoconvert ! "
                 "video/x-raw,format=I420 ! nvvideoconvert ! "
                 "video/x-raw(memory:NVMM),format=NV12 ! "
                 "nvv4l2h264enc insert-sps-pps=1 idrinterval=30 "
                 "iframeinterval=30 ! "
                 "h264parse config-interval=1 ! ";
        } else {
            p << "v4l2src device=" << v4l2_dev << " ! videoconvert ! "
                 "x264enc tune=zerolatency speed-preset=veryfast bitrate=4000 "
                 "key-int-max=30 ! h264parse config-interval=1 ! ";
        }
    } else {
        p << "rtspsrc location=" << url << " latency=200 protocols=tcp name=src ! "
             "rtph264depay ! h264parse config-interval=1 ! ";
    }

    // Main tee: recording branch + live-thumbnail branch.
    // v4l2 encoders sometimes emit a P-frame before their first I-frame on
    // startup. splitmuxsink hits a fatal g_assert(gop != NULL) if the first
    // buffer isn't on a GOP boundary. Force a keyframe here: h264parse
    // tolerates it and downstream splitmuxsink only sees valid GOPs.
    if (is_v4l2) {
        p << "identity sync=false drop-buffer-flags=delta-unit ! ";
    }
    p << "tee name=t ";

    // --- Recording branch ---
    p << "t. ! queue max-size-buffers=200 leaky=downstream ! ";
    if (use_deepstream_) {
        // DeepStream detection needs decoded frames; re-decode from the
        // elementary stream so it works from both source types. Memory
        // stays NVMM from nvv4l2decoder onward.
        p << "nvv4l2decoder ! "
             "mux.sink_0 nvstreammux name=mux batch-size=1 width=1920 height=1080 "
             "  live-source=1 batched-push-timeout=40000 ! "
             "nvinfer name=pgie config-file-path=" << infer_config_ << " ! "
             "nvvideoconvert ! "
             "nvv4l2h265enc bitrate=6000000 insert-sps-pps=1 iframeinterval=30 ! "
             "h265parse config-interval=-1 ! "
             // Drop P-frames until the first keyframe. splitmuxsink's
             // check_completed_gop g_asserts if the first buffer isn't
             // a keyframe, which reliably happens for NVENC H.265 on USB
             // sources.
             "identity sync=false drop-buffer-flags=delta-unit ! "
             "splitmuxsink "
             "  location=" << dir.string() << "/seg-%05d.mp4 "
             "  max-size-time=60000000000 muxer=mp4mux "
             "  send-keyframe-requests=true ";
    } else {
        p << "splitmuxsink "
             "  location=" << dir.string() << "/seg-%05d.mp4 "
             "  max-size-time=60000000000 muxer=mp4mux "
             "  send-keyframe-requests=true ";
    }

    // --- Live-thumbnail branch ---
    // Decode → downsample to 1 fps → JPEG → ring of 4 indexed files. The
    // snapshot endpoint reads the newest *fully-written* one. We use NVDEC
    // (nvv4l2decoder) rather than avdec_h264 because (a) it's already in
    // the image as part of DeepStream and (b) avdec_h264 in the gstreamer
    // libav plugin requires libx265 which isn't reliably resolvable on
    // this image. nvvideoconvert pulls the frame back into system memory
    // for the software jpegenc.
    p << "t. ! queue max-size-buffers=10 leaky=downstream ! "
         "h264parse ! nvv4l2decoder ! nvvideoconvert ! "
         "video/x-raw,format=I420 ! videoscale ! "
         "video/x-raw,width=480 ! videorate ! video/x-raw,framerate=1/1 ! "
         "jpegenc quality=75 ! "
         "multifilesink location=/var/lib/fnvr/live/" << cam_.id << ".%d.jpg "
         "  async=false sync=false post-messages=false max-files=4 index=0";

    std::string desc = p.str();
    std::cerr << "pipeline[" << cam_.id << "]: " << desc << "\n";

    GError* err = nullptr;
    GstElement* pipeline = gst_parse_launch(desc.c_str(), &err);
    if (!pipeline) {
        std::cerr << "gst_parse_launch: " << (err ? err->message : "unknown") << "\n";
        if (err) g_error_free(err);
        return nullptr;
    }

#if FNVR_HAS_DEEPSTREAM
    if (use_deepstream_ && nats_) {
        GstElement* pgie = gst_bin_get_by_name(GST_BIN(pipeline), "pgie");
        if (pgie) {
            GstPad* src = gst_element_get_static_pad(pgie, "src");
            if (src) {
                // Leaked on purpose: lifetime matches the pipeline, cleaned up
                // when the process exits. Fine for M2, tighten when we have
                // multi-pipeline lifecycle.
                auto* ctx = new ProbeCtx{cam_.id, nats_};
                gst_pad_add_probe(src, GST_PAD_PROBE_TYPE_BUFFER, &InferSrcProbe, ctx, nullptr);
                gst_object_unref(src);
            }
            gst_object_unref(pgie);
        }
    }
#endif

    return pipeline;
}

gboolean SingleCameraPipeline::BusHandler(GstBus*, GstMessage* msg, gpointer user_data) {
    auto* self = static_cast<SingleCameraPipeline*>(user_data);
    switch (GST_MESSAGE_TYPE(msg)) {
        case GST_MESSAGE_EOS:
            std::cerr << "pipeline[" << self->cam_.id << "]: EOS\n";
            self->faulted_ = true;
            break;
        case GST_MESSAGE_ERROR: {
            GError* err = nullptr;
            gchar* dbg = nullptr;
            gst_message_parse_error(msg, &err, &dbg);
            std::cerr << "pipeline[" << self->cam_.id << "] error: "
                      << (err ? err->message : "?") << "\n";
            if (err) g_error_free(err);
            g_free(dbg);
            self->faulted_ = true;
            if (self->pipeline_) {
                gst_element_set_state(self->pipeline_, GST_STATE_NULL);
            }
            break;
        }
        case GST_MESSAGE_STATE_CHANGED: {
            if (GST_MESSAGE_SRC(msg) == GST_OBJECT(self->pipeline_)) {
                GstState oldS, newS;
                gst_message_parse_state_changed(msg, &oldS, &newS, nullptr);
                if (newS == GST_STATE_PLAYING && self->nats_) {
                    std::string payload = "{\"camera_id\":\"" + self->cam_.id + "\",\"state\":\"running\"}";
                    self->nats_->Publish("fnvr.events.system.camera", payload);
                }
            }
            break;
        }
        default:
            break;
    }
    return TRUE;
}

bool SingleCameraPipeline::Start() {
    pipeline_ = BuildPipeline();
    if (!pipeline_) return false;
    GstBus* bus = gst_element_get_bus(pipeline_);
    bus_watch_id_ = gst_bus_add_watch(bus, &SingleCameraPipeline::BusHandler, this);
    gst_object_unref(bus);

    GstStateChangeReturn ret = gst_element_set_state(pipeline_, GST_STATE_PLAYING);
    if (ret == GST_STATE_CHANGE_FAILURE) {
        std::cerr << "pipeline[" << cam_.id << "]: failed to set PLAYING\n";
        Stop();
        return false;
    }
    return true;
}

void SingleCameraPipeline::Stop() {
    if (pipeline_) {
        gst_element_set_state(pipeline_, GST_STATE_NULL);
        gst_object_unref(pipeline_);
        pipeline_ = nullptr;
    }
    if (bus_watch_id_) {
        g_source_remove(bus_watch_id_);
        bus_watch_id_ = 0;
    }
}

}  // namespace fnvr

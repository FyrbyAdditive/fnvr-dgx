#include "pipeline.h"

#include <atomic>
#include <chrono>
#include <filesystem>
#include <iostream>
#include <random>
#include <sstream>
#include <utility>

#include "rtsp_probe.h"
#include "whep_server.h"

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
                                           bool use_anpr,
                                           NatsPublisher* nats)
    : cam_(std::move(cam)),
      recordings_dir_(std::move(recordings_dir)),
      infer_config_(std::move(infer_config)),
      use_deepstream_(use_deepstream),
      use_anpr_(use_anpr),
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
    std::string           camera_id;
    NatsPublisher*        nats;
    // Snapshot of the effective mute set, resolved at worker startup.
    // The probe short-circuits on empty so unmuted cameras pay zero.
    std::set<std::string> muted_classes;
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

// LPDNet is attached as gie-unique-id=2 in lpdnet.txt. Any obj_meta
// with this component id is a plate crop, not a primary-detector
// object. Pgie (YOLO26) = 1; LPRNet (classifier) only updates
// classifier_meta on the plate's obj_meta — it doesn't add new objs.
constexpr unsigned LPDNET_GIE_ID = 2;

// extractPlateText pulls the plate string from the obj_meta's
// classifier_meta_list, as populated by the LPRNet CTC parser
// (NvDsInferParseCustomNVPlate in libnvds_infercustomparser_tao.so).
// Returns empty string if no classifier meta is attached (low-
// confidence OCR skip / chain not run).
std::string extractPlateText(NvDsObjectMeta* obj) {
    for (NvDsMetaList* cl = obj->classifier_meta_list; cl; cl = cl->next) {
        auto* cmeta = static_cast<NvDsClassifierMeta*>(cl->data);
        if (!cmeta) continue;
        for (NvDsMetaList* ll = cmeta->label_info_list; ll; ll = ll->next) {
            auto* label = static_cast<NvDsLabelInfo*>(ll->data);
            if (label && label->result_label[0]) {
                return std::string(label->result_label);
            }
        }
    }
    return {};
}

// parentVehicleClass reads the upstream vehicle's label (car, truck,
// bus, motorcycle) off a plate's parent obj_meta. Useful context in
// the published detection so the UI / rules engine can show "car
// AB12CDE" without a follow-up lookup.
std::string parentVehicleClass(NvDsObjectMeta* obj) {
    if (obj->parent && obj->parent->obj_label[0]) {
        return std::string(obj->parent->obj_label);
    }
    return {};
}

// Called for every batched frame leaving the last nvinfer (LPRNet
// when ANPR is enabled, tracker otherwise). Emits two payload
// shapes — kind="object" for pgie detections, kind="anpr" for
// plates with decoded text.
GstPadProbeReturn InferSrcProbe(GstPad*, GstPadProbeInfo* info, gpointer user) {
    auto* ctx = static_cast<ProbeCtx*>(user);
    GstBuffer* buf = gst_pad_probe_info_get_buffer(info);
    if (!buf) return GST_PAD_PROBE_OK;

    NvDsBatchMeta* batch = gst_buffer_get_nvds_batch_meta(buf);
    if (!batch) return GST_PAD_PROBE_OK;

    gint64 ts_ns = g_get_real_time() * 1000;  // µs → ns
    auto iso = [ts_ns]{
        std::time_t t = ts_ns / 1'000'000'000;
        std::tm tm{}; gmtime_r(&t, &tm);
        char b[32]; std::strftime(b, sizeof b, "%Y-%m-%dT%H:%M:%SZ", &tm);
        return std::string(b);
    }();

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

            const bool is_plate = (obj->unique_component_id == LPDNET_GIE_ID);
            const char* label = is_plate
                ? "plate"
                : (obj->obj_label[0] ? obj->obj_label : "object");

            // Class-mute gate at source. Drops before NATS publish so
            // muted classes don't reach Live bboxes, SSE, or event-
            // processor. The Go rules engine runs an identical gate as
            // defence-in-depth; both staying in sync is enforced by the
            // resolution formula living in both languages.
            if (!ctx->muted_classes.empty() &&
                ctx->muted_classes.count(label) > 0) {
                continue;
            }

            // ANPR branch: only publish when we have a decoded plate
            // string — a plate crop with no OCR output is noise.
            std::string plate, parent;
            if (is_plate) {
                plate = extractPlateText(obj);
                if (plate.empty()) continue;
                parent = parentVehicleClass(obj);
            }
            const char* kind = is_plate ? "anpr" : "object";
            // Plate inherits its vehicle's track_id so the rules
            // engine can correlate plate ↔ car without extra state.
            const uint64_t track_id = (is_plate && obj->parent)
                ? obj->parent->object_id
                : obj->object_id;

            std::ostringstream js;
            js << "{"
               << "\"id\":\""         << short_id() << "\","
               << "\"camera_id\":\""  << json_escape(ctx->camera_id) << "\","
               << "\"ts\":\""         << iso                  << "\","
               << "\"class_name\":\"" << json_escape(label)   << "\","
               << "\"kind\":\""       << kind                 << "\","
               << "\"confidence\":"   << obj->confidence      << ","
               << "\"bbox\":{\"x\":"  << x << ",\"y\":" << y
               <<          ",\"w\":"  << w << ",\"h\":" << h << "},"
               << "\"track_id\":\""   << track_id             << "\"";
            if (is_plate) {
                js << ",\"attributes\":{"
                   << "\"plate\":\""         << json_escape(plate)  << "\"";
                if (!parent.empty()) {
                    js << ",\"parent_class\":\"" << json_escape(parent) << "\"";
                }
                js << "}";
            }
            js << "}";
            std::string payload = js.str();
            std::string subj = std::string("fnvr.events.detection.") + ctx->camera_id;
            if (ctx->nats) ctx->nats->Publish(subj, payload);
        }
    }
    return GST_PAD_PROBE_OK;
}

}  // namespace
#endif  // FNVR_HAS_DEEPSTREAM

namespace {

// KeyframeGate drops non-keyframe buffers until the first keyframe arrives,
// at which point it removes itself from the pad. This is the reliable way
// to satisfy splitmuxsink's check_completed_gop g_assert, which fires if
// the very first buffer at its input isn't on a GOP boundary. Identity
// element's drop-buffer-flags didn't cut it for NVENC H.265 on v4l2 sources.
struct KeyframeGate {
    std::atomic<bool> open{false};
};

GstPadProbeReturn KeyframeGateProbe(GstPad*, GstPadProbeInfo* info, gpointer user) {
    auto* gate = static_cast<KeyframeGate*>(user);
    if (gate->open.load()) return GST_PAD_PROBE_OK;
    GstBuffer* buf = gst_pad_probe_info_get_buffer(info);
    if (!buf) return GST_PAD_PROBE_OK;
    // No DELTA_UNIT flag → this is a keyframe (sync point).
    if (!GST_BUFFER_FLAG_IS_SET(buf, GST_BUFFER_FLAG_DELTA_UNIT)) {
        gate->open.store(true);
        std::cerr << "keyframe gate: opened\n";
        return GST_PAD_PROBE_OK;
    }
    return GST_PAD_PROBE_DROP;
}

void AttachKeyframeGate(GstElement* pipeline, const char* element_name) {
    GstElement* el = gst_bin_get_by_name(GST_BIN(pipeline), element_name);
    if (!el) return;
    GstPad* src = gst_element_get_static_pad(el, "src");
    if (src) {
        auto* gate = new KeyframeGate();  // leaked intentionally — pipeline-scoped
        gst_pad_add_probe(src, GST_PAD_PROBE_TYPE_BUFFER, &KeyframeGateProbe, gate, nullptr);
        gst_object_unref(src);
    }
    gst_object_unref(el);
}

}  // namespace

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
        // Direct v4l2 pipelines (v4l2src → nvv4l2 → tee) SIGSEGV after
        // NVENC init on Jetson in our container. Users should instead run
        // USB cams through MediaMTX (rtsp://mediamtx:8554/fnvr-usb0 — see
        // deploy/docker/docker-compose.yml). We still recognise v4l2://
        // here to fail-fast with a clear message rather than hang.
        std::cerr << "pipeline[" << cam_.id
                  << "]: v4l2:// URLs aren't supported — point the camera at "
                     "rtsp://mediamtx:8554/usb0 instead (usb-bridge service).\n";
        return nullptr;
    } else {
        // RTSP source: probe codec + dimensions. Reolink cams in particular
        // name their paths "h264Preview_…" but deliver HEVC on newer
        // firmware, and panorama cams (e.g. Duo 2) come in at 4608x1728.
        // We keep the source's aspect ratio by deriving target dims from
        // the probed size, capped to 1080 lines.
        auto probe = ProbeRtsp(url);
        if (probe.codec.empty()) probe.codec = "h264";
        std::cerr << "pipeline[" << cam_.id << "]: probed codec=" << probe.codec
                  << " size=" << probe.width << "x" << probe.height << "\n";

        if (probe.codec == "h265") {
            // Compute aspect-preserving target. If we know source size,
            // fit to max(1080) height; otherwise fall back to 1920x1080.
            int tw = 1920, th = 1080;
            if (probe.width > 0 && probe.height > 0) {
                th = std::min(1080, probe.height);
                // width scaled, rounded to even (H.264 4:2:0 needs even).
                tw = static_cast<int>(
                    static_cast<double>(th) * probe.width / probe.height + 0.5);
                if (tw & 1) tw += 1;
            }
            // Clamp width to something sane (avoid ultra-wide 4K → 3520x1080
            // for 21:9 panoramas is ok, but cap at 2880 to keep encoder
            // within NVENC session budget).
            if (tw > 2880) {
                th = static_cast<int>(
                    static_cast<double>(2880) * th / tw + 0.5);
                if (th & 1) tw = (tw / 2880) * th; else tw = 2880;
                tw = 2880;
            }
            std::cerr << "pipeline[" << cam_.id
                      << "]: recording target=" << tw << "x" << th << "\n";

            p << "rtspsrc location=" << url << " latency=200 protocols=tcp name=src ! "
                 "rtph265depay ! h265parse config-interval=1 ! "
                 "video/x-h265,stream-format=byte-stream,alignment=au ! "
                 // Re-mux H.265 → H.264 via NVDEC+NVENC so the rest of
                 // the pipeline only has to handle one codec path. Target
                 // dims preserve source aspect ratio.
                 "nvv4l2decoder ! "
                 "nvvideoconvert ! "
                 "video/x-raw(memory:NVMM),format=NV12,width=" << tw
                 << ",height=" << th << " ! "
                 "nvv4l2h264enc insert-sps-pps=1 idrinterval=30 iframeinterval=30 ! "
                 "h264parse config-interval=1 ! ";
            rec_width_ = tw;
            rec_height_ = th;
        } else {
            // Source is already H.264 — pass through the parsed elementary
            // stream; downstream infers dims from the caps. Record at
            // source resolution.
            p << "rtspsrc location=" << url << " latency=200 protocols=tcp name=src ! "
                 "rtph264depay ! h264parse config-interval=1 ! ";
            if (probe.width > 0 && probe.height > 0) {
                rec_width_ = probe.width;
                rec_height_ = probe.height;
            }
        }
    }

    p << "tee name=t ";

    // --- Recording + inference branch ---
    // For v4l2 sources we keep inference (live detection works) but drop
    // the recording portion. splitmuxsink asserts on first-buffer-not-
    // keyframe for NVENC H.265 on USB, and mp4mux+filesink EOSes after
    // nvinfer's model load. Both failure modes are upstream-quirks
    // specific to the USB pipeline shape; recording comes back when
    // we solve them properly (probably by app-level mp4 rotation).
    p << "t. ! queue max-size-buffers=200 leaky=downstream ! ";

    // Use the probed recording dims if we have them, falling back to 1080p.
    // enable-padding=1 tells nvstreammux to letterbox rather than stretch,
    // preserving the source aspect — important for panorama cams.
    int mux_w = rec_width_ > 0 ? rec_width_ : 1920;
    int mux_h = rec_height_ > 0 ? rec_height_ : 1080;

    // ANPR SGIE chain — LPDNet (plate detector) + LPRNet (OCR) run
    // after the tracker so they see vehicles with stable track_ids.
    // gie-unique-id values (2 + 3) are wired into lpdnet.txt /
    // lprnet.txt so the probe can distinguish plate obj_meta from
    // pgie obj_meta via unique_component_id. Empty string when ANPR
    // is off — the primary chain is unchanged.
    std::string anpr_chain;
    if (use_anpr_) {
        anpr_chain =
            "nvinfer name=lpdnet config-file-path=/etc/fnvr/nvinfer/lpdnet.txt ! "
            "nvinfer name=lprnet config-file-path=/etc/fnvr/nvinfer/lprnet.txt ! ";
    }

    if (use_deepstream_ && is_v4l2) {
        p << "nvv4l2decoder ! "
             "mux.sink_0 nvstreammux name=mux batch-size=1 "
             "  width=" << mux_w << " height=" << mux_h
             << " live-source=1 batched-push-timeout=40000 enable-padding=1 ! "
             "nvinfer name=pgie config-file-path=" << infer_config_ << " ! "
             // NvDCF tracker gives us stable per-object track_ids.
             // Required for tripwire line-crossing evaluation (which
             // needs to see an object on both sides of the line across
             // consecutive frames) and for future cross-camera ReID.
             "nvtracker name=tracker "
             "  ll-lib-file=/opt/nvidia/deepstream/deepstream/lib/libnvds_nvmultiobjecttracker.so "
             "  ll-config-file=/etc/fnvr/nvinfer/tracker_NvDCF.yml "
             "  tracker-width=960 tracker-height=544 ! "
          << anpr_chain
          << "fakesink sync=false ";
    } else if (use_deepstream_) {
        // DeepStream detection needs decoded frames; re-decode from the
        // elementary stream so it works from both source types. Memory
        // stays NVMM from nvv4l2decoder onward.
        p << "nvv4l2decoder ! "
             "mux.sink_0 nvstreammux name=mux batch-size=1 "
             "  width=" << mux_w << " height=" << mux_h
             << " live-source=1 batched-push-timeout=40000 enable-padding=1 ! "
             "nvinfer name=pgie config-file-path=" << infer_config_ << " ! "
             // NvDCF tracker gives us stable per-object track_ids.
             // Required for tripwire line-crossing evaluation (which
             // needs to see an object on both sides of the line across
             // consecutive frames) and for future cross-camera ReID.
             "nvtracker name=tracker "
             "  ll-lib-file=/opt/nvidia/deepstream/deepstream/lib/libnvds_nvmultiobjecttracker.so "
             "  ll-config-file=/etc/fnvr/nvinfer/tracker_NvDCF.yml "
             "  tracker-width=960 tracker-height=544 ! "
          << anpr_chain
          << "nvvideoconvert ! "
             // H.264 (not H.265) for the recording branch: browsers play
             // H.264-in-MP4 universally; H.265-in-MP4 works only in Safari
             // and some Chrome-on-Apple-Silicon builds, so clips looked
             // "corrupt" in the timeline player. 6 Mbps at 1080p keeps
             // bitrate budget within shouting distance of the old H.265.
             "nvv4l2h264enc bitrate=6000000 insert-sps-pps=1 idrinterval=30 iframeinterval=30 ! "
             "h264parse name=recparse config-interval=-1 ! "
             "video/x-h264,stream-format=avc,alignment=au ! "
             // Write plain (non-fragmented) MP4 with moov reserved up-front
             // and refreshed every second. This produces a browser-playable
             // file that's valid mid-write, unlike:
             //   - mp4mux fragmented: no sidx, Firefox refused to play
             //   - qtmux faststart=true: needs EOS to finalise; if the
             //     worker is SIGKILLed, the .mp4 never appears (all data
             //     lives in the .faststart temp file).
             // 4500s headroom covers the hourly rotation with margin.
             "queue max-size-buffers=300 max-size-time=2000000000 "
             "  max-size-bytes=0 ! "
             "qtmux reserved-max-duration=4500000000000 "
             "      reserved-moov-update-period=1000000000 ! "
             "filesink location=" << dir.string() << "/rec.mp4 "
             "         append=false ";
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
    // Explicit 480x270 output (16:9) because videoscale with a width-only
    // caps filter doesn't reliably preserve aspect when the upstream
    // reports a weird pixel-aspect-ratio or has no height in negotiation.
    p << "t. ! queue max-size-buffers=10 leaky=downstream ! "
         "h264parse ! nvv4l2decoder ! nvvideoconvert ! "
         "video/x-raw,format=I420 ! videoscale add-borders=true ! "
         "video/x-raw,width=480,height=270,pixel-aspect-ratio=1/1 ! "
         "videorate ! video/x-raw,framerate=1/1 ! "
         "jpegenc quality=75 ! "
         "multifilesink location=/var/lib/fnvr/live/" << cam_.id << ".%d.jpg "
         "  async=false sync=false post-messages=false max-files=4 index=0 ";

    // --- WebRTC live-view branch ---
    // A dedicated RTP payloader fed from the H.264 elementary stream;
    // a tee downstream lets multiple per-viewer webrtcbins (added at
    // WHEP-negotiation time) tap the same RTP packets. Without the
    // fakesink here the payloader pad has no peer on startup and the
    // pipeline won't preroll.
    p << "t. ! queue max-size-buffers=200 leaky=downstream ! "
         "h264parse config-interval=-1 ! "
         "rtph264pay name=pay pt=96 config-interval=-1 aggregate-mode=zero-latency ! "
         "application/x-rtp,media=video,encoding-name=H264,payload=96 ! "
         "tee name=rtp_tee allow-not-linked=true ! "
         "fakesink sync=false async=false";

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
        // Attach the detection probe to the last nvinfer in the chain:
        //   lprnet (ANPR on)  →  tracker  →  pgie
        // So the probe sees classifier_meta populated by LPRNet when
        // ANPR is enabled, track_ids from NvDCF otherwise, and at
        // worst pgie's bare output.
        GstElement* attach = gst_bin_get_by_name(GST_BIN(pipeline), "lprnet");
        if (!attach) attach = gst_bin_get_by_name(GST_BIN(pipeline), "tracker");
        if (!attach) attach = gst_bin_get_by_name(GST_BIN(pipeline), "pgie");
        if (attach) {
            GstPad* src = gst_element_get_static_pad(attach, "src");
            if (src) {
                // Leaked on purpose: lifetime matches the pipeline, cleaned up
                // when the process exits. Fine for M2, tighten when we have
                // multi-pipeline lifecycle.
                auto* ctx = new ProbeCtx{cam_.id, nats_, cam_.muted_classes};
                gst_pad_add_probe(src, GST_PAD_PROBE_TYPE_BUFFER, &InferSrcProbe, ctx, nullptr);
                gst_object_unref(src);
            }
            gst_object_unref(attach);
        }
    }
#endif

    // Keyframe gate on the H.265 record-parse element.
    if (use_deepstream_) {
        AttachKeyframeGate(pipeline, "recparse");
    }

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
                    // Last-value stream on api-server side — see state.go.
                    std::string subj = "fnvr.state.camera." + self->cam_.id;
                    std::string payload = "{\"camera_id\":\"" + self->cam_.id + "\",\"state\":\"running\"}";
                    self->nats_->Publish(subj, payload, /*flush=*/true);
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

    // Stand up the WHEP server once the main pipeline is in PLAYING; new
    // viewer webrtcbins attach to the rtp_tee on demand.
    GstElement* rtp_tee = gst_bin_get_by_name(GST_BIN(pipeline_), "rtp_tee");
    if (!rtp_tee) {
        std::cerr << "pipeline[" << cam_.id << "]: rtp_tee not found in pipeline; webrtc disabled\n";
    } else {
        std::cerr << "pipeline[" << cam_.id << "]: rtp_tee found, starting WHEP server\n";
        whep_ = std::make_unique<WhepServer>(cam_.id, pipeline_, rtp_tee);
        if (!whep_->Start()) {
            std::cerr << "pipeline[" << cam_.id << "]: whep server failed to start\n";
            whep_.reset();
        } else if (nats_) {
            // Publish {camera_id, port} so api-server can route WHEP requests.
            char payload[256];
            std::snprintf(payload, sizeof(payload),
                          "{\"camera_id\":\"%s\",\"port\":%d}",
                          cam_.id.c_str(), whep_->port());
            std::cerr << "pipeline[" << cam_.id << "]: publishing whep port=" << whep_->port() << "\n";
            nats_->Publish("fnvr.whep.registry", payload, /*flush=*/true);
        }
        gst_object_unref(rtp_tee);
    }
    return true;
}

int SingleCameraPipeline::WhepPort() const {
    return whep_ ? whep_->port() : 0;
}

void SingleCameraPipeline::Stop() {
    whep_.reset();
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

#include "pipeline.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <random>
#include <map>
#include <set>
#include <sstream>
#include <utility>
#include <vector>

#include "face_crop_jpeg.h"
#include "preview_probe.h"
#include "gpu_jpeg.h"
#include "object_phash.h"
#include "rtsp_probe.h"
#include "surface_alloc.h"

// DeepStream metadata. Only include when building against DeepStream —
// these headers come from the DeepStream SBSA base image.
#if __has_include(<gstnvdsmeta.h>)
#  define FNVR_HAS_DEEPSTREAM 1
#  include <gstnvdsmeta.h>
#  include <nvdsmeta.h>
// NvDsInferTensorMeta + NVDSINFER_TENSOR_OUTPUT_META for the face
// embedder's output-tensor-meta extraction.
#  include <gstnvdsinfer.h>
// NvBufSurface + NvBufSurfTransform for in-probe face cropping:
// we GPU-convert the batched NVMM buffer into a small pitch-linear
// RGBA surface that libjpeg can read synchronously.
#  include <nvbufsurface.h>
#  include <nvbufsurftransform.h>
#endif

namespace fnvr {

namespace fs = std::filesystem;

// Directory for worker → supervisor fault attribution markers. When a
// bus ERROR can be pinned on one member's source chain, the child
// writes "<camera_id>" to <run_dir>/group-<group_id>.fault and exits
// rc=4; the supervisor quarantines that member and respawns the group
// without it. Same container, same filesystem — a tmpfile is the
// simplest reliable channel.
static std::string RunDir() {
    const char* d = std::getenv("FNVR_RUN_DIR");
    return (d && *d) ? d : "/tmp/fnvr-run";
}

GroupPipeline::GroupPipeline(std::string group_id,
                             std::vector<CameraConfig> members,
                             std::string recordings_dir,
                             std::string infer_config, bool use_deepstream,
                             bool use_anpr, bool use_face_id,
                             NatsPublisher* nats)
    : group_id_(std::move(group_id)),
      recordings_dir_(std::move(recordings_dir)),
      infer_config_(std::move(infer_config)),
      use_deepstream_(use_deepstream),
      use_anpr_(use_anpr),
      use_face_id_(use_face_id),
      nats_(nats) {
    for (auto& m : members) {
        auto s = std::make_unique<SourceRuntime>();
        s->cam = std::move(m);
        sources_.push_back(std::move(s));
    }
}

GroupPipeline::~GroupPipeline() { Stop(); }

#if FNVR_HAS_DEEPSTREAM
namespace {

// Generate a short random ID (no UUID lib dependency).
std::string short_id() {
    static thread_local std::mt19937_64 rng{std::random_device{}()};
    std::ostringstream os;
    os << std::hex << rng();
    return os.str();
}

// Legacy nvstreammux with enable-padding=1 letterboxes each source
// into the canvas. Whether the padding is centred or bottom/right
// anchored is not documented; this constant is verified empirically
// (see docs/architecture/pipeline.md § batched mux) — flip it here if
// a DS upgrade changes the behaviour.
constexpr bool kMuxPadsCentered = false;

// Per-member view the probes use to attribute batch frames back to
// cameras and to invert the mux letterbox when normalising bboxes.
// Per-track publish-thinning state (objects only; faces/plates are
// never thinned). A track re-publishes when it MOVES (> eps of the
// frame), changes class, or its keepalive lapses — a parked car or a
// wall-mounted monitor no longer produces 20 rows/second of identical
// detections. Movement-based publishing keeps consecutive sightings
// dense enough for the tripwire rules (which interpolate between
// consecutive published positions).
struct TrackPubState {
    float x = -1, y = -1, w = 0, h = 0;
    std::string cls;
    std::chrono::steady_clock::time_point last_pub{};
    std::chrono::steady_clock::time_point last_seen{};
};

struct SourceView {
    std::string                 camera_id;
    std::set<std::string>       muted_classes;
    std::atomic<std::uint64_t>* frames = nullptr;
    std::map<std::uint64_t, TrackPubState> track_pub;
    // Letterbox mapping, computed lazily from the first frame's
    // source_frame_{width,height} (runtime truth beats the probe).
    bool  lb_ready = false;
    int   src_w = 0, src_h = 0;
    float dw = 0.f, dh = 0.f;      // scaled source extent on the canvas
    float pad_x = 0.f, pad_y = 0.f;
};

struct ProbeCtx {
    std::string             group_id;
    NatsPublisher*          nats = nullptr;
    int                     canvas_w = 1920;
    int                     canvas_h = 1080;
    std::vector<SourceView> sources;
    // Output directory for per-detection face JPEGs ({thumbs_dir}/{event_id}.jpg).
    // Empty when face_id is off — saveFaceCrop short-circuits.
    std::string             thumbs_dir;
    // Output directory for per-detection OBJECT crop JPEGs.
    std::string             thumbs_dir_objects;
    // Replay mode: detections carry HISTORICAL timestamps derived
    // from the recording's start + buffer PTS, and publish on the
    // retro subject so event-processor stores them without firing
    // alarm/notification rules for footage from the past.
    // 0 = live mode (wall clock, normal subject).
    std::int64_t            replay_base_epoch_ms = 0;
    std::string             subject_prefix = "fnvr.events.detection.";
    // Heartbeat counters, logged every ~250 buffers.
    std::uint64_t hb_buffers    = 0;
    std::uint64_t hb_batch_null = 0;
    std::uint64_t hb_frames_obj = 0;
    std::uint64_t hb_objects    = 0;
    std::uint64_t hb_published  = 0;
};

void computeLetterbox(SourceView& sv, int src_w, int src_h,
                      int canvas_w, int canvas_h) {
    sv.src_w = src_w > 0 ? src_w : canvas_w;
    sv.src_h = src_h > 0 ? src_h : canvas_h;
    const float scale = std::min(float(canvas_w) / float(sv.src_w),
                                 float(canvas_h) / float(sv.src_h));
    sv.dw    = float(sv.src_w) * scale;
    sv.dh    = float(sv.src_h) * scale;
    sv.pad_x = kMuxPadsCentered ? (float(canvas_w) - sv.dw) / 2.f : 0.f;
    sv.pad_y = kMuxPadsCentered ? (float(canvas_h) - sv.dh) / 2.f : 0.f;
    sv.lb_ready = true;
}

// JSON-escape minimal — only the fields we emit. Labels are small ASCII, IDs
// are hex. Good enough; swap for a real encoder when we move to binary
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

// Publish-thinning knobs (env-overridable). Keepalive must stay well
// under the Live overlay age-out and comfortably under rule windows.
inline int thinKeepaliveMs() {
    static const int v = [] {
        const char* e = std::getenv("FNVR_THIN_KEEPALIVE_MS");
        int n = e ? std::atoi(e) : 2000;
        return n > 0 ? n : 2000;
    }();
    return v;
}
inline float thinEps() {
    static const float v = [] {
        const char* e = std::getenv("FNVR_THIN_EPS");
        float f = e ? float(std::atof(e)) : 0.02f;
        return (f > 0.f && f < 0.5f) ? f : 0.02f;
    }();
    return v;
}
inline bool thinEnabled() {
    static const bool v = [] {
        const char* e = std::getenv("FNVR_THIN");
        return !(e && std::string(e) == "0");
    }();
    return v;
}

// The plate detector is attached as gie-unique-id=2 in platedet.txt.
// Any obj_meta with this component id is a plate crop, not a primary-
// detector object. Pgie = 1; the OCR (classifier) only updates
// classifier_meta on the plate's obj_meta — it doesn't add new objs.
constexpr unsigned PLATEDET_GIE_ID = 2;
// SCRFD detector is gie-unique-id=4 in scrfd.txt (arcface is 5).
constexpr unsigned SCRFD_GIE_ID   = 4;
// ArcFace's 512-d output lands on the face obj_meta's user meta.
constexpr int      ARCFACE_DIM    = 512;
// Minimum face bbox in CANVAS pixels — below this, the embedder
// output is noise.
constexpr int      MIN_FACE_PX    = 30;

std::string base64_encode(const void* data, size_t n) {
    static const char tbl[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const uint8_t* b = static_cast<const uint8_t*>(data);
    std::string out;
    out.reserve(((n + 2) / 3) * 4);
    size_t i = 0;
    for (; i + 3 <= n; i += 3) {
        uint32_t v = (uint32_t(b[i]) << 16) | (uint32_t(b[i + 1]) << 8) | b[i + 2];
        out.push_back(tbl[(v >> 18) & 0x3F]);
        out.push_back(tbl[(v >> 12) & 0x3F]);
        out.push_back(tbl[(v >> 6) & 0x3F]);
        out.push_back(tbl[v & 0x3F]);
    }
    if (i < n) {
        uint32_t v = uint32_t(b[i]) << 16;
        if (i + 1 < n) v |= uint32_t(b[i + 1]) << 8;
        out.push_back(tbl[(v >> 18) & 0x3F]);
        out.push_back(tbl[(v >> 12) & 0x3F]);
        out.push_back(i + 1 < n ? tbl[(v >> 6) & 0x3F] : '=');
        out.push_back('=');
    }
    return out;
}

// extractFaceEmbedding finds the embedder's 512-d output on the face's
// user-meta list and base64-encodes it. Returns empty string if the
// embedder hasn't run on this object.
std::string extractFaceEmbedding(NvDsObjectMeta* obj) {
    for (NvDsMetaList* ul = obj->obj_user_meta_list; ul; ul = ul->next) {
        auto* um = static_cast<NvDsUserMeta*>(ul->data);
        if (!um) continue;
        if (um->base_meta.meta_type != NVDSINFER_TENSOR_OUTPUT_META) continue;
        auto* tm = static_cast<NvDsInferTensorMeta*>(um->user_meta_data);
        if (!tm || tm->num_output_layers == 0) continue;
        void* host_buf = tm->out_buf_ptrs_host ? tm->out_buf_ptrs_host[0] : nullptr;
        if (!host_buf) continue;
        auto& li = tm->output_layers_info[0];
        unsigned total = 1;
        for (unsigned d = 0; d < li.inferDims.numDims; d++) {
            total *= li.inferDims.d[d];
        }
        if (total != ARCFACE_DIM) continue;
        return base64_encode(host_buf, size_t(ARCFACE_DIM) * sizeof(float));
    }
    return {};
}

// extractPlateText pulls the plate string from the obj_meta's
// classifier_meta_list, as populated by the LPRNet CTC parser.
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

std::string parentVehicleClass(NvDsObjectMeta* obj) {
    if (obj->parent && obj->parent->obj_label[0]) {
        return std::string(obj->parent->obj_label);
    }
    return {};
}

// saveFaceCrop extracts a crop of the current probe buffer's frame at
// the given CANVAS-normalised bbox, converts it to a small RGBA host
// buffer via GPU-accelerated NvBufSurfTransform, JPEG-encodes and
// writes. The crop rectangle lives in canvas space because the batched
// surface slot IS the canvas — the source-normalised coords published
// to NATS are computed separately via the letterbox inverse.
constexpr int CROP_OUT_W = 256;
constexpr int CROP_OUT_H = 256;

void saveFaceCrop(const ProbeCtx& ctx, GstBuffer* gst_buf,
                  NvDsFrameMeta* frame,
                  float nx, float ny, float nw, float nh,
                  const std::string& short_id) {
    if (ctx.thumbs_dir.empty() || !gst_buf || !frame) return;

    // Pin this streaming thread's transform session to GPU compute
    // (no VIC on GB10) with its own CUDA stream. Idempotent.
    EnsureGpuTransformSession();

    // Expand bbox 1.4x around centre, clip to [0,1].
    float pad = 1.4f;
    float cx = nx + nw / 2.0f;
    float cy = ny + nh / 2.0f;
    float pw = nw * pad;
    float ph = nh * pad;
    float x0 = cx - pw / 2.0f;
    float y0 = cy - ph / 2.0f;
    float x1 = cx + pw / 2.0f;
    float y1 = cy + ph / 2.0f;
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 > 1) x1 = 1;
    if (y1 > 1) y1 = 1;

    GstMapInfo map{};
    if (!gst_buffer_map(gst_buf, &map, GST_MAP_READ)) return;
    auto* in_surf = reinterpret_cast<NvBufSurface*>(map.data);
    if (!in_surf || frame->batch_id >= in_surf->numFilled) {
        gst_buffer_unmap(gst_buf, &map);
        return;
    }
    NvBufSurfaceParams& in_p = in_surf->surfaceList[frame->batch_id];
    const int W = int(in_p.width);
    const int H = int(in_p.height);

    int px = int(x0 * W);
    int py = int(y0 * H);
    int pw_px = int((x1 - x0) * W);
    int ph_px = int((y1 - y0) * H);
    if (pw_px <= 1 || ph_px <= 1) {
        gst_buffer_unmap(gst_buf, &map);
        return;
    }

    // GPU crop + resize + JPEG (nvjpeg) — the streaming thread no
    // longer syncs + CPU-maps per detection; see gpu_jpeg.cpp.
    NvBufSurfTransformRect src_rect {
        guint(py), guint(px), guint(pw_px), guint(ph_px)  // top, left, w, h
    };
    std::string out_path = ctx.thumbs_dir + "/" + short_id + ".jpg";
    (void)SaveNv12RegionJpeg(in_surf, frame->batch_id, src_rect,
                             CROP_OUT_W, CROP_OUT_H, 85, out_path, nullptr);
    gst_buffer_unmap(gst_buf, &map);
}

// Object-detection thumbnail dims. 128×128 JPEGs at quality 75 are ~2.5 KB.
constexpr int OBJ_CROP_OUT_W = 128;
constexpr int OBJ_CROP_OUT_H = 128;

// saveObjectCropAndHash mirrors saveFaceCrop but for non-face / non-
// plate detections. Returns the 64-bit average-hash of the bbox crop.
// Returns 0 on any failure — the caller still emits the detection,
// suppression just doesn't apply.
std::uint64_t saveObjectCropAndHash(const ProbeCtx& ctx, GstBuffer* gst_buf,
                                    NvDsFrameMeta* frame,
                                    float nx, float ny, float nw, float nh,
                                    const std::string& short_id) {
    if (!gst_buf || !frame) return 0;

    // GPU transform session for this streaming thread (idempotent).
    EnsureGpuTransformSession();

    float x0 = nx, y0 = ny, x1 = nx + nw, y1 = ny + nh;
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 > 1) x1 = 1;
    if (y1 > 1) y1 = 1;

    GstMapInfo map{};
    if (!gst_buffer_map(gst_buf, &map, GST_MAP_READ)) return 0;
    auto* in_surf = reinterpret_cast<NvBufSurface*>(map.data);
    if (!in_surf || frame->batch_id >= in_surf->numFilled) {
        gst_buffer_unmap(gst_buf, &map);
        return 0;
    }
    NvBufSurfaceParams& in_p = in_surf->surfaceList[frame->batch_id];
    const int W = int(in_p.width);
    const int H = int(in_p.height);

    int px = int(x0 * W);
    int py = int(y0 * H);
    int pw_px = int((x1 - x0) * W);
    int ph_px = int((y1 - y0) * H);
    if (pw_px <= 8 || ph_px <= 8) {
        gst_buffer_unmap(gst_buf, &map);
        return 0;
    }

    NvBufSurfTransformRect src_rect {
        guint(py), guint(px), guint(pw_px), guint(ph_px)
    };
    std::string out_path;
    if (!ctx.thumbs_dir_objects.empty()) {
        out_path = ctx.thumbs_dir_objects + "/" + short_id + ".jpg";
    }
    std::uint64_t hash = 0;
    (void)SaveNv12RegionJpeg(in_surf, frame->batch_id, src_rect,
                             OBJ_CROP_OUT_W, OBJ_CROP_OUT_H, 75, out_path,
                             &hash);
    gst_buffer_unmap(gst_buf, &map);
    return hash;
}

// Called for every batched buffer leaving the last nvinfer in the
// chain. Walks each frame in the batch, attributes it to its member
// camera via frame_meta->pad_index, normalises bboxes back into
// SOURCE space via the letterbox inverse, and publishes one JSON
// Detection per object on fnvr.events.detection.<camera_id>.
GstPadProbeReturn InferSrcProbe(GstPad*, GstPadProbeInfo* info, gpointer user) {
    auto* ctx = static_cast<ProbeCtx*>(user);
    GstBuffer* buf = gst_pad_probe_info_get_buffer(info);
    if (!buf) return GST_PAD_PROBE_OK;

    ctx->hb_buffers++;
    NvDsBatchMeta* batch = gst_buffer_get_nvds_batch_meta(buf);
    if (!batch) {
        ctx->hb_batch_null++;
        if ((ctx->hb_buffers % 250) == 0) {
            std::cerr << "probe[" << ctx->group_id << "]: buffers="
                      << ctx->hb_buffers << " batch_null=" << ctx->hb_batch_null
                      << " (no NvDsBatchMeta on pad)\n";
        }
        return GST_PAD_PROBE_OK;
    }

    gint64 ts_ns = g_get_real_time() * 1000;  // µs → ns
    if (ctx->replay_base_epoch_ms > 0) {
        // Historical footage: recording start + this buffer's PTS.
        const GstClockTime pts = GST_BUFFER_PTS(buf);
        const std::int64_t pts_ms =
            GST_CLOCK_TIME_IS_VALID(pts) ? std::int64_t(pts / 1'000'000) : 0;
        ts_ns = (ctx->replay_base_epoch_ms + pts_ms) * 1'000'000;
    }
    // Millisecond-resolution ISO 8601 (Live overlay age-out needs
    // sub-second resolution).
    auto iso = [ts_ns]{
        std::time_t t = ts_ns / 1'000'000'000;
        long ms = (ts_ns / 1'000'000) % 1000;
        std::tm tm{}; gmtime_r(&t, &tm);
        char b[40];
        std::strftime(b, sizeof b, "%Y-%m-%dT%H:%M:%S", &tm);
        char out[40];
        std::snprintf(out, sizeof out, "%s.%03ldZ", b, ms);
        return std::string(out);
    }();

    for (NvDsMetaList* fl = batch->frame_meta_list; fl; fl = fl->next) {
        auto* frame = static_cast<NvDsFrameMeta*>(fl->data);
        if (!frame) continue;
        const guint idx = frame->pad_index;
        if (idx >= ctx->sources.size()) continue;
        SourceView& sv = ctx->sources[idx];
        if (sv.frames) sv.frames->fetch_add(1, std::memory_order_relaxed);

        if (!sv.lb_ready) {
            computeLetterbox(sv, int(frame->source_frame_width),
                             int(frame->source_frame_height),
                             ctx->canvas_w, ctx->canvas_h);
            std::cerr << "probe[" << ctx->group_id << "]: source "
                      << sv.camera_id << " " << sv.src_w << "x" << sv.src_h
                      << " → canvas " << ctx->canvas_w << "x" << ctx->canvas_h
                      << " scaled " << sv.dw << "x" << sv.dh
                      << " pad " << sv.pad_x << "," << sv.pad_y << "\n";
        }

        bool frame_had_obj = false;
        // Per-frame batch: one NATS message per camera per frame
        // ({"camera_id","ts","batch":[obj,...]}) instead of one per
        // object — 10-50x fewer messages under daytime load, and the
        // consumer can multi-row INSERT. Consumers accept both the
        // legacy single-object shape and this batch shape.
        std::ostringstream frame_batch;
        int frame_batch_n = 0;

        for (NvDsMetaList* ol = frame->obj_meta_list; ol; ol = ol->next) {
            auto* obj = static_cast<NvDsObjectMeta*>(ol->data);
            if (!obj) continue;
            ctx->hb_objects++;
            frame_had_obj = true;

            // rect_params are CANVAS-space (the batched surface).
            // Canvas-normalised coords drive the GPU crops; source-
            // normalised coords (letterbox inverse, clamped) go on the
            // wire so zones/rules/overlays line up with the camera
            // image regardless of the shared canvas shape.
            const float cnx = obj->rect_params.left   / float(ctx->canvas_w);
            const float cny = obj->rect_params.top    / float(ctx->canvas_h);
            const float cnw = obj->rect_params.width  / float(ctx->canvas_w);
            const float cnh = obj->rect_params.height / float(ctx->canvas_h);

            auto clamp01 = [](float v) {
                return v < 0.f ? 0.f : (v > 1.f ? 1.f : v);
            };
            float x = clamp01((obj->rect_params.left - sv.pad_x) / sv.dw);
            float y = clamp01((obj->rect_params.top  - sv.pad_y) / sv.dh);
            float w = clamp01(obj->rect_params.width  / sv.dw);
            float h = clamp01(obj->rect_params.height / sv.dh);
            if (x + w > 1.f) w = 1.f - x;
            if (y + h > 1.f) h = 1.f - y;

            const bool is_plate = (obj->unique_component_id == PLATEDET_GIE_ID);
            const bool is_face  = (obj->unique_component_id == SCRFD_GIE_ID);
            const char* label = is_plate
                ? "plate"
                : is_face
                    ? "face"
                    : (obj->obj_label[0] ? obj->obj_label : "object");

            // Class-mute gate at source, per member camera.
            if (!sv.muted_classes.empty() &&
                sv.muted_classes.count(label) > 0) {
                continue;
            }

            std::string plate, parent;
            if (is_plate) {
                plate = extractPlateText(obj);
                if (plate.empty()) continue;
                parent = parentVehicleClass(obj);
            }
            std::string embedding_b64;
            if (is_face) {
                if (obj->rect_params.width < MIN_FACE_PX ||
                    obj->rect_params.height < MIN_FACE_PX) {
                    continue;
                }
                embedding_b64 = extractFaceEmbedding(obj);
                if (embedding_b64.empty()) continue;
            }
            const char* kind = is_plate ? "anpr" : is_face ? "face" : "object";
            const uint64_t track_id = (is_plate && obj->parent)
                ? obj->parent->object_id
                : obj->object_id;

            // Publish thinning (objects only): skip the crop + publish
            // work for a track that hasn't moved, changed class, or
            // hit its keepalive since the last publish.
            if (!is_plate && !is_face && thinEnabled()) {
                const auto now_tp = std::chrono::steady_clock::now();
                auto& tp = sv.track_pub[track_id];
                tp.last_seen = now_tp;
                const bool first = tp.x < 0;
                const float eps = thinEps();
                const bool moved =
                    !first && (std::abs(x - tp.x) > eps ||
                               std::abs(y - tp.y) > eps ||
                               std::abs(w - tp.w) > eps ||
                               std::abs(h - tp.h) > eps);
                const bool reclassed = !first && tp.cls != label;
                const bool keepalive =
                    !first &&
                    now_tp - tp.last_pub >
                        std::chrono::milliseconds(thinKeepaliveMs());
                if (!(first || moved || reclassed || keepalive)) {
                    continue;
                }
                tp.x = x; tp.y = y; tp.w = w; tp.h = h;
                tp.cls = label;
                tp.last_pub = now_tp;
            }

            const std::string det_id = short_id();
            if (is_face) {
                saveFaceCrop(*ctx, buf, frame, cnx, cny, cnw, cnh, det_id);
            }

            std::uint64_t obj_phash = 0;
            if (!is_face && !is_plate) {
                obj_phash = saveObjectCropAndHash(*ctx, buf, frame,
                                                  cnx, cny, cnw, cnh, det_id);
            }

            std::ostringstream js;
            js << "{"
               << "\"id\":\""         << det_id                    << "\","
               << "\"camera_id\":\""  << json_escape(sv.camera_id) << "\","
               << "\"ts\":\""         << iso                       << "\","
               << "\"class_name\":\"" << json_escape(label)        << "\","
               << "\"kind\":\""       << kind                      << "\","
               << "\"confidence\":"   << obj->confidence           << ","
               << "\"bbox\":{\"x\":"  << x << ",\"y\":" << y
               <<          ",\"w\":"  << w << ",\"h\":" << h << "},"
               << "\"track_id\":\""   << track_id                  << "\"";
            if (is_plate) {
                js << ",\"attributes\":{"
                   << "\"plate\":\""         << json_escape(plate)  << "\"";
                if (!parent.empty()) {
                    js << ",\"parent_class\":\"" << json_escape(parent) << "\"";
                }
                js << "}";
            } else if (is_face) {
                js << ",\"attributes\":{"
                   << "\"embedding\":\""     << embedding_b64       << "\""
                   << "}";
            }
            if (!is_plate && !is_face && obj_phash != 0) {
                js << ",\"phash\":\"" << uint64ToHex16(obj_phash) << "\"";
            }
            js << "}";
            if (frame_batch_n++) frame_batch << ",";
            frame_batch << js.str();
            ctx->hb_published++;
        }
        if (frame_batch_n > 0 && ctx->nats) {
            std::string payload = "{\"camera_id\":\"" +
                                  json_escape(sv.camera_id) +
                                  "\",\"ts\":\"" + iso +
                                  "\",\"batch\":[" + frame_batch.str() +
                                  "]}";
            std::string subj = ctx->subject_prefix + sv.camera_id;
            if (!ctx->nats->Publish(subj, payload)) {
                ctx->hb_published -= frame_batch_n;
            }
        }
        if (frame_had_obj) ctx->hb_frames_obj++;
    }
    if ((ctx->hb_buffers % 250) == 0) {
        // Prune per-track thinning state for tracks unseen >30 s so
        // long-running workers don't accumulate dead track ids.
        const auto cutoff =
            std::chrono::steady_clock::now() - std::chrono::seconds(30);
        for (auto& sv : ctx->sources) {
            for (auto it = sv.track_pub.begin(); it != sv.track_pub.end();) {
                if (it->second.last_seen < cutoff) {
                    it = sv.track_pub.erase(it);
                } else {
                    ++it;
                }
            }
        }
        std::cerr << "probe[" << ctx->group_id << "]: buffers=" << ctx->hb_buffers
                  << " batch_null=" << ctx->hb_batch_null
                  << " frames_with_obj=" << ctx->hb_frames_obj
                  << " objects=" << ctx->hb_objects
                  << " published=" << ctx->hb_published << "\n";
    }
    return GST_PAD_PROBE_OK;
}

}  // namespace
#endif  // FNVR_HAS_DEEPSTREAM

// Time this child-worker process started + startup grace plumbing.
static const auto g_worker_process_start = std::chrono::steady_clock::now();
static int g_worker_startup_grace_sec = 0;

void SetWorkerStartupGraceSec(int sec) { g_worker_startup_grace_sec = sec; }

namespace {

// abortGroupAfterFault hard-exits the worker so the supervisor
// respawns with a clean slate (graceful GStreamer teardown can block
// forever on a wedged element). When the fault was attributed to one
// member's source chain, the caller has already written the fault
// marker and published that camera's `failed`; exit rc=4 tells the
// supervisor to quarantine. Unattributed faults exit rc=3 — the
// supervisor's flap logic decides when to surface those.
[[noreturn]] void abortGroupAfterFault(const std::string& group_id,
                                       const char* reason, int rc) {
    std::cerr << "group[" << group_id << "]: hard-exit rc=" << rc
              << " (" << reason << ")\n";
    std::_Exit(rc);
}

// Extract a member index from an element name of the form
// "<prefix>_<idx>" using our per-member naming convention. Returns
// -1 when the name doesn't match.
int memberIndexFromName(const char* name) {
    if (!name) return -1;
    // "_sub_" variants first — "src_sub_3" must not be rejected by the
    // "src_" prefix ("sub_3" fails the all-digits check) before the
    // longer prefix gets a look.
    static const char* prefixes[] = {"src_sub_", "depay_sub_", "parse_sub_",
                                     "src_", "depay_", "parse_", "qi_",
                                     "dec_", "qm_", "qp_", "pp_", "push_",
                                     "tp_", "pq_", "pconv_", "penc_",
                                     "ppp_", "ppush_"};
    for (const char* p : prefixes) {
        size_t n = std::strlen(p);
        if (std::strncmp(name, p, n) == 0) {
            char* end = nullptr;
            long idx = std::strtol(name + n, &end, 10);
            if (end && *end == '\0' && idx >= 0) return int(idx);
        }
    }
    return -1;
}

}  // namespace

gboolean GroupPipeline::BusHandler(GstBus*, GstMessage* msg, gpointer user_data) {
    auto* self = static_cast<GroupPipeline*>(user_data);
    switch (GST_MESSAGE_TYPE(msg)) {
        case GST_MESSAGE_EOS:
            std::cerr << "group[" << self->group_id_ << "]: EOS\n";
            self->faulted_.store(true);
            abortGroupAfterFault(self->group_id_, "EOS", 3);
        case GST_MESSAGE_ERROR: {
            GError* err = nullptr;
            gchar* dbg = nullptr;
            gst_message_parse_error(msg, &err, &dbg);
            std::string msg_str = err ? err->message : "?";
            std::cerr << "group[" << self->group_id_ << "] error: "
                      << msg_str << "\n";
            if (err) g_error_free(err);
            g_free(dbg);
            // NOTE: faulted_ is only set on paths that abort the
            // process — a member-attributed error keeps the group
            // alive (heartbeats/watchdogs must keep running).

            // Try to attribute the error to one member's source chain
            // by climbing the message source's parents looking for our
            // per-member element names.
            int member = -1;
            {
                GstObject* o = GST_MESSAGE_SRC(msg);
                if (o) gst_object_ref(o);
                while (o) {
                    member = memberIndexFromName(GST_OBJECT_NAME(o));
                    if (member >= 0) {
                        gst_object_unref(o);
                        break;
                    }
                    GstObject* parent = gst_object_get_parent(o);  // refs
                    gst_object_unref(o);
                    o = parent;
                }
            }
            if (member >= 0 && size_t(member) < self->sources_.size() &&
                self->sources_.size() > 1) {
                auto& src = *self->sources_[member];
                const std::string& cam_id = src.cam.id;
                // Mark the member's branch dead and KEEP THE GROUP
                // RUNNING — siblings must not pay for one camera's
                // transient RTSP burp. The group self-heals with one
                // debounced restart (main.cpp) to revive the branch;
                // the supervisor strike-counts the marker and only
                // quarantines repeat offenders.
                if (!src.dead.exchange(true)) {
                    const int now_dead = self->dead_members_.fetch_add(1) + 1;
                    if (now_dead == 1) {
                        self->first_death_at_ = std::chrono::steady_clock::now();
                    }
                    std::cerr << "group[" << self->group_id_
                              << "]: member " << member << " (" << cam_id
                              << ") source chain died — marking dead ("
                              << now_dead << "/" << self->sources_.size()
                              << "), siblings keep running\n";
                    std::error_code ec;
                    fs::create_directories(RunDir(), ec);
                    std::ofstream mk(RunDir() + "/group-" + self->group_id_ + ".fault",
                                     std::ios::app);
                    mk << cam_id << "\n";
                    mk.close();
                    if (self->nats_) {
                        const std::string subj = "fnvr.state.camera." + cam_id;
                        const std::string payload =
                            "{\"camera_id\":\"" + cam_id + "\",\"state\":\"failed\"}";
                        self->nats_->Publish(subj, payload, /*flush=*/true);
                    }
                }
                // All members dead → nothing left to protect; restart now.
                if (self->dead_members_.load() >= int(self->sources_.size())) {
                    self->faulted_.store(true);
                    abortGroupAfterFault(self->group_id_, "all members dead", 3);
                }
                return TRUE;  // swallow the error; group stays PLAYING
            }

            // Unattributed (or solo group): for a solo group the single
            // member IS the fault domain — publish failed for it once
            // we're past startup grace, matching the old per-camera
            // behaviour.
            self->faulted_.store(true);
            auto age = std::chrono::duration_cast<std::chrono::seconds>(
                std::chrono::steady_clock::now() - g_worker_process_start).count();
            const bool within_grace = g_worker_startup_grace_sec > 0 &&
                                      age < g_worker_startup_grace_sec;
            if (self->nats_ && self->sources_.size() == 1 && !within_grace) {
                const std::string& cam_id = self->sources_[0]->cam.id;
                self->nats_->Publish("fnvr.state.camera." + cam_id,
                                     "{\"camera_id\":\"" + cam_id +
                                         "\",\"state\":\"failed\"}",
                                     /*flush=*/true);
            }
            abortGroupAfterFault(self->group_id_, "bus error", 3);
        }
        // LATENCY: an element's latency changed after the initial
        // PLAYING transition — rtspclientsink does this once its RTSP
        // handshake completes, well after we started. gst-launch
        // recalculates on this message ("Redistribute latency...");
        // an app-managed pipeline MUST do the same or sync'd sinks
        // pace against a stale latency budget. Symptom before this
        // handler existed: the MediaMTX push leg trickled 1-2 fps of
        // mid-GOP frames (every buffer "late" → dropped) while the
        // inference leg ran at full rate — browsers then only ever
        // decoded the odd surviving IDR.
        case GST_MESSAGE_LATENCY:
            gst_bin_recalculate_latency(GST_BIN(self->pipeline_));
            break;
        // CLOCK_LOST: the clock provider left (e.g. a member's source
        // torn down). The documented recovery is a PAUSED→PLAYING
        // bounce so the pipeline elects a new clock; without it every
        // sync'd sink can stall forever.
        case GST_MESSAGE_CLOCK_LOST:
            gst_element_set_state(self->pipeline_, GST_STATE_PAUSED);
            gst_element_set_state(self->pipeline_, GST_STATE_PLAYING);
            break;
        case GST_MESSAGE_STATE_CHANGED: {
            if (GST_MESSAGE_SRC(msg) == GST_OBJECT(self->pipeline_)) {
                GstState oldS, newS;
                gst_message_parse_state_changed(msg, &oldS, &newS, nullptr);
                if (newS == GST_STATE_PLAYING) {
                    self->playing_.store(true);
                    if (self->nats_) {
                        for (const auto& s : self->sources_) {
                            std::string subj = "fnvr.state.camera." + s->cam.id;
                            std::string payload = "{\"camera_id\":\"" + s->cam.id +
                                                  "\",\"state\":\"running\"}";
                            self->nats_->Publish(subj, payload, /*flush=*/true);
                        }
                    }
                }
            }
            break;
        }
        default:
            break;
    }
    return TRUE;
}

GstElement* GroupPipeline::BuildPipeline() {
    std::error_code ec;
    fs::create_directories("/var/lib/fnvr/live", ec);

    // --- Solo bespoke shapes -------------------------------------------------
    // The planner sends record-only ("none") and transcode
    // (rotation/mtx_proxy) cameras here as single-member groups; they
    // keep the pre-batching graph shapes.
    const bool solo = sources_.size() == 1;
    const CameraConfig& c0 = sources_[0]->cam;
    const bool solo_none = solo && c0.enabled_detectors.size() == 1 &&
                           c0.enabled_detectors[0] == "none";
    const bool solo_transcode = solo && (c0.rotation != 0 || c0.mtx_proxy);

    // Probe every member's codec/dims up front. Members with a
    // substream get BOTH streams probed: the substream feeds the
    // decode/inference leg (saving the main-stream NVDEC cost — the
    // single decoder is the 16-camera ceiling), the main stream is
    // relayed untouched. Detections are published normalised, so they
    // remain valid for main-stream overlays as long as the two
    // streams share an aspect ratio — warn loudly when they don't.
    for (auto& s : sources_) {
        std::string url = s->cam.url;
        if (s->cam.mtx_proxy) url = "rtsp://mediamtx:8554/proxy_" + s->cam.id;
        auto probe = ProbeRtsp(url);
        s->codec    = probe.codec.empty() ? "h264" : probe.codec;
        s->probed_w = probe.width;
        s->probed_h = probe.height;
        std::cerr << "group[" << group_id_ << "]: member " << s->cam.id
                  << " codec=" << s->codec << " size=" << probe.width
                  << "x" << probe.height << "\n";
        if (!s->cam.substream_url.empty()) {
            auto sp = ProbeRtsp(s->cam.substream_url);
            s->sub_codec = sp.codec.empty() ? "h264" : sp.codec;
            s->sub_w = sp.width;
            s->sub_h = sp.height;
            std::cerr << "group[" << group_id_ << "]: member " << s->cam.id
                      << " substream codec=" << s->sub_codec << " size="
                      << sp.width << "x" << sp.height << "\n";
            if (s->probed_w > 0 && s->probed_h > 0 && sp.width > 0 &&
                sp.height > 0) {
                const double ar_main = double(s->probed_w) / s->probed_h;
                const double ar_sub  = double(sp.width) / sp.height;
                if (std::abs(ar_main - ar_sub) / ar_main > 0.01) {
                    std::cerr << "group[" << group_id_ << "]: WARNING member "
                              << s->cam.id << " main/substream aspect differs ("
                              << ar_main << " vs " << ar_sub
                              << ") — normalised bboxes will be offset on "
                                 "main-stream overlays\n";
                }
            }
        }
    }

    std::ostringstream p;

    if (solo_transcode) {
        // Transcode shape (rotation and/or mtx_proxy): decode → rotate →
        // re-encode to H.264 pre-tee, then the standard branches. This
        // is the only graph that spends NVENC.
        std::string url = c0.url;
        if (c0.mtx_proxy) url = "rtsp://mediamtx:8554/proxy_" + c0.id;
        int src_w = sources_[0]->probed_w;
        int src_h = sources_[0]->probed_h;
        int flip_method = 0;
        switch (c0.rotation) {
            case 90:  flip_method = 3; break;
            case 180: flip_method = 2; break;
            case 270: flip_method = 1; break;
            default:  flip_method = 0; break;
        }
        const bool swaps = (c0.rotation == 90 || c0.rotation == 270);
        if (swaps) std::swap(src_w, src_h);
        int tw = 1920, th = 1080;
        if (src_w > 0 && src_h > 0) {
            th = std::min(1080, src_h);
            tw = int(double(th) * src_w / src_h + 0.5);
            if (tw & 1) tw += 1;
        }
        if (tw > 2880) { th = int(2880.0 * th / tw + 0.5); tw = 2880; }
        mux_w_ = tw; mux_h_ = th;

        p << "rtspsrc name=src_0 location=" << url
          << " latency=200 protocols=tcp tcp-timeout=15000000 retry=3 ! ";
        if (sources_[0]->codec == "h265") {
            p << "rtph265depay name=depay_0 ! h265parse name=parse_0 config-interval=1 ! "
                 "video/x-h265,stream-format=byte-stream,alignment=au ! ";
        } else {
            p << "rtph264depay name=depay_0 ! h264parse name=parse_0 config-interval=1 ! ";
        }
        p << "nvv4l2decoder name=dec_0 ! "
             "nvvideoconvert compute-hw=1 flip-method=" << flip_method << " ! "
             "video/x-raw(memory:NVMM),format=NV12,width=" << tw
          << ",height=" << th << " ! "
             "nvv4l2h264enc insert-sps-pps=1 idrinterval=30 iframeinterval=30 ! ";
        // The tee carries H.264 after transcode.
        sources_[0]->codec = "h264";
        const bool skip_inference = solo_none;
        if (!skip_inference) p << "h264parse config-interval=1 ! ";
        p << "tee name=t_0 ";
        // Inference branch (unless detectors=["none"]).
        if (!solo_none && use_deepstream_) {
            p << "t_0. ! queue name=qi_0 max-size-buffers=8 leaky=downstream ! "
                 "nvv4l2decoder name=dec2_0 ! queue name=qm_0 ! mux.sink_0 ";
        } else {
            p << "t_0. ! queue ! fakesink sync=false ";
        }
        // Push branch.
        p << "t_0. ! queue name=qp_0 max-size-buffers=200 leaky=downstream ! "
             "h264parse name=pp_0 config-interval=-1 ! "
             "rtspclientsink name=push_0 latency=200 location=rtsp://mediamtx:8554/live_"
          << c0.id << " protocols=tcp ";
    } else if (solo_none) {
        // Record-only: no decode, no inference — parse + push only.
        std::string url = c0.url;
        if (c0.mtx_proxy) url = "rtsp://mediamtx:8554/proxy_" + c0.id;
        p << "rtspsrc name=src_0 location=" << url
          << " latency=200 protocols=tcp tcp-timeout=15000000 retry=3 ! ";
        p << (sources_[0]->codec == "h265" ? "rtph265depay name=depay_0 ! "
                                           : "rtph264depay name=depay_0 ! ");
        p << (sources_[0]->codec == "h265"
                  ? "h265parse name=pp_0 config-interval=-1 ! "
                  : "h264parse name=pp_0 config-interval=-1 ! ");
        p << "rtspclientsink name=push_0 latency=200 location=rtsp://mediamtx:8554/live_"
          << c0.id << " protocols=tcp ";
    } else {
        // --- Batched shape (N ≥ 1, no transcode) ---------------------------
        // Canvas: single member keeps its native dims (no letterbox);
        // multi-member groups share a fixed canvas and the probes
        // invert the letterbox per source.
        const bool solo_sub = solo && use_deepstream_ &&
                              !c0.substream_url.empty();
        if (solo_sub && sources_[0]->sub_w > 0 && sources_[0]->sub_h > 0) {
            // Substream feeds the mux — canvas at substream size keeps
            // it aspect-exact with zero letterbox (and zero upscale).
            mux_w_ = sources_[0]->sub_w;
            mux_h_ = sources_[0]->sub_h;
        } else if (solo && !solo_sub && sources_[0]->probed_w > 0 &&
                   sources_[0]->probed_h > 0) {
            mux_w_ = sources_[0]->probed_w;
            mux_h_ = sources_[0]->probed_h;
        } else {
            mux_w_ = 1920;
            mux_h_ = 1080;
        }
        // NVENC live-proxy leg: tee the ALREADY-DECODED frames (zero
        // extra NVDEC) into a small H.264 stream MediaMTX serves at
        // lp_<cam>. The web grid plays this instead of the full
        // passthrough stream: WebRTC-clean H.264 (no B-frames, 1 s
        // IDR — instant joins, every browser), ~1.5 Mbps per tile
        // instead of the camera's full bitrate, and camera encode
        // quirks stop mattering for live view. Recordings and the
        // expanded view keep the untouched passthrough stream.
        auto proxy_leg = [&p](size_t idx, const std::string& cam_id,
                              int w, int h) {
            int pw = w > 0 ? w : 1280, ph = h > 0 ? h : 720;
            if (ph > 540) {
                pw = int(double(pw) * 540.0 / ph + 0.5);
                ph = 540;
            }
            pw &= ~1; ph &= ~1;
            p << "tp_" << idx << ". ! queue name=pq_" << idx
              << " max-size-buffers=4 leaky=downstream ! "
              << "nvvideoconvert name=pconv_" << idx << " compute-hw=1 ! "
              << "video/x-raw(memory:NVMM),format=NV12,width=" << pw
              << ",height=" << ph << " ! "
              << "nvv4l2h264enc name=penc_" << idx
              << " bitrate=1500000 insert-sps-pps=1 idrinterval=30"
                 " iframeinterval=30 ! "
              << "h264parse name=ppp_" << idx << " config-interval=-1 ! "
              << "rtspclientsink name=ppush_" << idx
              << " latency=200 location=rtsp://mediamtx:8554/lp_" << cam_id
              << " protocols=tcp ";
        };

        for (size_t i = 0; i < sources_.size(); i++) {
            auto& s = sources_[i];
            std::string url = s->cam.url;
            if (s->cam.mtx_proxy) url = "rtsp://mediamtx:8554/proxy_" + s->cam.id;
            const char* depay = s->codec == "h265" ? "rtph265depay" : "rtph264depay";
            const char* parse = s->codec == "h265" ? "h265parse" : "h264parse";
            const bool use_sub =
                use_deepstream_ && !s->cam.substream_url.empty();
            if (use_sub) {
                // Substream inference: the main stream never touches
                // the decoder — straight relay to MediaMTX (the qp
                // leaky queue keeps the push-health watchdog's
                // decoupling), while a second rtspsrc decodes the low
                // -res substream into the mux.
                p << "rtspsrc name=src_" << i << " location=" << url
                  << " latency=200 protocols=tcp tcp-timeout=15000000 retry=3 ! "
                  << depay << " name=depay_" << i << " ! "
                  << "queue name=qp_" << i
                  << " max-size-buffers=200 leaky=downstream ! "
                  << parse << " name=pp_" << i << " config-interval=-1 ! "
                  << "rtspclientsink name=push_" << i
                  << " latency=200 location=rtsp://mediamtx:8554/live_" << s->cam.id
                  << " protocols=tcp ";
                const char* sdepay =
                    s->sub_codec == "h265" ? "rtph265depay" : "rtph264depay";
                const char* sparse =
                    s->sub_codec == "h265" ? "h265parse" : "h264parse";
                p << "rtspsrc name=src_sub_" << i << " location="
                  << s->cam.substream_url
                  << " latency=200 protocols=tcp tcp-timeout=15000000 retry=3 ! "
                  << sdepay << " name=depay_sub_" << i << " ! "
                  << sparse << " name=parse_sub_" << i << " config-interval=1 ! "
                  << "queue name=qi_" << i
                  << " max-size-buffers=8 leaky=downstream ! "
                  << "nvv4l2decoder name=dec_" << i << " ! "
                  << "tee name=tp_" << i << " tp_" << i << ". ! "
                  << "queue name=qm_" << i << " max-size-buffers=4 leaky=downstream ! "
                  << "mux.sink_" << i << " ";
                proxy_leg(i, s->cam.id, s->sub_w, s->sub_h);
                continue;
            }
            p << "rtspsrc name=src_" << i << " location=" << url
              << " latency=200 protocols=tcp tcp-timeout=15000000 retry=3 ! "
              << depay << " name=depay_" << i << " ! "
              << parse << " name=parse_" << i << " config-interval=1 ! "
              << "tee name=t_" << i << " ";
            if (use_deepstream_) {
                // Inference leg — small leaky queue so a stalling mux
                // drops late frames here rather than backing up the push.
                p << "t_" << i << ". ! queue name=qi_" << i
                  << " max-size-buffers=8 leaky=downstream ! "
                  << "nvv4l2decoder name=dec_" << i << " ! "
                  << "tee name=tp_" << i << " tp_" << i << ". ! "
                  << "queue name=qm_" << i << " max-size-buffers=4 leaky=downstream ! "
                  << "mux.sink_" << i << " ";
                proxy_leg(i, s->cam.id, s->probed_w, s->probed_h);
            } else {
                // GPU-less dev fallback: record/push only, sink the arm.
                p << "t_" << i << ". ! queue ! fakesink sync=false ";
            }
            // Push leg — generous non-dropping-ish queue as before.
            p << "t_" << i << ". ! queue name=qp_" << i
              << " max-size-buffers=200 leaky=downstream ! "
              << parse << " name=pp_" << i << " config-interval=-1 ! "
              << "rtspclientsink name=push_" << i
              << " latency=200 location=rtsp://mediamtx:8554/live_" << s->cam.id
              << " protocols=tcp ";
        }
    }

    // Shared inference chain for batched/transcode-with-inference shapes.
    const bool wants_inference =
        use_deepstream_ && !solo_none;
    if (wants_inference) {
        // Per-group detector resolution: the planner guarantees all
        // members share a detector set, so member 0 speaks for the group.
        const auto& det = c0.enabled_detectors;
        auto detectorListed = [&](const char* kind) {
            if (det.empty()) return true;  // "all" convention
            for (const auto& v : det) if (v == kind) return true;
            return false;
        };
        const bool wants_anpr = use_anpr_ && detectorListed("anpr");
        const bool wants_face = use_face_id_ && detectorListed("face");

        // scrfd/platedet configs are RENDERED by the entrypoint into
        // /var/lib/fnvr/nvinfer/ — their operate-on-class-ids depend on
        // the active detector family's label space (COCO-80 vs RF-DETR's
        // 91-slot space, where person/vehicles sit at different ids).
        std::string anpr_chain, face_chain;
        if (wants_anpr) {
            anpr_chain =
                "nvinfer name=platedet config-file-path=/var/lib/fnvr/nvinfer/platedet.txt ! "
                "nvinfer name=plateocr config-file-path=/etc/fnvr/nvinfer/plateocr.txt ! ";
        }
        if (wants_face) {
            face_chain =
                "nvinfer name=scrfd  config-file-path=/var/lib/fnvr/nvinfer/scrfd.txt ! "
                "nvinfer name=embedder config-file-path=/etc/fnvr/nvinfer/adaface.txt ! ";
        }

        // Primary detector backend: in-process nvinfer (default) or
        // shared Triton via nvinferserver/gRPC — one engine copy for
        // the whole fleet, cross-worker scheduling in tritonserver.
        // Validated on GB10 2026-07-17 (no CUDA-IPC on iGPU; plain
        // gRPC transport).
        const char* backend_env = std::getenv("FNVR_INFER_BACKEND");
        const bool use_triton =
            backend_env && std::string(backend_env) == "triton";
        std::string pgie_str;
        if (use_triton) {
            pgie_str =
                "nvinferserver name=pgie config-file-path="
                "/etc/fnvr/nvinferserver/rfdetr_grpc.txt ! ";
        } else {
            pgie_str = "nvinfer name=pgie config-file-path=" +
                       infer_config_ + " ! ";
        }
        p << "nvstreammux name=mux batch-size=" << sources_.size()
          << " width=" << mux_w_ << " height=" << mux_h_
          << " live-source=1 batched-push-timeout=40000 enable-padding=1 ! "
          << pgie_str
          << "nvtracker name=tracker "
             "  ll-lib-file=/opt/nvidia/deepstream/deepstream/lib/libnvds_nvmultiobjecttracker.so "
             "  ll-config-file=/etc/fnvr/nvinfer/tracker_NvDCF.yml "
             "  tracker-width=960 tracker-height=544 ! "
          << anpr_chain << face_chain
          << "fakesink sync=false ";
        has_inference_ = true;
    }

    std::string desc = p.str();
    std::cerr << "group[" << group_id_ << "]: " << desc << "\n";

    GError* err = nullptr;
    GstElement* pipeline = gst_parse_launch(desc.c_str(), &err);
    if (!pipeline) {
        std::cerr << "gst_parse_launch: " << (err ? err->message : "unknown") << "\n";
        if (err) g_error_free(err);
        return nullptr;
    }

    // Force a fixed, small pipeline latency instead of the computed
    // max across branches. The push legs are live RELAYS — their
    // timing rides on RTP timestamps, not render pacing — but their
    // sync'd internals get configured with the pipeline-wide latency
    // budget. When that budget balloons (rtspclientsink's rtpbin
    // alone reports 2 s; the infer branch adds more) the push sink
    // queues overflow while sync-waiting and the leg trickles at
    // 1-2 fps of mid-GOP frames. Every real sink in this graph is
    // either sync=false (fakesink) or a relay, so a flat 500 ms is
    // both sufficient and safe.
    if (GST_IS_PIPELINE(pipeline)) {
        g_object_set(pipeline, "latency",
                     (guint64)(500 * GST_MSECOND), nullptr);
    }

    // Push-leg health probes: count encoded frames entering each
    // member chain (depay_i src) and frames reaching its MediaMTX
    // push sink (push_i sink). The push watchdog in main.cpp compares
    // the rates and self-heals when the relay falls persistently
    // behind — the degraded state is sticky once entered (observed
    // twice on the fleet) and invisible to the frame-flow watchdog,
    // which only sees the inference leg.
    for (size_t i = 0; i < sources_.size(); i++) {
        auto* sr = sources_[i].get();
        auto attach_counter = [&](const std::string& elem,
                                  const char* pad_name,
                                  std::atomic<std::uint64_t>* counter) {
            GstElement* e = gst_bin_get_by_name(GST_BIN(pipeline), elem.c_str());
            if (!e) return;
            GstPad* pad = gst_element_get_static_pad(e, pad_name);
            if (pad) {
                gst_pad_add_probe(
                    pad, GST_PAD_PROBE_TYPE_BUFFER,
                    [](GstPad*, GstPadProbeInfo*, gpointer u) -> GstPadProbeReturn {
                        static_cast<std::atomic<std::uint64_t>*>(u)->fetch_add(
                            1, std::memory_order_relaxed);
                        return GST_PAD_PROBE_OK;
                    },
                    counter, nullptr);
                gst_object_unref(pad);
            }
            gst_object_unref(e);
        };
        attach_counter("depay_" + std::to_string(i), "src", &sr->input_frames);
        // rtspclientsink's sink pads are request pads (sink_%u), so
        // count on the parser feeding it instead: pp_i.src pushes
        // synchronously into the sink, so its rate IS the sink's
        // consumption rate (the leaky qp_i upstream absorbs the
        // difference from the input side).
        attach_counter("pp_" + std::to_string(i), "src", &sr->push_frames);
    }

#if FNVR_HAS_DEEPSTREAM
    if (has_inference_) {
        // Rect-clamp probe on tracker.src. NvDCF emits PREDICTED rects
        // for objects leaving the frame — a vehicle exiting bottom of
        // frame keeps a rect whose top can sit BELOW the canvas. Any
        // downstream SGIE crop of such an object (or of a child object
        // mapped inside it, e.g. a plate) hands NvBufSurfTransform an
        // off-surface src rect → error -3 → group-fatal. Clamp every
        // object rect into the canvas once, here, for all consumers;
        // fully-off-canvas objects shrink to a degenerate size the
        // SGIE min-size gates then skip.
        {
            GstElement* trk = gst_bin_get_by_name(GST_BIN(pipeline), "tracker");
            if (trk) {
                GstPad* src = gst_element_get_static_pad(trk, "src");
                if (src) {
                    // Canvas dims via heap-allocated pair (probe outlives
                    // this scope; leaked once per pipeline build).
                    auto* dims = new std::pair<int, int>(mux_w_, mux_h_);
                    gst_pad_add_probe(
                        src, GST_PAD_PROBE_TYPE_BUFFER,
                        [](GstPad*, GstPadProbeInfo* info,
                           gpointer u) -> GstPadProbeReturn {
                            auto* d = static_cast<std::pair<int, int>*>(u);
                            const float W = float(d->first);
                            const float H = float(d->second);
                            GstBuffer* buf = GST_PAD_PROBE_INFO_BUFFER(info);
                            NvDsBatchMeta* batch =
                                gst_buffer_get_nvds_batch_meta(buf);
                            if (!batch) return GST_PAD_PROBE_OK;
                            for (NvDsMetaList* fl = batch->frame_meta_list; fl;
                                 fl = fl->next) {
                                auto* frame =
                                    static_cast<NvDsFrameMeta*>(fl->data);
                                for (NvDsMetaList* ol = frame->obj_meta_list;
                                     ol; ol = ol->next) {
                                    auto* obj =
                                        static_cast<NvDsObjectMeta*>(ol->data);
                                    auto& r = obj->rect_params;
                                    float x1 = std::max(0.f, float(r.left));
                                    float y1 = std::max(0.f, float(r.top));
                                    float x2 = std::min(W, float(r.left) +
                                                               float(r.width));
                                    float y2 = std::min(H, float(r.top) +
                                                               float(r.height));
                                    if (x2 - x1 < 1.f) x2 = std::min(W, x1 + 1.f);
                                    if (y2 - y1 < 1.f) y2 = std::min(H, y1 + 1.f);
                                    x1 = std::min(x1, W - 1.f);
                                    y1 = std::min(y1, H - 1.f);
                                    r.left = x1;
                                    r.top = y1;
                                    r.width = x2 - x1;
                                    r.height = y2 - y1;
                                }
                            }
                            return GST_PAD_PROBE_OK;
                        },
                        dims, nullptr);
                    gst_object_unref(src);
                    std::cerr << "group[" << group_id_
                              << "]: rect-clamp probe attached on tracker.src\n";
                }
                gst_object_unref(trk);
            }
        }

        // Preview-thumbnail probe on pgie.src — batch-aware, per-source
        // 1 fps JPEG rings tapped from the in-flight NVMM surfaces.
        {
            GstElement* pgie_elem = gst_bin_get_by_name(GST_BIN(pipeline), "pgie");
            if (pgie_elem) {
                GstPad* src = gst_element_get_static_pad(pgie_elem, "src");
                if (src) {
                    std::vector<std::string> ids;
                    for (const auto& s : sources_) ids.push_back(s->cam.id);
                    auto* pctx = fnvr::preview_probe_ctx_new(
                        ids, "/var/lib/fnvr/live");
                    if (pctx) {
                        gst_pad_add_probe(src, GST_PAD_PROBE_TYPE_BUFFER,
                                          &fnvr::PreviewSnapshotProbe, pctx, nullptr);
                        std::cerr << "group[" << group_id_
                                  << "]: preview probe attached on pgie.src\n";
                    }
                    gst_object_unref(src);
                }
                gst_object_unref(pgie_elem);
            }
        }

        // Detection probe on the LAST nvinfer in the active chain.
        if (nats_) {
            GstElement* attach = gst_bin_get_by_name(GST_BIN(pipeline), "embedder");
            const char* attach_name = "embedder";
            if (!attach) { attach = gst_bin_get_by_name(GST_BIN(pipeline), "plateocr"); attach_name = "plateocr"; }
            if (!attach) { attach = gst_bin_get_by_name(GST_BIN(pipeline), "tracker"); attach_name = "tracker"; }
            if (!attach) { attach = gst_bin_get_by_name(GST_BIN(pipeline), "pgie"); attach_name = "pgie"; }
            if (attach) {
                GstPad* src = gst_element_get_static_pad(attach, "src");
                if (src) {
                    // Leaked on purpose: lifetime matches the process.
                    auto* ctx = new ProbeCtx{};
                    ctx->group_id = group_id_;
                    ctx->nats     = nats_;
                    ctx->canvas_w = mux_w_;
                    ctx->canvas_h = mux_h_;
                    for (auto& s : sources_) {
                        SourceView sv;
                        sv.camera_id     = s->cam.id;
                        sv.muted_classes = s->cam.muted_classes;
                        sv.frames        = &s->frames;
                        ctx->sources.push_back(std::move(sv));
                    }
                    if (use_face_id_) {
                        ctx->thumbs_dir = "/var/lib/fnvr/thumbs/faces";
                        std::error_code _ec;
                        fs::create_directories(ctx->thumbs_dir, _ec);
                    }
                    {
                        ctx->thumbs_dir_objects = "/var/lib/fnvr/thumbs/objects";
                        std::error_code _ec;
                        fs::create_directories(ctx->thumbs_dir_objects, _ec);
                    }
                    gst_pad_add_probe(src, GST_PAD_PROBE_TYPE_BUFFER,
                                      &InferSrcProbe, ctx, nullptr);
                    std::cerr << "group[" << group_id_
                              << "]: detection probe attached on "
                              << attach_name << ".src\n";
                    gst_object_unref(src);
                }
                gst_object_unref(attach);
            } else {
                std::cerr << "group[" << group_id_
                          << "]: FAILED to attach detection probe\n";
            }
        }
    }
#endif

    return pipeline;
}

bool GroupPipeline::Start() {
    pipeline_ = BuildPipeline();
    if (!pipeline_) return false;
    GstBus* bus = gst_element_get_bus(pipeline_);
    bus_watch_id_ = gst_bus_add_watch(bus, &GroupPipeline::BusHandler, this);
    gst_object_unref(bus);

    GstStateChangeReturn ret = gst_element_set_state(pipeline_, GST_STATE_PLAYING);
    if (ret == GST_STATE_CHANGE_FAILURE) {
        std::cerr << "group[" << group_id_ << "]: failed to set PLAYING\n";
        Stop();
        return false;
    }
    return true;
}

void GroupPipeline::Stop() {
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

// ---------------------------------------------------------------------------
// Retro-analytics replay: run ONE recording file through the same
// detection stack at max speed, publishing detections with HISTORICAL
// timestamps on fnvr.events.retro_detection.<cam>. Invoked by the
// retro runner (tools/retro/) when the GPU is idle — event-processor
// stores these rows without evaluating alarm/notification rules.
// ---------------------------------------------------------------------------
int RunReplayFile(const std::string& camera_id, const std::string& file,
                  std::int64_t base_epoch_ms, bool use_anpr, bool use_face,
                  const std::string& infer_config, NatsPublisher* nats) {
#if !FNVR_HAS_DEEPSTREAM
    (void)camera_id; (void)file; (void)base_epoch_ms; (void)use_anpr;
    (void)use_face; (void)infer_config; (void)nats;
    std::cerr << "replay: built without DeepStream\n";
    return 2;
#else
    std::ostringstream p;
    std::string anpr_chain, face_chain;
    if (use_anpr) {
        anpr_chain =
            "nvinfer name=platedet config-file-path=/var/lib/fnvr/nvinfer/platedet.txt ! "
            "nvinfer name=plateocr config-file-path=/etc/fnvr/nvinfer/plateocr.txt ! ";
    }
    if (use_face) {
        face_chain =
            "nvinfer name=scrfd  config-file-path=/var/lib/fnvr/nvinfer/scrfd.txt ! "
            "nvinfer name=embedder config-file-path=/etc/fnvr/nvinfer/adaface.txt ! ";
    }
    p << "filesrc location=" << file << " ! qtdemux ! parsebin ! "
      << "nvv4l2decoder ! queue max-size-buffers=8 ! mux.sink_0 "
      << "nvstreammux name=mux batch-size=1 width=1920 height=1080 "
      << "live-source=0 batched-push-timeout=40000 enable-padding=1 ! "
      << "nvinfer name=pgie config-file-path=" << infer_config << " ! "
      << "nvtracker name=tracker "
         "  ll-lib-file=/opt/nvidia/deepstream/deepstream/lib/libnvds_nvmultiobjecttracker.so "
         "  ll-config-file=/etc/fnvr/nvinfer/tracker_NvDCF.yml "
         "  tracker-width=960 tracker-height=544 ! "
      << anpr_chain << face_chain << "fakesink sync=false";

    GError* err = nullptr;
    GstElement* pipeline = gst_parse_launch(p.str().c_str(), &err);
    if (!pipeline) {
        std::cerr << "replay: parse failed: "
                  << (err ? err->message : "?") << "\n";
        if (err) g_error_free(err);
        return 2;
    }

    // Same rect-clamp guard as live (tracker-predicted off-canvas
    // rects are group-fatal for SGIE crops).
    if (GstElement* trk = gst_bin_get_by_name(GST_BIN(pipeline), "tracker")) {
        if (GstPad* src = gst_element_get_static_pad(trk, "src")) {
            auto* dims = new std::pair<int, int>(1920, 1080);
            gst_pad_add_probe(
                src, GST_PAD_PROBE_TYPE_BUFFER,
                [](GstPad*, GstPadProbeInfo* info,
                   gpointer u) -> GstPadProbeReturn {
                    auto* d = static_cast<std::pair<int, int>*>(u);
                    const float W = float(d->first), H = float(d->second);
                    GstBuffer* buf = GST_PAD_PROBE_INFO_BUFFER(info);
                    NvDsBatchMeta* batch = gst_buffer_get_nvds_batch_meta(buf);
                    if (!batch) return GST_PAD_PROBE_OK;
                    for (NvDsMetaList* fl = batch->frame_meta_list; fl;
                         fl = fl->next) {
                        auto* frame = static_cast<NvDsFrameMeta*>(fl->data);
                        for (NvDsMetaList* ol = frame->obj_meta_list; ol;
                             ol = ol->next) {
                            auto* obj = static_cast<NvDsObjectMeta*>(ol->data);
                            auto& r = obj->rect_params;
                            float x1 = std::max(0.f, float(r.left));
                            float y1 = std::max(0.f, float(r.top));
                            float x2 = std::min(W, float(r.left) + float(r.width));
                            float y2 = std::min(H, float(r.top) + float(r.height));
                            if (x2 - x1 < 1.f) x2 = std::min(W, x1 + 1.f);
                            if (y2 - y1 < 1.f) y2 = std::min(H, y1 + 1.f);
                            x1 = std::min(x1, W - 1.f);
                            y1 = std::min(y1, H - 1.f);
                            r.left = x1; r.top = y1;
                            r.width = x2 - x1; r.height = y2 - y1;
                        }
                    }
                    return GST_PAD_PROBE_OK;
                },
                dims, nullptr);
            gst_object_unref(src);
        }
        gst_object_unref(trk);
    }

    // Detection probe on the last element of the active chain.
    GstElement* attach = gst_bin_get_by_name(GST_BIN(pipeline), "embedder");
    if (!attach) attach = gst_bin_get_by_name(GST_BIN(pipeline), "plateocr");
    if (!attach) attach = gst_bin_get_by_name(GST_BIN(pipeline), "tracker");
    if (attach) {
        if (GstPad* src = gst_element_get_static_pad(attach, "src")) {
            auto* ctx = new ProbeCtx{};
            ctx->group_id = "replay-" + camera_id;
            ctx->nats = nats;
            ctx->canvas_w = 1920;
            ctx->canvas_h = 1080;
            ctx->replay_base_epoch_ms = base_epoch_ms;
            ctx->subject_prefix = "fnvr.events.retro_detection.";
            SourceView sv;
            sv.camera_id = camera_id;
            ctx->sources.push_back(std::move(sv));
            if (use_face) {
                ctx->thumbs_dir = "/var/lib/fnvr/thumbs/faces";
                std::error_code _ec;
                fs::create_directories(ctx->thumbs_dir, _ec);
            }
            ctx->thumbs_dir_objects = "/var/lib/fnvr/thumbs/objects";
            std::error_code ec2;
            fs::create_directories(ctx->thumbs_dir_objects, ec2);
            gst_pad_add_probe(src, GST_PAD_PROBE_TYPE_BUFFER, &InferSrcProbe,
                              ctx, nullptr);
            gst_object_unref(src);
        }
        gst_object_unref(attach);
    }

    gst_element_set_state(pipeline, GST_STATE_PLAYING);
    GstBus* bus = gst_element_get_bus(pipeline);
    GstMessage* msg = gst_bus_timed_pop_filtered(
        bus, GST_CLOCK_TIME_NONE,
        GstMessageType(GST_MESSAGE_EOS | GST_MESSAGE_ERROR));
    int rc = 0;
    if (msg && GST_MESSAGE_TYPE(msg) == GST_MESSAGE_ERROR) {
        GError* e = nullptr; gchar* dbg = nullptr;
        gst_message_parse_error(msg, &e, &dbg);
        std::cerr << "replay[" << camera_id << "]: "
                  << (e ? e->message : "?") << "\n";
        if (e) g_error_free(e);
        g_free(dbg);
        rc = 1;
    }
    if (msg) gst_message_unref(msg);
    gst_object_unref(bus);
    gst_element_set_state(pipeline, GST_STATE_NULL);
    gst_object_unref(pipeline);
    return rc;
#endif
}

}  // namespace fnvr

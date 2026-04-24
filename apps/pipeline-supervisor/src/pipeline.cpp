#include "pipeline.h"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <random>
#include <sstream>
#include <utility>
#include <vector>

#include "face_crop_jpeg.h"
#include "object_phash.h"
#include "rtsp_probe.h"
#include "whep_server.h"

// DeepStream metadata. Only include when building for Jetson — these headers
// come from the deepstream-l4t base image.
#if __has_include(<gstnvdsmeta.h>)
#  define FNVR_HAS_DEEPSTREAM 1
#  include <gstnvdsmeta.h>
#  include <nvdsmeta.h>
// NvDsInferTensorMeta + NVDSINFER_TENSOR_OUTPUT_META for ArcFace
// output-tensor-meta extraction.
#  include <gstnvdsinfer.h>
// NvBufSurface + NvBufSurfTransform for in-probe face cropping:
// we VIC-convert the batched NVMM buffer into a small pitch-linear
// RGBA surface that libjpeg can read synchronously.
#  include <nvbufsurface.h>
#  include <nvbufsurftransform.h>
#endif

namespace fnvr {

namespace fs = std::filesystem;

SingleCameraPipeline::SingleCameraPipeline(CameraConfig cam, std::string recordings_dir,
                                           std::string infer_config, bool use_deepstream,
                                           bool use_anpr, bool use_face_id,
                                           NatsPublisher* nats)
    : cam_(std::move(cam)),
      recordings_dir_(std::move(recordings_dir)),
      infer_config_(std::move(infer_config)),
      use_deepstream_(use_deepstream),
      use_anpr_(use_anpr),
      use_face_id_(use_face_id),
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
    // Output directory for per-detection face JPEGs. Written as
    //   {thumbs_dir}/{event_id}.jpg
    // where event_id is the detection's short hex id (same one that
    // goes into the NATS payload and becomes the detection's event_id
    // in PG, so event-processor can rename to {pg_id}.jpg on INSERT).
    // Empty when face_id is off — saveFaceCrop short-circuits.
    std::string           thumbs_dir;
    // Output directory for per-detection OBJECT crop JPEGs (smaller;
    // 128x128 @ quality 75). Used by the Flags page to show what was
    // flagged. Empty = don't write (probe still computes phash).
    std::string           thumbs_dir_objects;
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
constexpr unsigned LPDNET_GIE_ID  = 2;
// SCRFD detector is gie-unique-id=4 in scrfd.txt (arcface is 5).
// Face obj_meta carry unique_component_id = SCRFD_GIE_ID.
constexpr unsigned SCRFD_GIE_ID   = 4;
// ArcFace's 512-d output lands on the face obj_meta's user meta as
// NVDSINFER_TENSOR_OUTPUT_META.
constexpr int      ARCFACE_DIM    = 512;
// Minimum face bbox in pixels — below this, ArcFace output is noise.
constexpr int      MIN_FACE_PX    = 30;

// base64_encode is a tiny stdlib-free encoder for the 2048-byte
// embedding blob (512 × float32). No padding variant because consumers
// always receive a fixed length.
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

// extractFaceEmbedding finds the ArcFace 512-d output on the face's
// user-meta list and base64-encodes it. Returns empty string if
// ArcFace hasn't run on this object (e.g., face_id disabled or the
// bbox was too small for the SGIE to bother). The output tensor has
// shape [1,512] — we copy the 512 float32s directly as little-endian
// IEEE754 bytes, matching the decoder in api-server/server/faces.go.
std::string extractFaceEmbedding(NvDsObjectMeta* obj) {
    for (NvDsMetaList* ul = obj->obj_user_meta_list; ul; ul = ul->next) {
        auto* um = static_cast<NvDsUserMeta*>(ul->data);
        if (!um) continue;
        if (um->base_meta.meta_type != NVDSINFER_TENSOR_OUTPUT_META) continue;
        auto* tm = static_cast<NvDsInferTensorMeta*>(um->user_meta_data);
        if (!tm || tm->num_output_layers == 0) continue;
        // For output-tensor-meta=1 SGIEs, the host copy lives on the
        // meta's own out_buf_ptrs_host array — layers_info[i].buffer
        // stays null in this mode. Ref: deepstream-infer-tensor-meta-test.
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

// saveFaceCrop extracts a crop of the current probe buffer's frame at
// the given normalised bbox, converts it to a small RGBA host buffer
// via VIC-accelerated NvBufSurfTransform (handles NV12 block-linear
// → RGBA pitch-linear + resize in one pass), JPEG-encodes and writes.
// Zero PTS drift — the buffer pixels are literally the ones the face
// detection was produced from. short_id becomes {thumbs_dir}/{id}.jpg;
// event-processor renames to {pg_id}.jpg after INSERT.
//
// 256x256 output — a cheap, face-sized canvas. Bbox aspect usually
// fits a square crop with the 1.4x padding we apply below; the tile
// UI is square anyway.
constexpr int CROP_OUT_W = 256;
constexpr int CROP_OUT_H = 256;

void saveFaceCrop(const ProbeCtx& ctx, GstBuffer* gst_buf,
                  NvDsFrameMeta* frame,
                  float nx, float ny, float nw, float nh,
                  const std::string& short_id) {
    if (ctx.thumbs_dir.empty() || !gst_buf || !frame) return;

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

    // Map the input surface. The NvBufSurface* is embedded in the
    // gst buffer's map.data.
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

    // Create a 1-frame pitch-linear RGBA destination we CAN CPU-map.
    // Jetson-correct: memType=NVBUF_MEM_SURFACE_ARRAY + PITCH layout.
    NvBufSurfaceCreateParams cp{};
    cp.gpuId        = in_surf->gpuId;
    cp.width        = guint(CROP_OUT_W);
    cp.height       = guint(CROP_OUT_H);
    cp.size         = 0;
    cp.isContiguous = true;
    cp.colorFormat  = NVBUF_COLOR_FORMAT_RGBA;
    cp.layout       = NVBUF_LAYOUT_PITCH;
    cp.memType      = NVBUF_MEM_SURFACE_ARRAY;
    NvBufSurface* dst = nullptr;
    if (NvBufSurfaceCreate(&dst, 1, &cp) != 0 || !dst) {
        gst_buffer_unmap(gst_buf, &map);
        return;
    }

    // VIC-accelerated source crop + colour-format + resize in one pass.
    NvBufSurfTransformRect src_rect {
        guint(py), guint(px), guint(pw_px), guint(ph_px)  // top, left, width, height
    };
    NvBufSurfTransformRect dst_rect {
        0, 0, guint(CROP_OUT_W), guint(CROP_OUT_H)
    };
    NvBufSurfTransformParams tp{};
    tp.src_rect = &src_rect;
    tp.dst_rect = &dst_rect;
    tp.transform_flag =
        NVBUFSURF_TRANSFORM_FILTER |
        NVBUFSURF_TRANSFORM_CROP_SRC |
        NVBUFSURF_TRANSFORM_CROP_DST;
    tp.transform_filter = NvBufSurfTransformInter_Default;

    // Narrow the source surface to just our batch slot (batch-size=1
    // per worker, but this keeps us robust against future batching).
    NvBufSurface tmp_in = *in_surf;
    tmp_in.surfaceList = &in_surf->surfaceList[frame->batch_id];
    tmp_in.numFilled   = 1;
    tmp_in.batchSize   = 1;

    if (NvBufSurfTransform(&tmp_in, dst, &tp) != NvBufSurfTransformError_Success) {
        NvBufSurfaceDestroy(dst);
        gst_buffer_unmap(gst_buf, &map);
        return;
    }

    // CPU-map the destination, sync, read pixels.
    if (NvBufSurfaceMap(dst, 0, 0, NVBUF_MAP_READ) != 0) {
        NvBufSurfaceDestroy(dst);
        gst_buffer_unmap(gst_buf, &map);
        return;
    }
    NvBufSurfaceSyncForCpu(dst, 0, 0);

    NvBufSurfaceParams& dp = dst->surfaceList[0];
    const auto* rgba = static_cast<const uint8_t*>(dp.mappedAddr.addr[0]);
    const int pitch = int(dp.planeParams.pitch[0]);

    std::string out_path = ctx.thumbs_dir + "/" + short_id + ".jpg";
    (void)encodeJpegRGBA(rgba, pitch, 0, 0, CROP_OUT_W, CROP_OUT_H, 85, out_path);

    NvBufSurfaceUnMap(dst, 0, 0);
    NvBufSurfaceDestroy(dst);
    gst_buffer_unmap(gst_buf, &map);
}

// Object-detection thumbnail dims. Smaller than face (objects matter
// less as thumbnails and we may write a lot more of them); 128×128
// JPEGs at quality 75 are ~2.5 KB.
constexpr int OBJ_CROP_OUT_W = 128;
constexpr int OBJ_CROP_OUT_H = 128;

// saveObjectCropAndHash mirrors saveFaceCrop but for non-face / non-
// plate detections. Returns the 64-bit average-hash of the bbox
// crop so the probe can attach it to the NATS payload. Writes a
// 128×128 JPEG thumbnail to {thumbs_dir_objects}/{short_id}.jpg.
//
// Returns 0 on any failure (missing thumbs dir, bbox too small, VIC
// transform error). Caller can still emit the detection without a
// phash — suppression just doesn't apply.
//
// No 1.4x padding (unlike faces): the bbox shape for objects is
// already larger + less aspect-sensitive, and padding would dilute
// the hash's signal from the object itself.
std::uint64_t saveObjectCropAndHash(const ProbeCtx& ctx, GstBuffer* gst_buf,
                                    NvDsFrameMeta* frame,
                                    float nx, float ny, float nw, float nh,
                                    const std::string& short_id) {
    if (!gst_buf || !frame) return 0;

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
        // Tiny detections — pHash on an 8x8 downsample of a sub-8x8
        // source is nonsense. Skip.
        gst_buffer_unmap(gst_buf, &map);
        return 0;
    }

    NvBufSurfaceCreateParams cp{};
    cp.gpuId        = in_surf->gpuId;
    cp.width        = guint(OBJ_CROP_OUT_W);
    cp.height       = guint(OBJ_CROP_OUT_H);
    cp.size         = 0;
    cp.isContiguous = true;
    cp.colorFormat  = NVBUF_COLOR_FORMAT_RGBA;
    cp.layout       = NVBUF_LAYOUT_PITCH;
    cp.memType      = NVBUF_MEM_SURFACE_ARRAY;
    NvBufSurface* dst = nullptr;
    if (NvBufSurfaceCreate(&dst, 1, &cp) != 0 || !dst) {
        gst_buffer_unmap(gst_buf, &map);
        return 0;
    }

    NvBufSurfTransformRect src_rect {
        guint(py), guint(px), guint(pw_px), guint(ph_px)
    };
    NvBufSurfTransformRect dst_rect {
        0, 0, guint(OBJ_CROP_OUT_W), guint(OBJ_CROP_OUT_H)
    };
    NvBufSurfTransformParams tp{};
    tp.src_rect = &src_rect;
    tp.dst_rect = &dst_rect;
    tp.transform_flag =
        NVBUFSURF_TRANSFORM_FILTER |
        NVBUFSURF_TRANSFORM_CROP_SRC |
        NVBUFSURF_TRANSFORM_CROP_DST;
    tp.transform_filter = NvBufSurfTransformInter_Default;

    NvBufSurface tmp_in = *in_surf;
    tmp_in.surfaceList = &in_surf->surfaceList[frame->batch_id];
    tmp_in.numFilled   = 1;
    tmp_in.batchSize   = 1;

    if (NvBufSurfTransform(&tmp_in, dst, &tp) != NvBufSurfTransformError_Success) {
        NvBufSurfaceDestroy(dst);
        gst_buffer_unmap(gst_buf, &map);
        return 0;
    }

    if (NvBufSurfaceMap(dst, 0, 0, NVBUF_MAP_READ) != 0) {
        NvBufSurfaceDestroy(dst);
        gst_buffer_unmap(gst_buf, &map);
        return 0;
    }
    NvBufSurfaceSyncForCpu(dst, 0, 0);

    NvBufSurfaceParams& dp = dst->surfaceList[0];
    const auto* rgba = static_cast<const std::uint8_t*>(dp.mappedAddr.addr[0]);
    const int pitch = int(dp.planeParams.pitch[0]);

    // Compute pHash from an 8×8 luma downsample of the 128×128 crop.
    std::uint8_t luma[64];
    downsampleToLuma8x8(rgba, OBJ_CROP_OUT_W, OBJ_CROP_OUT_H, pitch, luma);
    std::uint64_t hash = computeAverageHash64(luma);

    // Best-effort JPEG thumbnail. A failed write is fine — the flag
    // path can fall back to the live-preview ring. Gate on the
    // thumbs_dir_objects being configured; empty means "don't write".
    if (!ctx.thumbs_dir_objects.empty()) {
        std::string out_path = ctx.thumbs_dir_objects + "/" + short_id + ".jpg";
        (void)encodeJpegRGBA(rgba, pitch, 0, 0, OBJ_CROP_OUT_W, OBJ_CROP_OUT_H, 75, out_path);
    }

    NvBufSurfaceUnMap(dst, 0, 0);
    NvBufSurfaceDestroy(dst);
    gst_buffer_unmap(gst_buf, &map);
    return hash;
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
            const bool is_face  = (obj->unique_component_id == SCRFD_GIE_ID);
            const char* label = is_plate
                ? "plate"
                : is_face
                    ? "face"
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
            // Face branch: drop tiny faces (below MIN_FACE_PX on any
            // axis — ArcFace output on 10×10 px crops is noise). Pull
            // the 512-d embedding from tensor-meta; if ArcFace didn't
            // run (SGIE off, or the stage errored), skip the publish.
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
            // Plate inherits its vehicle's track_id so the rules
            // engine can correlate plate ↔ car without extra state.
            // Faces get their own SCRFD track_id (no parent).
            const uint64_t track_id = (is_plate && obj->parent)
                ? obj->parent->object_id
                : obj->object_id;

            // Compute the detection id once — it doubles as the face
            // thumbnail filename so the event-processor can rename
            // from {event_id}.jpg to {pg_id}.jpg after INSERT.
            const std::string det_id = short_id();
            if (is_face) {
                saveFaceCrop(*ctx, buf, frame, x, y, w, h, det_id);
            }

            // Object pHash + thumbnail. Only for plain object
            // detections (not face / plate — those have their own
            // matching paths). Zero cost when the crop fails.
            std::uint64_t obj_phash = 0;
            if (!is_face && !is_plate) {
                obj_phash = saveObjectCropAndHash(*ctx, buf, frame, x, y, w, h, det_id);
            }

            std::ostringstream js;
            js << "{"
               << "\"id\":\""         << det_id               << "\","
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
            } else if (is_face) {
                js << ",\"attributes\":{"
                   << "\"embedding\":\""     << embedding_b64       << "\""
                   << "}";
            } else if (obj_phash != 0) {
                js << ",\"attributes\":{"
                   << "\"phash\":\""         << uint64ToHex16(obj_phash) << "\""
                   << "}";
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

// FlowCounter probe. User_data is a pointer to the
// std::atomic<uint64_t> on the owning pipeline instance; the probe
// runs on every buffer that flows through the src pad and bumps
// the count. Sampled by main.cpp's flow_watchdog thread.
GstPadProbeReturn FlowCounterProbe(GstPad*, GstPadProbeInfo*, gpointer user) {
    auto* counter = static_cast<std::atomic<std::uint64_t>*>(user);
    counter->fetch_add(1, std::memory_order_relaxed);
    return GST_PAD_PROBE_OK;
}

void AttachFlowCounter(GstElement* pipeline, const char* element_name,
                       std::atomic<std::uint64_t>* counter) {
    GstElement* el = gst_bin_get_by_name(GST_BIN(pipeline), element_name);
    if (!el) return;
    GstPad* src = gst_element_get_static_pad(el, "src");
    if (src) {
        gst_pad_add_probe(src, GST_PAD_PROBE_TYPE_BUFFER,
                          &FlowCounterProbe, counter, nullptr);
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

        // Take the transcode path whenever we need to rotate the stream
        // or the source codec isn't H.264 — both require decode + NVENC.
        // Rotation via nvvideoconvert flip-method operates on decoded
        // NVMM surfaces, so H.264 passthrough is incompatible with any
        // non-zero rotation.
        const bool needs_transcode = (probe.codec == "h265") || (cam_.rotation != 0);
        // GStreamer nvvideoconvert flip-method mapping:
        //   0 = none, 1 = CCW 90°, 2 = 180°, 3 = CW 90°, 4/5 = flips
        // Our camera rotation is clockwise degrees; translate.
        int flip_method = 0;
        switch (cam_.rotation) {
            case 90:  flip_method = 3; break;
            case 180: flip_method = 2; break;
            case 270: flip_method = 1; break;
            default:  flip_method = 0; break;
        }
        const bool rotate_swaps_axes = (cam_.rotation == 90 || cam_.rotation == 270);

        if (needs_transcode) {
            // Compute aspect-preserving target. If we know source size,
            // fit to max(1080) height; otherwise fall back to 1920x1080.
            int src_w = probe.width;
            int src_h = probe.height;
            // After rotation the visible dims swap, so the encoder caps
            // must describe the post-rotation frame.
            if (rotate_swaps_axes) std::swap(src_w, src_h);
            int tw = 1920, th = 1080;
            if (src_w > 0 && src_h > 0) {
                th = std::min(1080, src_h);
                // width scaled, rounded to even (H.264 4:2:0 needs even).
                tw = static_cast<int>(
                    static_cast<double>(th) * src_w / src_h + 0.5);
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
                      << "]: recording target=" << tw << "x" << th
                      << " rotation=" << cam_.rotation << "\n";

            // tcp-timeout=15s + retry=3 so a hung RTSP SETUP bails instead of
// blocking a worker forever (observed: Reolink firmware hang where
// TCP/554 accepts connects but SETUP never completes, starving the
// whole worker). On timeout, rtspsrc posts an error message — our
// bus watch flips faulted_ and main.cpp exits, letting the
// supervisor respawn with its backoff.
p << "rtspsrc location=" << url
  << " latency=200 protocols=tcp tcp-timeout=15000000 retry=3"
  << " name=src ! ";
            if (probe.codec == "h265") {
                p << "rtph265depay ! h265parse config-interval=1 ! "
                     "video/x-h265,stream-format=byte-stream,alignment=au ! ";
            } else {
                p << "rtph264depay ! h264parse config-interval=1 ! ";
            }
            // Re-mux source → H.264 via NVDEC+NVENC so the rest of the
            // pipeline only has to handle one codec path. Rotation (if
            // any) is applied on the decoded NVMM surface before caps
            // negotiation so the encoder sees the post-rotation dims.
            p << "nvv4l2decoder ! "
                 "nvvideoconvert flip-method=" << flip_method << " ! "
                 "video/x-raw(memory:NVMM),format=NV12,width=" << tw
                 << ",height=" << th << " ! "
                 "nvv4l2h264enc insert-sps-pps=1 idrinterval=30 iframeinterval=30 ! "
                 "h264parse config-interval=1 ! ";
            rec_width_ = tw;
            rec_height_ = th;
        } else {
            // Source is already H.264 and no rotation requested — pass
            // through the parsed elementary stream; downstream infers
            // dims from the caps. Record at source resolution.
            // tcp-timeout=15s + retry=3 so a hung RTSP SETUP bails instead of
// blocking a worker forever (observed: Reolink firmware hang where
// TCP/554 accepts connects but SETUP never completes, starving the
// whole worker). On timeout, rtspsrc posts an error message — our
// bus watch flips faulted_ and main.cpp exits, letting the
// supervisor respawn with its backoff.
p << "rtspsrc location=" << url
  << " latency=200 protocols=tcp tcp-timeout=15000000 retry=3"
  << " name=src ! "
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
    // SCRFD (face detect, gie-unique-id=4) + ArcFace (embed, id=5).
    // Runs after ANPR so a single frame's nvinfer chain is:
    //   pgie(1) → tracker → lpdnet(2) → lprnet(3) → scrfd(4) → arcface(5)
    // ArcFace surfaces its 512-d output via tensor-meta; the probe
    // base64-encodes it into attributes.embedding.
    std::string face_chain;
    if (use_face_id_) {
        face_chain =
            "nvinfer name=scrfd  config-file-path=/etc/fnvr/nvinfer/scrfd.txt ! "
            "nvinfer name=arcface config-file-path=/etc/fnvr/nvinfer/arcface.txt ! ";
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
          << face_chain
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
          << face_chain
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

    // (Face-crop branch removed — thumbnails now come from the probe
    // directly via NvBufSurfTransform on the inference buffer.)

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
        // Attach the detection probe to the LAST nvinfer in the
        // active chain. SGIE-produced obj_meta + user_meta only
        // appears on buffers downstream of the SGIE, so a probe on
        // e.g. tracker.src never sees face or plate objects.
        GstElement* attach = gst_bin_get_by_name(GST_BIN(pipeline), "arcface");
        if (!attach) attach = gst_bin_get_by_name(GST_BIN(pipeline), "lprnet");
        if (!attach) attach = gst_bin_get_by_name(GST_BIN(pipeline), "tracker");
        if (!attach) attach = gst_bin_get_by_name(GST_BIN(pipeline), "pgie");
        if (attach) {
            GstPad* src = gst_element_get_static_pad(attach, "src");
            if (src) {
                // Leaked on purpose: lifetime matches the pipeline, cleaned up
                // when the process exits. Fine for M2, tighten when we have
                // multi-pipeline lifecycle.
                auto* ctx = new ProbeCtx{cam_.id, nats_, cam_.muted_classes};
                // When face_id is on the probe also writes a JPEG
                // crop of each face using NvBufSurfTransform on the
                // same NVMM buffer the detection came from — zero
                // temporal drift. Empty thumbs_dir disables crop
                // writes without branching the probe.
                if (use_face_id_) {
                    ctx->thumbs_dir = "/var/lib/fnvr/thumbs/faces";
                    std::error_code _ec;
                    std::filesystem::create_directories(ctx->thumbs_dir, _ec);
                }
                // Object detections always get a small thumbnail +
                // pHash, independent of face_id. The Flags page
                // needs the thumbnail so the operator can see what
                // they're flagging.
                {
                    ctx->thumbs_dir_objects = "/var/lib/fnvr/thumbs/objects";
                    std::error_code _ec;
                    std::filesystem::create_directories(ctx->thumbs_dir_objects, _ec);
                }
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

    // Data-flow counter on the record-parse src pad. Bumped for every
    // encoded frame that reaches the recording mux. main.cpp's
    // flow_watchdog samples BuffersPassed() every 5 s and hard-exits
    // the worker if it doesn't advance for 20 s while Playing() is
    // true. Catches silent stalls (NvMedia wedge, thread deadlock)
    // that don't fire a bus ERROR.
    AttachFlowCounter(pipeline, "recparse", &buffersPassed_);

    return pipeline;
}

// abortWorkerAfterFault publishes {"state":"failed"} with a bounded
// flush, then _exits the process so the parent supervisor respawns
// with a clean slate. Used for bus ERROR/EOS and (from main.cpp) the
// data-flow watchdog. We don't try to stop the pipeline gracefully —
// today's incident was a 37-minute zombie worker caused by
// gst_element_set_state(NULL) blocking forever on a wedged NvMedia
// element, which defeats the whole point of having a supervisor.
[[noreturn]] static void abortWorkerAfterFault(const std::string& cam_id,
                                               NatsPublisher* nats,
                                               const char* reason) {
    std::cerr << "worker[" << cam_id << "]: hard-exit rc=3 ("
              << reason << ")\n";
    if (nats) {
        const std::string subj = "fnvr.state.camera." + cam_id;
        const std::string payload =
            "{\"camera_id\":\"" + cam_id + "\",\"state\":\"failed\"}";
        // flush=true so the message reaches the broker before we
        // _exit. 2 s is plenty on a localhost bridge; if NATS itself
        // is the problem the publish returns quickly with an error
        // and we exit anyway.
        nats->Publish(subj, payload, /*flush=*/true);
    }
    std::_Exit(3);
}

gboolean SingleCameraPipeline::BusHandler(GstBus*, GstMessage* msg, gpointer user_data) {
    auto* self = static_cast<SingleCameraPipeline*>(user_data);
    switch (GST_MESSAGE_TYPE(msg)) {
        case GST_MESSAGE_EOS:
            std::cerr << "pipeline[" << self->cam_.id << "]: EOS\n";
            self->faulted_.store(true);
            abortWorkerAfterFault(self->cam_.id, self->nats_, "EOS");
        case GST_MESSAGE_ERROR: {
            GError* err = nullptr;
            gchar* dbg = nullptr;
            gst_message_parse_error(msg, &err, &dbg);
            std::string msg_str = err ? err->message : "?";
            std::cerr << "pipeline[" << self->cam_.id << "] error: "
                      << msg_str << "\n";
            if (err) g_error_free(err);
            g_free(dbg);
            self->faulted_.store(true);
            // Do NOT gst_element_set_state(NULL) here — that blocks
            // indefinitely when a downstream element is wedged inside
            // NvMedia (the failure mode we're recovering from).
            // Hard-exit and let the supervisor respawn.
            abortWorkerAfterFault(self->cam_.id, self->nats_, "bus error");
        }
        case GST_MESSAGE_STATE_CHANGED: {
            if (GST_MESSAGE_SRC(msg) == GST_OBJECT(self->pipeline_)) {
                GstState oldS, newS;
                gst_message_parse_state_changed(msg, &oldS, &newS, nullptr);
                if (newS == GST_STATE_PLAYING) {
                    self->playing_.store(true);
                    if (self->nats_) {
                        // Last-value stream on api-server side — see state.go.
                        std::string subj = "fnvr.state.camera." + self->cam_.id;
                        std::string payload = "{\"camera_id\":\"" + self->cam_.id + "\",\"state\":\"running\"}";
                        self->nats_->Publish(subj, payload, /*flush=*/true);
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

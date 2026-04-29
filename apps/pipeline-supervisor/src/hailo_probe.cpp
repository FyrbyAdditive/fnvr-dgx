#include "hailo_probe.h"
#include "hailo_inference.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <mutex>
#include <string>
#include <vector>

#if __has_include(<nvbufsurface.h>)
#include <nvbufsurface.h>
#include <nvbufsurftransform.h>
#include <gstnvdsmeta.h>
#define FNVR_HAS_DEEPSTREAM 1
#else
#define FNVR_HAS_DEEPSTREAM 0
#endif

namespace fnvr {

// COCO 80-class label table. Matches the classes the yolov11l HEF was
// trained on (standard COCO). Indices align with class_id returned by
// HailoInference::Infer.
static const std::array<const char*, 80> kCocoLabels = {
    "person","bicycle","car","motorcycle","airplane","bus","train","truck",
    "boat","traffic light","fire hydrant","stop sign","parking meter","bench",
    "bird","cat","dog","horse","sheep","cow","elephant","bear","zebra",
    "giraffe","backpack","umbrella","handbag","tie","suitcase","frisbee",
    "skis","snowboard","sports ball","kite","baseball bat","baseball glove",
    "skateboard","surfboard","tennis racket","bottle","wine glass","cup",
    "fork","knife","spoon","bowl","banana","apple","sandwich","orange",
    "broccoli","carrot","hot dog","pizza","donut","cake","chair","couch",
    "potted plant","bed","dining table","toilet","tv","laptop","mouse",
    "remote","keyboard","cell phone","microwave","oven","toaster","sink",
    "refrigerator","book","clock","vase","scissors","teddy bear","hair drier",
    "toothbrush"
};

struct HailoProbeCtx {
    std::string hef_path;
    int         source_width;
    int         source_height;

    // Thread-local scratch isn't right here (the probe runs on the streaming
    // thread, one per camera), but we're already serialised via
    // HailoInference::mu_ on inference; we keep a member-owned scratch to
    // avoid per-call alloc.
    std::vector<uint8_t> rgb_scratch;  // kInputWidth*kInputHeight*3

    // Reused NvBufSurface destination for the NV12→RGBA transform. Allocated
    // lazily on first probe call because the gpuId isn't known until we see
    // a real input surface.
#if FNVR_HAS_DEEPSTREAM
    NvBufSurface* dst_surf = nullptr;
#endif

    std::mutex ctx_mu;  // guards dst_surf create/destroy

    // The InferSrcProbe elsewhere uses "unique_component_id == 0" as the
    // "primary detector" marker (nvinfer pgie has gie-unique-id=1 but that
    // varies by config). We pick a value that matches the pgie obj_meta
    // the existing probe already expects — verified against
    // deploy/config/nvinfer/yolo11.txt which sets gie-unique-id=1.
    static constexpr int kPgieUniqueId = 1;
};

HailoProbeCtx* hailo_probe_ctx_new(const char* hef_path,
                                   int source_width,
                                   int source_height) {
    auto* ctx = new HailoProbeCtx;
    ctx->hef_path      = hef_path ? hef_path : "";
    ctx->source_width  = source_width  > 0 ? source_width  : 1920;
    ctx->source_height = source_height > 0 ? source_height : 1080;
    ctx->rgb_scratch.resize(HailoInference::kInputWidth *
                            HailoInference::kInputHeight * 3);

    // Eagerly prime the singleton so configuration errors fail loudly here
    // (in the worker startup path) rather than on the first frame.
    try {
        (void)HailoInference::Instance(ctx->hef_path);
    } catch (const std::exception& e) {
        std::cerr << "hailo_probe: failed to bring up HailoInference: "
                  << e.what() << "\n";
        delete ctx;
        return nullptr;
    }
    return ctx;
}

void hailo_probe_ctx_free(HailoProbeCtx* ctx) {
    if (!ctx) return;
#if FNVR_HAS_DEEPSTREAM
    if (ctx->dst_surf) {
        NvBufSurfaceDestroy(ctx->dst_surf);
        ctx->dst_surf = nullptr;
    }
#endif
    delete ctx;
}

#if !FNVR_HAS_DEEPSTREAM

GstPadProbeReturn HailoInferProbe(GstPad*, GstPadProbeInfo*, gpointer) {
    // No DeepStream build → no NvBufSurface access → no Hailo backend.
    // Should never be attached in this configuration; just pass.
    return GST_PAD_PROBE_OK;
}

#else

namespace {

// Letterbox source rect into 640x640: find the scale that fits source into
// the 640x640 box while preserving aspect, then centre it. This matches the
// training-time preprocessing for yolov11 and keeps bbox coordinates sane
// after the later reverse-map.
struct LetterboxMap {
    int dst_offset_x;
    int dst_offset_y;
    int dst_content_w;
    int dst_content_h;
};

LetterboxMap computeLetterbox(int src_w, int src_h) {
    float sx = float(HailoInference::kInputWidth)  / float(src_w);
    float sy = float(HailoInference::kInputHeight) / float(src_h);
    float s  = std::min(sx, sy);
    int dw = int(src_w * s);
    int dh = int(src_h * s);
    int ox = (HailoInference::kInputWidth  - dw) / 2;
    int oy = (HailoInference::kInputHeight - dh) / 2;
    return {ox, oy, dw, dh};
}

bool ensureDstSurface(HailoProbeCtx* ctx, NvBufSurface* in_surf) {
    if (ctx->dst_surf) return true;

    NvBufSurfaceAllocateParams ap{};
    ap.params.gpuId        = in_surf->gpuId;
    ap.params.width        = HailoInference::kInputWidth;
    ap.params.height       = HailoInference::kInputHeight;
    ap.params.size         = 0;
    ap.params.isContiguous = true;
    ap.params.colorFormat  = NVBUF_COLOR_FORMAT_RGBA;
    ap.params.layout       = NVBUF_LAYOUT_PITCH;
    ap.params.memType      = NVBUF_MEM_SURFACE_ARRAY;
    ap.memtag              = NvBufSurfaceTag_VIDEO_CONVERT;
    if (NvBufSurfaceAllocate(&ctx->dst_surf, 1, &ap) != 0 || !ctx->dst_surf) {
        std::cerr << "hailo_probe: NvBufSurfaceAllocate failed\n";
        ctx->dst_surf = nullptr;
        return false;
    }
    ctx->dst_surf->numFilled = 1;
    return true;
}

// Transforms the frame's NVMM surface into the pre-allocated dst_surf as
// RGBA 640x640 letterboxed (black bars top/bottom or left/right), then
// copies RGB (alpha stripped) into ctx->rgb_scratch. Returns false on any
// failure (probe will skip inference for the frame).
bool prepareRgbScratch(HailoProbeCtx* ctx,
                       NvBufSurface* in_surf,
                       unsigned int batch_id,
                       const LetterboxMap& lb)
{
    if (batch_id >= in_surf->numFilled) return false;
    NvBufSurfaceParams& in_p = in_surf->surfaceList[batch_id];

    NvBufSurfTransformRect src_rect {
        0, 0, guint(in_p.width), guint(in_p.height)
    };
    NvBufSurfTransformRect dst_rect {
        guint(lb.dst_offset_y), guint(lb.dst_offset_x),
        guint(lb.dst_content_w), guint(lb.dst_content_h)
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
    tmp_in.surfaceList = &in_surf->surfaceList[batch_id];
    tmp_in.numFilled   = 1;
    tmp_in.batchSize   = 1;

    if (NvBufSurfTransform(&tmp_in, ctx->dst_surf, &tp)
        != NvBufSurfTransformError_Success) {
        std::cerr << "hailo_probe: NvBufSurfTransform failed\n";
        return false;
    }

    if (NvBufSurfaceMap(ctx->dst_surf, 0, 0, NVBUF_MAP_READ) != 0) {
        return false;
    }
    NvBufSurfaceSyncForCpu(ctx->dst_surf, 0, 0);

    const auto& dst_p = ctx->dst_surf->surfaceList[0];
    const uint8_t* rgba = static_cast<const uint8_t*>(dst_p.mappedAddr.addr[0]);
    const size_t pitch = dst_p.pitch;
    uint8_t* out = ctx->rgb_scratch.data();
    for (int y = 0; y < HailoInference::kInputHeight; ++y) {
        const uint8_t* src = rgba + size_t(y) * pitch;
        for (int x = 0; x < HailoInference::kInputWidth; ++x) {
            out[0] = src[0];
            out[1] = src[1];
            out[2] = src[2];
            out += 3;
            src += 4;
        }
    }
    NvBufSurfaceUnMap(ctx->dst_surf, 0, 0);
    return true;
}

// Walks the frame meta, adds an NvDsObjectMeta for each detection. Coords
// are in network space [0,1]; we invert the letterbox to put them in source
// pixel space which is what nvtracker + the existing InferSrcProbe expect.
void injectObjectMetas(NvDsBatchMeta* batch, NvDsFrameMeta* frame,
                       const std::vector<HailoDetection>& dets,
                       const LetterboxMap& lb,
                       int src_w, int src_h)
{
    // Inverse-letterbox: a network-space coord (nx, ny) maps to source pixels
    //   sx = (nx * 640 - lb.offset_x) * src_w / lb.content_w
    auto map_x = [&](float nx) {
        float px = nx * HailoInference::kInputWidth - lb.dst_offset_x;
        return px * float(src_w) / float(lb.dst_content_w);
    };
    auto map_y = [&](float ny) {
        float py = ny * HailoInference::kInputHeight - lb.dst_offset_y;
        return py * float(src_h) / float(lb.dst_content_h);
    };

    for (const auto& d : dets) {
        float x0 = map_x(d.x_min);
        float y0 = map_y(d.y_min);
        float x1 = map_x(d.x_max);
        float y1 = map_y(d.y_max);
        if (x0 < 0) x0 = 0;
        if (y0 < 0) y0 = 0;
        if (x1 > src_w) x1 = src_w;
        if (y1 > src_h) y1 = src_h;
        if (x1 - x0 < 1 || y1 - y0 < 1) continue;

        NvDsObjectMeta* obj = nvds_acquire_obj_meta_from_pool(batch);
        if (!obj) continue;

        obj->unique_component_id = HailoProbeCtx::kPgieUniqueId;
        obj->class_id            = d.class_id;
        obj->confidence          = d.confidence;
        obj->object_id           = UNTRACKED_OBJECT_ID;  // tracker fills in
        obj->tracker_confidence  = -0.1f;                // convention for "not tracked yet"

        // Detector bbox — nvtracker reads this one for its initial bbox. Without
        // it, the tracker treats the object as untracked garbage and drops it.
        obj->detector_bbox_info.org_bbox_coords.left   = x0;
        obj->detector_bbox_info.org_bbox_coords.top    = y0;
        obj->detector_bbox_info.org_bbox_coords.width  = x1 - x0;
        obj->detector_bbox_info.org_bbox_coords.height = y1 - y0;

        // rect_params is what OSD / overlay / our InferSrcProbe reads. Tracker
        // overwrites this on its output, so set it for the pgie->tracker hop.
        obj->rect_params.left   = x0;
        obj->rect_params.top    = y0;
        obj->rect_params.width  = x1 - x0;
        obj->rect_params.height = y1 - y0;
        obj->rect_params.border_width = 0;
        obj->rect_params.has_bg_color = 0;

        // obj_label must be a fixed-size char[] filled with the class name
        // so that the downstream probe's lookup works.
        const char* label = (d.class_id >= 0 &&
                             size_t(d.class_id) < kCocoLabels.size())
            ? kCocoLabels[d.class_id]
            : "object";
        std::snprintf(obj->obj_label, sizeof(obj->obj_label), "%s", label);

        nvds_add_obj_meta_to_frame(frame, obj, nullptr);
    }
}

} // namespace

GstPadProbeReturn HailoInferProbe(GstPad*, GstPadProbeInfo* info, gpointer user) {
    auto* ctx = static_cast<HailoProbeCtx*>(user);
    if (!ctx) return GST_PAD_PROBE_OK;

    GstBuffer* buf = gst_pad_probe_info_get_buffer(info);
    if (!buf) return GST_PAD_PROBE_OK;

    NvDsBatchMeta* batch = gst_buffer_get_nvds_batch_meta(buf);
    if (!batch) {
        // Fires once and stays silent if the upstream graph is mis-wired
        // (nvstreammux missing, or probe on the wrong pad). In practice
        // you either see this on every frame or never.
        static std::atomic<int> warned_no_batch{0};
        if (warned_no_batch.exchange(1) == 0) {
            std::cerr << "hailo_probe: buffer has no NvDsBatchMeta — "
                      << "upstream nvstreammux not attaching meta?\n";
        }
        return GST_PAD_PROBE_OK;
    }

    GstMapInfo map{};
    if (!gst_buffer_map(buf, &map, GST_MAP_READ)) return GST_PAD_PROBE_OK;
    auto* in_surf = reinterpret_cast<NvBufSurface*>(map.data);
    if (!in_surf) {
        gst_buffer_unmap(buf, &map);
        return GST_PAD_PROBE_OK;
    }

    {
        std::lock_guard<std::mutex> lock(ctx->ctx_mu);
        if (!ensureDstSurface(ctx, in_surf)) {
            gst_buffer_unmap(buf, &map);
            return GST_PAD_PROBE_OK;
        }
    }

    const int src_w = ctx->source_width;
    const int src_h = ctx->source_height;
    const LetterboxMap lb = computeLetterbox(src_w, src_h);

    for (NvDsMetaList* fl = batch->frame_meta_list; fl; fl = fl->next) {
        auto* frame = static_cast<NvDsFrameMeta*>(fl->data);
        if (!frame) continue;

        if (!prepareRgbScratch(ctx, in_surf, frame->batch_id, lb)) continue;

        std::vector<HailoDetection> dets;
        bool ok = false;
        try {
            ok = HailoInference::Instance(ctx->hef_path)
                    .Infer(ctx->rgb_scratch.data(), dets);
        } catch (const std::exception& e) {
            std::cerr << "hailo_probe: infer threw: " << e.what() << "\n";
            ok = false;
        }
        // One-shot liveness log on first successful inference so the operator
        // can confirm the probe is engaged; silent thereafter.
        static std::atomic<int> first_infer{0};
        if (first_infer.exchange(1) == 0) {
            std::cerr << "hailo_probe: first Infer call "
                      << (ok ? "succeeded" : "failed")
                      << " — " << dets.size() << " detection(s)\n";
        }
        if (!ok) continue;

        injectObjectMetas(batch, frame, dets, lb, src_w, src_h);
    }

    gst_buffer_unmap(buf, &map);
    return GST_PAD_PROBE_OK;
}

#endif // FNVR_HAS_DEEPSTREAM

} // namespace fnvr

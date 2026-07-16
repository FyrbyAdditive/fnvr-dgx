#include "preview_probe.h"
#include "face_crop_jpeg.h"
#include "surface_alloc.h"

#include <atomic>
#include <chrono>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <mutex>
#include <string>
#include <vector>

#include <sys/stat.h>

#if __has_include(<nvbufsurface.h>)
#include <nvbufsurface.h>
#include <nvbufsurftransform.h>
#include <gstnvdsmeta.h>
#include <nvdsmeta.h>
#define FNVR_HAS_DEEPSTREAM 1
#else
#define FNVR_HAS_DEEPSTREAM 0
#endif

namespace fnvr {

namespace {
// Output thumbnail dimensions. 480×270 is 16:9; non-16:9 content is
// scaled-fit — this image is only a tile fallback / snapshot.
constexpr int kOutW = 480;
constexpr int kOutH = 270;
constexpr int kQuality = 75;

// Ring depth — the api-server snapshot reader picks the second-newest
// entry, so ≥2 entries are needed; 4 is belt-and-braces.
constexpr int kRingSize = 4;

// 1 fps cadence per camera.
constexpr auto kInterval = std::chrono::milliseconds(1000);
}  // namespace

struct PreviewSource {
    std::string camera_id;
    std::chrono::steady_clock::time_point last_emit{};  // 0 = never
    int ring_idx = 0;
};

struct PreviewProbeCtx {
    std::string live_dir;
    std::vector<PreviewSource> sources;  // ordered by pad index

    std::mutex ctx_mu;  // serialises the transform+encode slow path
#if FNVR_HAS_DEEPSTREAM
    NvBufSurface* dst_surf = nullptr;  // shared, reused across members
#endif
};

PreviewProbeCtx* preview_probe_ctx_new(std::vector<std::string> camera_ids,
                                       std::string live_dir) {
    auto* ctx = new PreviewProbeCtx;
    ctx->live_dir = std::move(live_dir);
    for (auto& id : camera_ids) {
        PreviewSource s;
        s.camera_id = std::move(id);
        ctx->sources.push_back(std::move(s));
    }
    return ctx;
}

void preview_probe_ctx_free(PreviewProbeCtx* ctx) {
    if (!ctx) return;
#if FNVR_HAS_DEEPSTREAM
    if (ctx->dst_surf) {
        NvBufSurfaceDestroy(ctx->dst_surf);
        ctx->dst_surf = nullptr;
    }
#endif
    delete ctx;
}

#if FNVR_HAS_DEEPSTREAM

namespace {

// Lazily allocate the reusable RGBA destination at the gpuId of the
// first observed input surface. memType decision (CUDA_UNIFIED on
// GB10) lives in surface_alloc.cpp.
bool ensureDstSurface(PreviewProbeCtx* ctx, NvBufSurface* in_surf) {
    if (ctx->dst_surf) return true;
    if (!AllocCpuReadableRGBA(&ctx->dst_surf, kOutW, kOutH, in_surf->gpuId)) {
        std::cerr << "preview_probe: AllocCpuReadableRGBA failed\n";
        ctx->dst_surf = nullptr;
        return false;
    }
    return true;
}

// Encode dst_surf into the member's next ring slot (tmp + rename so a
// partial JPEG is never observable).
bool writeRingEntry(PreviewProbeCtx* ctx, PreviewSource& src) {
    NvBufSurfaceParams& dp = ctx->dst_surf->surfaceList[0];
    if (NvBufSurfaceMap(ctx->dst_surf, 0, 0, NVBUF_MAP_READ) != 0) {
        std::cerr << "preview_probe[" << src.camera_id
                  << "]: NvBufSurfaceMap failed\n";
        return false;
    }
    NvBufSurfaceSyncForCpu(ctx->dst_surf, 0, 0);

    const std::uint8_t* rgba =
        static_cast<const std::uint8_t*>(dp.mappedAddr.addr[0]);
    const int stride = static_cast<int>(dp.pitch);

    char tmp_path[512];
    char out_path[512];
    std::snprintf(tmp_path, sizeof(tmp_path), "%s/%s.%d.jpg.tmp",
                  ctx->live_dir.c_str(), src.camera_id.c_str(), src.ring_idx);
    std::snprintf(out_path, sizeof(out_path), "%s/%s.%d.jpg",
                  ctx->live_dir.c_str(), src.camera_id.c_str(), src.ring_idx);

    bool ok = encodeJpegRGBA(rgba, stride, 0, 0, kOutW, kOutH, kQuality,
                             tmp_path);
    NvBufSurfaceUnMap(ctx->dst_surf, 0, 0);

    if (!ok) {
        std::cerr << "preview_probe[" << src.camera_id
                  << "]: encodeJpegRGBA failed\n";
        std::remove(tmp_path);
        return false;
    }
    if (std::rename(tmp_path, out_path) != 0) {
        std::cerr << "preview_probe[" << src.camera_id
                  << "]: rename failed: " << std::strerror(errno) << "\n";
        std::remove(tmp_path);
        return false;
    }
    src.ring_idx = (src.ring_idx + 1) % kRingSize;
    return true;
}

}  // namespace

#endif  // FNVR_HAS_DEEPSTREAM

GstPadProbeReturn PreviewSnapshotProbe(GstPad*, GstPadProbeInfo* info,
                                       gpointer user) {
    auto* ctx = static_cast<PreviewProbeCtx*>(user);
    if (!ctx) return GST_PAD_PROBE_OK;

#if !FNVR_HAS_DEEPSTREAM
    (void)info;
    return GST_PAD_PROBE_OK;
#else
    GstBuffer* buf = gst_pad_probe_info_get_buffer(info);
    if (!buf) return GST_PAD_PROBE_OK;

    NvDsBatchMeta* batch = gst_buffer_get_nvds_batch_meta(buf);
    if (!batch) return GST_PAD_PROBE_OK;

    // Cheap pre-check without the lock: does ANY member want a frame?
    const auto now = std::chrono::steady_clock::now();
    bool any_due = false;
    for (const auto& s : ctx->sources) {
        if (s.last_emit.time_since_epoch().count() == 0 ||
            now - s.last_emit >= kInterval) {
            any_due = true;
            break;
        }
    }
    if (!any_due) return GST_PAD_PROBE_OK;

    // GPU transform session for this streaming thread (no VIC on GB10).
    EnsureGpuTransformSession();

    GstMapInfo map{};
    if (!gst_buffer_map(buf, &map, GST_MAP_READ)) return GST_PAD_PROBE_OK;
    auto* in_surf = reinterpret_cast<NvBufSurface*>(map.data);
    if (!in_surf) {
        gst_buffer_unmap(buf, &map);
        return GST_PAD_PROBE_OK;
    }

    std::lock_guard<std::mutex> lock(ctx->ctx_mu);
    if (!ensureDstSurface(ctx, in_surf)) {
        gst_buffer_unmap(buf, &map);
        return GST_PAD_PROBE_OK;
    }

    for (NvDsMetaList* fl = batch->frame_meta_list; fl; fl = fl->next) {
        auto* frame = static_cast<NvDsFrameMeta*>(fl->data);
        if (!frame) continue;
        const guint idx = frame->pad_index;
        if (idx >= ctx->sources.size()) continue;
        PreviewSource& src = ctx->sources[idx];
        if (src.last_emit.time_since_epoch().count() != 0 &&
            now - src.last_emit < kInterval) {
            continue;
        }
        // Advance the clock BEFORE the work so failures still wait a
        // full interval instead of retrying every batch.
        src.last_emit = now;

        if (frame->batch_id >= in_surf->numFilled) continue;
        NvBufSurfaceParams& in_p = in_surf->surfaceList[frame->batch_id];

        NvBufSurfTransformRect src_rect {
            0, 0, guint(in_p.width), guint(in_p.height)
        };
        NvBufSurfTransformRect dst_rect {
            0, 0, guint(kOutW), guint(kOutH)
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

        if (NvBufSurfTransform(&tmp_in, ctx->dst_surf, &tp)
            != NvBufSurfTransformError_Success) {
            std::cerr << "preview_probe[" << src.camera_id
                      << "]: NvBufSurfTransform failed\n";
            continue;
        }
        // Drain this thread's transform stream before writeRingEntry
        // maps the destination for CPU reads.
        SyncGpuTransformStream();

        bool ok = writeRingEntry(ctx, src);
        static std::atomic<int> first_ok{0};
        if (ok && first_ok.exchange(1) == 0) {
            std::cerr << "preview_probe[" << src.camera_id
                      << "]: first JPEG ring entry written\n";
        }
    }

    gst_buffer_unmap(buf, &map);
    return GST_PAD_PROBE_OK;
#endif
}

}  // namespace fnvr

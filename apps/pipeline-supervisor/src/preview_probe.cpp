#include "preview_probe.h"
#include "gpu_jpeg.h"
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

        // GPU crop + JPEG via gpu_jpeg.cpp (nvjpeg, CPU-libjpeg
        // fallback). Atomic tmp+rename lives inside the helper.
        NvBufSurfTransformRect src_rect {
            0, 0, guint(in_p.width), guint(in_p.height)
        };
        char out_path[512];
        std::snprintf(out_path, sizeof(out_path), "%s/%s.%d.jpg",
                      ctx->live_dir.c_str(), src.camera_id.c_str(),
                      src.ring_idx);
        const bool ok = SaveNv12RegionJpeg(in_surf, frame->batch_id,
                                           src_rect, kOutW, kOutH, kQuality,
                                           out_path, nullptr);
        if (ok) {
            src.ring_idx = (src.ring_idx + 1) % kRingSize;
        } else {
            std::cerr << "preview_probe[" << src.camera_id
                      << "]: jpeg write failed\n";
        }
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

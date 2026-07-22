#include "gpu_jpeg.h"

#include <atomic>
#include <cstdio>
#include <iostream>
#include <map>
#include <utility>
#include <vector>

#include <cuda_runtime_api.h>
#include <nvjpeg.h>

#include "face_crop_jpeg.h"
#include "object_phash.h"
#include "surface_alloc.h"

namespace fnvr {
namespace {

// Flips false on the first GPU-encode-path failure; the process then
// stays on the proven RGBA + libjpeg route for its lifetime.
std::atomic<bool> g_gpu_path_ok{true};
std::atomic<bool> g_fallback_logged{false};

struct NvJpegCtx {
    nvjpegHandle_t        handle = nullptr;
    nvjpegEncoderState_t  state = nullptr;
    nvjpegEncoderParams_t params = nullptr;
    int                   quality = -1;
    bool                  ready = false;
    bool                  failed = false;
};
thread_local NvJpegCtx t_nj;

// Per-thread destination surface cache keyed by (w,h,format) — the
// old code allocated + destroyed an NvBufSurface per detection.
using SurfKey = std::pair<std::pair<int, int>, int>;
thread_local std::map<SurfKey, NvBufSurface*> t_dst_cache;

NvBufSurface* cachedDst(int w, int h, unsigned gpu_id,
                        NvBufSurfaceColorFormat fmt) {
    SurfKey key{{w, h}, int(fmt)};
    auto it = t_dst_cache.find(key);
    if (it != t_dst_cache.end()) return it->second;
    NvBufSurface* s = nullptr;
    if (!AllocCpuReadableSurface(&s, w, h, gpu_id, fmt)) return nullptr;
    t_dst_cache[key] = s;
    return s;
}

bool ensureNvjpeg(cudaStream_t stream, int quality) {
    auto& nj = t_nj;
    if (nj.failed) return false;
    if (!nj.ready) {
        if (nvjpegCreateSimple(&nj.handle) != NVJPEG_STATUS_SUCCESS ||
            nvjpegEncoderStateCreate(nj.handle, &nj.state, stream) !=
                NVJPEG_STATUS_SUCCESS ||
            nvjpegEncoderParamsCreate(nj.handle, &nj.params, stream) !=
                NVJPEG_STATUS_SUCCESS) {
            nj.failed = true;
            return false;
        }
        if (nvjpegEncoderParamsSetSamplingFactors(
                nj.params, NVJPEG_CSS_420, stream) != NVJPEG_STATUS_SUCCESS) {
            nj.failed = true;
            return false;
        }
        nj.ready = true;
    }
    if (nj.quality != quality) {
        if (nvjpegEncoderParamsSetQuality(nj.params, quality, stream) !=
            NVJPEG_STATUS_SUCCESS) {
            nj.failed = true;
            return false;
        }
        nj.quality = quality;
    }
    return true;
}

bool runTransform(NvBufSurface* in_surf, unsigned batch_id,
                  NvBufSurfTransformRect src_rect, NvBufSurface* dst,
                  int out_w, int out_h) {
    NvBufSurfTransformRect dst_rect{0, 0, (unsigned)out_w, (unsigned)out_h};
    NvBufSurfTransformParams tp{};
    tp.src_rect = &src_rect;
    tp.dst_rect = &dst_rect;
    tp.transform_flag = NVBUFSURF_TRANSFORM_FILTER |
                        NVBUFSURF_TRANSFORM_CROP_SRC |
                        NVBUFSURF_TRANSFORM_CROP_DST;
    tp.transform_filter = NvBufSurfTransformInter_Default;

    NvBufSurface tmp_in = *in_surf;
    tmp_in.surfaceList = &in_surf->surfaceList[batch_id];
    tmp_in.numFilled = 1;
    tmp_in.batchSize = 1;
    return NvBufSurfTransform(&tmp_in, dst, &tp) ==
           NvBufSurfTransformError_Success;
}

bool writeAtomic(const std::string& out_path, const void* data, size_t n) {
    const std::string tmp = out_path + ".tmp";
    std::FILE* fp = std::fopen(tmp.c_str(), "wb");
    if (!fp) return false;
    const bool ok = std::fwrite(data, 1, n, fp) == n;
    std::fclose(fp);
    if (!ok || std::rename(tmp.c_str(), out_path.c_str()) != 0) {
        std::remove(tmp.c_str());
        return false;
    }
    return true;
}

// GPU path: I420 dst → nvjpegEncodeYuv from device planes → bitstream
// to host → atomic file write. pHash (when wanted) maps only the tiny
// luma plane of the SMALL dst.
bool gpuPath(NvBufSurface* in_surf, unsigned batch_id,
             NvBufSurfTransformRect src_rect, int out_w, int out_h,
             int quality, const std::string& out_path,
             std::uint64_t* out_ahash) {
    cudaStream_t stream = GetGpuTransformStream();
    if (!ensureNvjpeg(stream, quality)) return false;

    NvBufSurface* dst = cachedDst(out_w, out_h, in_surf->gpuId,
                                  NVBUF_COLOR_FORMAT_YUV420);
    if (!dst) return false;
    if (!runTransform(in_surf, batch_id, src_rect, dst, out_w, out_h)) {
        return false;
    }

    NvBufSurfaceParams& dp = dst->surfaceList[0];
    if (dp.planeParams.num_planes < 3 || !dp.dataPtr) return false;

    if (!out_path.empty()) {
        nvjpegImage_t img{};
        auto* base = static_cast<unsigned char*>(dp.dataPtr);
        for (int pl = 0; pl < 3; pl++) {
            img.channel[pl] = base + dp.planeParams.offset[pl];
            img.pitch[pl] = dp.planeParams.pitch[pl];
        }
        auto& nj = t_nj;
        if (nvjpegEncodeYUV(nj.handle, nj.state, nj.params, &img,
                            NVJPEG_CSS_420, out_w, out_h,
                            stream) != NVJPEG_STATUS_SUCCESS) {
            return false;
        }
        size_t len = 0;
        if (nvjpegEncodeRetrieveBitstream(nj.handle, nj.state, nullptr, &len,
                                          stream) != NVJPEG_STATUS_SUCCESS ||
            len == 0) {
            return false;
        }
        std::vector<unsigned char> jpg(len);
        if (nvjpegEncodeRetrieveBitstream(nj.handle, nj.state, jpg.data(),
                                          &len, stream) !=
            NVJPEG_STATUS_SUCCESS) {
            return false;
        }
        cudaStreamSynchronize(stream);
        if (!writeAtomic(out_path, jpg.data(), len)) return false;
    }

    if (out_ahash) {
        // Same thread-local stream the encode path drained above —
        // only sync when no JPEG write already did (a sync of an idle
        // stream is still a driver round-trip on the streaming thread).
        if (out_path.empty()) SyncGpuTransformStream();
        if (NvBufSurfaceMap(dst, 0, 0, NVBUF_MAP_READ) != 0) return false;
        NvBufSurfaceSyncForCpu(dst, 0, 0);
        const auto* y =
            static_cast<const std::uint8_t*>(dp.mappedAddr.addr[0]);
        std::uint8_t luma[64];
        downsampleLuma8x8FromGray(y, out_w, out_h,
                                  int(dp.planeParams.pitch[0]), luma);
        *out_ahash = computeAverageHash64(luma);
        NvBufSurfaceUnMap(dst, 0, 0);
    }
    return true;
}

// Legacy path: RGBA dst → sync → CPU map → libjpeg (+ RGBA phash).
bool cpuPath(NvBufSurface* in_surf, unsigned batch_id,
             NvBufSurfTransformRect src_rect, int out_w, int out_h,
             int quality, const std::string& out_path,
             std::uint64_t* out_ahash) {
    NvBufSurface* dst = cachedDst(out_w, out_h, in_surf->gpuId,
                                  NVBUF_COLOR_FORMAT_RGBA);
    if (!dst) return false;
    if (!runTransform(in_surf, batch_id, src_rect, dst, out_w, out_h)) {
        return false;
    }
    SyncGpuTransformStream();

    if (NvBufSurfaceMap(dst, 0, 0, NVBUF_MAP_READ) != 0) return false;
    NvBufSurfaceSyncForCpu(dst, 0, 0);
    NvBufSurfaceParams& dp = dst->surfaceList[0];
    const auto* rgba = static_cast<const std::uint8_t*>(dp.mappedAddr.addr[0]);
    const int pitch = int(dp.planeParams.pitch[0]);

    bool ok = true;
    if (!out_path.empty()) {
        const std::string tmp = out_path + ".tmp";
        ok = encodeJpegRGBA(rgba, pitch, 0, 0, out_w, out_h, quality, tmp);
        if (ok && std::rename(tmp.c_str(), out_path.c_str()) != 0) {
            std::remove(tmp.c_str());
            ok = false;
        }
    }
    if (out_ahash) {
        std::uint8_t luma[64];
        downsampleToLuma8x8(rgba, out_w, out_h, pitch, luma);
        *out_ahash = computeAverageHash64(luma);
    }
    NvBufSurfaceUnMap(dst, 0, 0);
    return ok;
}

}  // namespace

bool SaveNv12RegionJpeg(NvBufSurface* in_surf, unsigned batch_id,
                        NvBufSurfTransformRect src_rect,
                        int out_w, int out_h, int quality,
                        const std::string& out_path,
                        std::uint64_t* out_ahash) {
    if (out_ahash) *out_ahash = 0;
    if (!in_surf || batch_id >= in_surf->numFilled) return false;
    EnsureGpuTransformSession();

    if (g_gpu_path_ok.load(std::memory_order_relaxed)) {
        if (gpuPath(in_surf, batch_id, src_rect, out_w, out_h, quality,
                    out_path, out_ahash)) {
            return true;
        }
        g_gpu_path_ok.store(false, std::memory_order_relaxed);
        if (!g_fallback_logged.exchange(true)) {
            std::cerr << "gpu_jpeg: GPU encode path failed — falling back "
                         "to CPU libjpeg for the life of this process\n";
        }
    }
    return cpuPath(in_surf, batch_id, src_rect, out_w, out_h, quality,
                   out_path, out_ahash);
}

}  // namespace fnvr

#include "surface_alloc.h"

#if __has_include(<nvbufsurface.h>)

#include <iostream>

#include <cuda_runtime_api.h>
#include <nvbufsurftransform.h>

namespace fnvr {

namespace {

// The one platform decision this file owns: which memType gives us a
// CPU-mappable destination on SBSA/dGPU. CUDA_UNIFIED is the right
// default on GB10 (coherent LPDDR5x); CUDA_PINNED is the documented
// fallback if a container/driver combination refuses to map unified
// memory. Flip here, nowhere else.
constexpr NvBufSurfaceMemType kCpuReadableMemType = NVBUF_MEM_CUDA_UNIFIED;

// Per-thread transform stream. Streaming threads are long-lived and few
// (one per pipeline branch), so we never bother destroying these.
thread_local cudaStream_t t_transform_stream = nullptr;
thread_local bool         t_session_ready    = false;

}  // namespace

bool AllocCpuReadableRGBA(NvBufSurface** out, int width, int height,
                          unsigned gpu_id) {
    NvBufSurfaceAllocateParams ap{};
    ap.params.gpuId        = gpu_id;
    ap.params.width        = static_cast<unsigned>(width);
    ap.params.height       = static_cast<unsigned>(height);
    ap.params.size         = 0;
    ap.params.isContiguous = true;
    ap.params.colorFormat  = NVBUF_COLOR_FORMAT_RGBA;
    ap.params.layout       = NVBUF_LAYOUT_PITCH;
    ap.params.memType      = kCpuReadableMemType;
    ap.memtag              = NvBufSurfaceTag_VIDEO_CONVERT;

    NvBufSurface* dst = nullptr;
    if (NvBufSurfaceAllocate(&dst, 1, &ap) != 0 || !dst) {
        return false;
    }
    dst->numFilled = 1;
    *out = dst;
    return true;
}

void EnsureGpuTransformSession() {
    if (t_session_ready) return;

    if (cudaStreamCreateWithFlags(&t_transform_stream,
                                  cudaStreamNonBlocking) != cudaSuccess) {
        // Fall back to the default stream — correct, just serialises
        // against other default-stream work.
        t_transform_stream = nullptr;
    }

    NvBufSurfTransformConfigParams cfg{};
    cfg.compute_mode = NvBufSurfTransformCompute_GPU;
    cfg.gpu_id       = 0;
    cfg.cuda_stream  = t_transform_stream;
    if (NvBufSurfTransformSetSessionParams(&cfg)
        != NvBufSurfTransformError_Success) {
        // Log once per thread; the transform itself will surface the
        // failure to the caller if the session genuinely can't work.
        std::cerr << "surface_alloc: NvBufSurfTransformSetSessionParams "
                     "failed (GPU compute) — transforms may use defaults\n";
    }
    t_session_ready = true;
}

void SyncGpuTransformStream() {
    if (t_transform_stream) {
        cudaStreamSynchronize(t_transform_stream);
    } else {
        // Default-stream fallback (or session never configured):
        // cudaStreamSynchronize(0) drains the default stream, which is
        // where the transform ran in that case.
        cudaStreamSynchronize(nullptr);
    }
}

}  // namespace fnvr

#endif  // __has_include(<nvbufsurface.h>)

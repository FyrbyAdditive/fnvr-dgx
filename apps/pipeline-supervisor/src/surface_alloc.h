#pragma once

// CPU-readable NvBufSurface allocation + GPU transform session helpers
// for dGPU/SBSA platforms (DGX Spark / GB10).
//
// On Jetson the probes allocated NVBUF_MEM_SURFACE_ARRAY destinations
// and relied on the VIC for NvBufSurfTransform. Neither exists on GB10:
// SURFACE_ARRAY is a Tegra-only memType (allocation fails on SBSA) and
// there is no VIC engine — every transform must run as GPU compute.
//
// This header centralises both platform decisions:
//   * AllocCpuReadableRGBA — one place owns the CPU-mappable memType.
//     NVBUF_MEM_CUDA_UNIFIED by default: GB10's LPDDR5x is CPU-coherent,
//     so unified-memory CPU reads are near-memcpy speed. If map/read
//     proves slow or unmappable in a given container, flip the single
//     constant in surface_alloc.cpp to NVBUF_MEM_CUDA_PINNED.
//   * EnsureGpuTransformSession — NvBufSurfTransform session params are
//     per-thread. Pad probes run on GStreamer streaming threads, and an
//     unset session uses the default CUDA stream, serialising against
//     nvinfer. Call this at the top of any probe that transforms; it is
//     idempotent per thread.
//   * SyncGpuTransformStream — transforms on the session's non-blocking
//     stream complete asynchronously; call this after NvBufSurfTransform
//     and before CPU-mapping the destination.

#if __has_include(<nvbufsurface.h>)

#include <nvbufsurface.h>

namespace fnvr {

// Allocate a 1-frame pitch-linear RGBA surface that the CPU can map and
// read (NvBufSurfaceMap + memcpy/libjpeg). Returns false on failure;
// *out is only written on success. numFilled is pre-set to 1.
bool AllocCpuReadableRGBA(NvBufSurface** out, int width, int height,
                          unsigned gpu_id);

// Idempotently configure this thread's NvBufSurfTransform session for
// GPU compute (gpu_id 0) on a dedicated non-blocking CUDA stream.
void EnsureGpuTransformSession();

// Block until this thread's transform stream has drained. Safe to call
// when EnsureGpuTransformSession hasn't run (no-op).
void SyncGpuTransformStream();

}  // namespace fnvr

#endif  // __has_include(<nvbufsurface.h>)

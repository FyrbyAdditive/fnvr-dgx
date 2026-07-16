#pragma once

#include <cstdint>
#include <string>

#include <nvbufsurface.h>
#include <nvbufsurftransform.h>

namespace fnvr {

// SaveNv12RegionJpeg — crop `src_rect` out of `in_surf[batch_id]`
// (the batched NV12 NVMM surface) and write an out_w×out_h JPEG to
// out_path (atomically: .tmp + rename). Runs entirely on the GPU:
// NvBufSurfTransform → I420 on this thread's transform stream, then
// nvjpeg encodes from device memory — the CPU only writes the
// bitstream to disk. This path replaces the old RGBA-transform +
// CPU-map + libjpeg route, which stalled the streaming thread on a
// GPU sync per detection.
//
// On the FIRST failure of the GPU encode path (nvjpeg init, I420
// transform, encode) the process permanently falls back to the legacy
// CPU route — correctness beats elegance on an unproven format path.
//
// out_ahash: when non-null, receives computeAverageHash64 of the
// crop's luma (0 on failure). out_path may be empty for hash-only
// calls. Returns false only when BOTH paths failed.
bool SaveNv12RegionJpeg(NvBufSurface* in_surf, unsigned batch_id,
                        NvBufSurfTransformRect src_rect,
                        int out_w, int out_h, int quality,
                        const std::string& out_path,
                        std::uint64_t* out_ahash);

}  // namespace fnvr

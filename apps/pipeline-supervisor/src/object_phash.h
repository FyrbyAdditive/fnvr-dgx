#pragma once

#include <cstdint>
#include <string>

namespace fnvr {

// computeAverageHash64 returns a 64-bit perceptual hash of the
// 8×8 luminance of an RGBA crop. Algorithm:
//   1. Resize the input to 8×8 (caller: pass an 8×8 buffer already,
//      or use helper downsampleToLuma8x8 below).
//   2. Compute the mean luma across the 64 pixels.
//   3. For each pixel: bit = 1 if > mean, else 0. Pack into uint64.
//
// This is "average-hash" — faster and simpler than DCT pHash, and
// for fnvr's job (recurring false-positive matching on static
// cameras) it empirically performs the same. Hamming distance on
// the resulting 64-bit values matches "looks the same under small
// pose / lighting variation".
//
// luma8x8 must be 64 bytes of single-channel luminance in row-major
// order (Y plane of BT.601 or similar).
std::uint64_t computeAverageHash64(const std::uint8_t* luma8x8);

// downsampleToLuma8x8 takes a Rectangular RGBA source (e.g. the
// NvBufSurfTransform output used for face crops) and produces a 64-
// byte Y8 buffer via box-average downscale + BT.601 RGB→Y.
//
// rgba        — top-left pixel of the source rect (no internal crop).
// src_w/h     — dimensions of that rect.
// src_stride  — bytes per row in the source buffer (≥ src_w*4).
// out_luma    — caller-allocated 64-byte buffer.
void downsampleToLuma8x8(const std::uint8_t* rgba,
                         int src_w, int src_h, int src_stride,
                         std::uint8_t* out_luma);

// Grayscale-source variant: box-average an 8-bit luma plane (e.g. the
// Y plane of an I420 crop) straight to 8×8 — no colour conversion.
void downsampleLuma8x8FromGray(const std::uint8_t* y,
                               int src_w, int src_h, int src_stride,
                               std::uint8_t* out_luma);

// uint64ToHex16 writes a 64-bit value as 16 lowercase hex chars into
// `out` (caller guarantees ≥17 bytes). No trailing NUL in the
// 16-byte write position; caller writes the NUL if the buffer is
// used as a C string. We use this format on the wire for
// attributes.phash so the matching Go helper in event-processor can
// parseHex directly.
std::string uint64ToHex16(std::uint64_t v);

}  // namespace fnvr

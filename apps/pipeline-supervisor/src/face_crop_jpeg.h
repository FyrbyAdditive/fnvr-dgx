#pragma once

#include <cstdint>
#include <string>

namespace fnvr {

// encodeJpegRGBA writes a JPEG of a sub-rectangle of an RGBA frame.
// Split into its own TU because libjpeg's <jmorecfg.h> typedefs
// INT32 as `long`, which conflicts with DeepStream's nvdsinfer.h
// that declares `INT32` as an enum value. Keeping jpeg out of
// pipeline.cpp (which includes DeepStream) avoids the clash.
//
// rgba         — pointer to the top-left pixel of the full frame
// src_stride   — bytes per row in the source buffer (≥ W*4)
// x,y,w,h      — pixel rect to encode, already clipped to the frame
// quality      — 0-100 (80 is visibly lossless for face crops)
// out_path     — filesystem path to write. Overwrites if present.
bool encodeJpegRGBA(const std::uint8_t* rgba, int src_stride,
                    int x, int y, int w, int h, int quality,
                    const std::string& out_path);

}  // namespace fnvr

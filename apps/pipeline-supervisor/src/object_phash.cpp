#include "object_phash.h"

#include <cstdint>
#include <cstdio>
#include <string>

namespace fnvr {

void downsampleToLuma8x8(const std::uint8_t* rgba,
                         int src_w, int src_h, int src_stride,
                         std::uint8_t* out_luma) {
    // For each of 8×8 output cells, average the pixels of the source
    // rect that fall into that cell. Integer area-average; not as
    // spectrally pure as a proper Lanczos but the output is 64 bytes
    // so the fidelity lost is negligible against the downstream
    // Hamming threshold.
    //
    // Y = 0.299*R + 0.587*G + 0.114*B  (BT.601)
    // Precomputed in int16: 77, 150, 29 summing to 256.
    if (src_w <= 0 || src_h <= 0 || !rgba || !out_luma) return;

    for (int cy = 0; cy < 8; cy++) {
        const int y0 = (cy * src_h) / 8;
        const int y1 = ((cy + 1) * src_h) / 8;
        const int yh = (y1 > y0) ? (y1 - y0) : 1;
        for (int cx = 0; cx < 8; cx++) {
            const int x0 = (cx * src_w) / 8;
            const int x1 = ((cx + 1) * src_w) / 8;
            const int xw = (x1 > x0) ? (x1 - x0) : 1;

            // Sum luminance over this cell's pixels.
            std::uint64_t sum = 0;
            std::uint64_t count = 0;
            for (int yy = y0; yy < y1; yy++) {
                const std::uint8_t* row = rgba + yy * src_stride + x0 * 4;
                for (int xx = 0; xx < xw; xx++) {
                    const std::uint8_t r = row[xx * 4 + 0];
                    const std::uint8_t g = row[xx * 4 + 1];
                    const std::uint8_t b = row[xx * 4 + 2];
                    const std::uint32_t y =
                        (77u * r + 150u * g + 29u * b) >> 8;
                    sum += y;
                    count++;
                }
            }
            std::uint8_t avg = count > 0 ? std::uint8_t(sum / count) : 0;
            out_luma[cy * 8 + cx] = avg;
        }
    }
}

std::uint64_t computeAverageHash64(const std::uint8_t* luma8x8) {
    if (!luma8x8) return 0;
    std::uint64_t sum = 0;
    for (int i = 0; i < 64; i++) sum += luma8x8[i];
    const std::uint8_t mean = std::uint8_t(sum / 64);
    std::uint64_t h = 0;
    for (int i = 0; i < 64; i++) {
        if (luma8x8[i] > mean) {
            h |= (std::uint64_t(1) << (63 - i));
        }
    }
    return h;
}

std::string uint64ToHex16(std::uint64_t v) {
    char buf[17];
    // snprintf with "%016lx" on 64-bit platforms; use explicit llx for
    // portability across 32-bit / 64-bit long on aarch64 targets.
    std::snprintf(buf, sizeof(buf), "%016llx",
                  static_cast<unsigned long long>(v));
    return std::string(buf, 16);
}

}  // namespace fnvr

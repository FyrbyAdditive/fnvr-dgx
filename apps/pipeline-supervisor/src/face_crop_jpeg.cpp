#include "face_crop_jpeg.h"

#include <cstdio>
#include <vector>

extern "C" {
#include <jpeglib.h>
}

namespace fnvr {

bool encodeJpegRGBA(const std::uint8_t* rgba, int src_stride,
                    int x, int y, int w, int h, int quality,
                    const std::string& out_path) {
    if (w <= 0 || h <= 0 || !rgba) return false;
    std::FILE* fp = std::fopen(out_path.c_str(), "wb");
    if (!fp) return false;

    jpeg_compress_struct cinfo{};
    jpeg_error_mgr jerr{};
    cinfo.err = jpeg_std_error(&jerr);
    jpeg_create_compress(&cinfo);
    jpeg_stdio_dest(&cinfo, fp);
    cinfo.image_width = static_cast<JDIMENSION>(w);
    cinfo.image_height = static_cast<JDIMENSION>(h);
    cinfo.input_components = 3;
    cinfo.in_color_space = JCS_RGB;
    jpeg_set_defaults(&cinfo);
    jpeg_set_quality(&cinfo, quality, TRUE);
    jpeg_start_compress(&cinfo, TRUE);

    std::vector<std::uint8_t> row(static_cast<std::size_t>(w) * 3);
    while (cinfo.next_scanline < cinfo.image_height) {
        int sy = y + static_cast<int>(cinfo.next_scanline);
        const std::uint8_t* src = rgba +
            static_cast<std::size_t>(sy) * static_cast<std::size_t>(src_stride) +
            static_cast<std::size_t>(x) * 4;
        // Strip alpha channel: RGBA → RGB.
        for (int i = 0; i < w; i++) {
            row[i * 3 + 0] = src[i * 4 + 0];
            row[i * 3 + 1] = src[i * 4 + 1];
            row[i * 3 + 2] = src[i * 4 + 2];
        }
        JSAMPROW p = row.data();
        jpeg_write_scanlines(&cinfo, &p, 1);
    }

    jpeg_finish_compress(&cinfo);
    jpeg_destroy_compress(&cinfo);
    std::fclose(fp);
    return true;
}

}  // namespace fnvr

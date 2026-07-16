#pragma once

// PreviewSnapshotProbe — batch-aware pad probe attached on pgie.src
// that taps decoded NVMM frames already in flight on the inference
// branch (no second decode). For each member camera it maintains a
// 1 fps, 4-entry JPEG ring at {live_dir}/<camera_id>.<n>.jpg:
// it walks NvDsBatchMeta, attributes each frame to its member via
// frame_meta->pad_index, does a GPU-accelerated NV12→RGBA scale into a
// reusable dst surface, and JPEG-encodes via face_crop_jpeg.
//
// The api-server's snapshot endpoint reads the second-newest ring
// entry (see snapshot.go); writes are tmp+rename so a partially
// written JPEG is never visible.

#include <string>
#include <vector>

#include <gst/gst.h>

namespace fnvr {

struct PreviewProbeCtx;

// camera_ids must be ordered by mux pad index (member order).
PreviewProbeCtx* preview_probe_ctx_new(std::vector<std::string> camera_ids,
                                       std::string live_dir);
void preview_probe_ctx_free(PreviewProbeCtx* ctx);

GstPadProbeReturn PreviewSnapshotProbe(GstPad* pad, GstPadProbeInfo* info,
                                       gpointer user_data);

}  // namespace fnvr

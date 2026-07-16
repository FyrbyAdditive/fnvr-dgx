#pragma once

#include <gst/gst.h>
#include <string>

namespace fnvr {

// PreviewSnapshotProbe — pad probe that taps a decoded NVMM frame in
// flight on the inference branch and writes a 480×270 JPEG ring at
// /var/lib/fnvr/live/<camera_id>.<n>.jpg, replacing what used to be a
// separate decode+jpegenc branch in the gstreamer graph. Replaces an
// entire nvv4l2decoder per camera; see docs/architecture/pipeline.md.
//
// The probe is rate-limited to 1 frame/sec on a steady_clock; on the
// fast path it returns GST_PAD_PROBE_OK immediately. On the slow path
// it does GPU-accelerated NV12→RGBA scale to a reusable dst surface,
// maps it for CPU read, and uses face_crop_jpeg's encodeJpegRGBA
// helper to write the ring slot atomically (tmp + rename).
//
// One ctx per camera; lifetime is owned by the caller (the SingleCamera
// pipeline frees it in its destructor). The probe is pure pass-through:
// it never modifies or drops the buffer.

struct PreviewProbeCtx;  // opaque

PreviewProbeCtx* preview_probe_ctx_new(std::string camera_id,
                                       std::string live_dir,
                                       int src_w, int src_h);
void             preview_probe_ctx_free(PreviewProbeCtx*);

GstPadProbeReturn PreviewSnapshotProbe(GstPad*, GstPadProbeInfo*, gpointer user_data);

}  // namespace fnvr

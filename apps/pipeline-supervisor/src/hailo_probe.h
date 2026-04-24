// GStreamer pad probe that replaces nvinfer PGIE on Hailo-backed cameras.
//
// Attached to the src pad of the graph element that would otherwise be
// `nvinfer name=pgie`. For cameras with detector_backend="hailo", we build
// that position as a `queue name=pgie` (no-op) and install this probe on
// its src pad. The probe:
//   1. Walks each NvDsFrameMeta in the batch.
//   2. Uses NvBufSurfTransform to downscale the frame's NVMM surface into a
//      640x640 RGB scratch (aspect preserved via letterbox).
//   3. Calls HailoInference::Infer on the RGB buffer.
//   4. For each returned detection, creates an NvDsObjectMeta (class_id,
//      rect_params in source pixel space, confidence, obj_label from COCO
//      class table) and attaches it to the frame meta.
//
// Downstream nvtracker picks up these objects as if nvinfer had produced
// them — stable track_ids, LPDNet/SCRFD SGIEs run unchanged against
// vehicle / person crops, the InferSrcProbe publishes to NATS as usual.
#pragma once

#include <gst/gst.h>

namespace fnvr {

// Opaque context — owns the HailoInference reference, scratch surface, and
// per-stream source dimensions. One per camera pipeline.
struct HailoProbeCtx;

HailoProbeCtx* hailo_probe_ctx_new(const char* hef_path,
                                   int source_width,
                                   int source_height);
void hailo_probe_ctx_free(HailoProbeCtx*);

// Pad-probe callback in GstPadProbeCallback shape. Always returns
// GST_PAD_PROBE_OK (we don't drop frames even on inference errors — missing
// detections for one frame is better than starving the tracker).
GstPadProbeReturn HailoInferProbe(GstPad* pad, GstPadProbeInfo* info, gpointer user);

} // namespace fnvr

// Wire protocol between fnvr pipeline-supervisor workers and the
// fnvr-hailo-broker daemon.
//
// Exists because the libhailort v4.23.0 multi-process service path (the
// hailort_service daemon with multi_process_service=true on VDevice::create)
// is broken for our yolov11l NMS-on-chip workload — see the investigation in
// the original Hailo integration commit. It hits HAILO_INTERNAL_FAILURE on
// the first run_async when ConfiguredInferModelImpl wraps an RPC-backed
// ConfiguredNetworkGroupClient. Instead of forking libhailort, we route all
// VDevice access through a single broker process that uses the known-working
// direct VDevice path, and talk to it over this bespoke unix-socket protocol.
//
// Single request/reply per connection is fine; pipeline workers hold a
// persistent connection and fire one request per frame.
//
// All fields little-endian (both sides are aarch64 Linux).

#pragma once
#include <cstdint>

namespace fnvr::hailo_wire {

// Expected input shape — caller must send exactly this many bytes of RGB.
// Matches HailoInference::kInputWidth/Height in the broker.
constexpr uint32_t kInputWidth     = 640;
constexpr uint32_t kInputHeight    = 640;
constexpr uint32_t kInputChannels  = 3;
constexpr uint32_t kInputBytes     = kInputWidth * kInputHeight * kInputChannels;  // 1,228,800

// Shared magic so a malformed client can't make the broker process junk as
// RGB. Also the basis for protocol versioning — bump the upper byte when
// the wire format changes.
constexpr uint32_t kMagic = 0xFA1C0001;

// Max detections in one reply. The underlying yolov11l HEF caps bboxes at
// 100 per class * 80 classes = 8000 max; in practice we see <100 per frame.
constexpr uint32_t kMaxDetections = 1024;

// Request: { u32 magic; u8 rgb[kInputBytes] }
// Reply:   { u32 magic; u32 status; u16 n_detections; Detection[n] }
//
// Status: 0 = success, non-zero = hailort status code (passed through).
//
// Detection is packed, 21 bytes each:
//   u8  class_id
//   f32 score
//   f32 x0, y0, x1, y1  (network-space, normalised to [0,1])
#pragma pack(push, 1)
struct Detection {
    uint8_t  class_id;
    float    score;
    float    x0;
    float    y0;
    float    x1;
    float    y1;
};
#pragma pack(pop)
static_assert(sizeof(Detection) == 21, "Detection must be 21 bytes packed");

#pragma pack(push, 1)
struct ReplyHeader {
    uint32_t magic;
    uint32_t status;         // hailo_status, 0 = success
    uint16_t n_detections;
};
#pragma pack(pop)
static_assert(sizeof(ReplyHeader) == 10, "ReplyHeader must be 10 bytes packed");

// Default socket path. Broker creates it, pipeline workers connect to it.
// Lives on a shared docker volume so both containers see the same inode.
constexpr const char* kSocketPath = "/var/run/fnvr/hailo.sock";

} // namespace fnvr::hailo_wire

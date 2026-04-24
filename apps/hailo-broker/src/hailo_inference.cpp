#include "hailo_inference.h"

#include <atomic>
#include <cassert>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <sys/mman.h>
#include <unistd.h>

#ifndef FNVR_HAS_HAILO
#define FNVR_HAS_HAILO 0
#endif

#if FNVR_HAS_HAILO
#include <hailo/vdevice.hpp>
#include <hailo/infer_model.hpp>
#include <hailo/hailort.h>
#endif

namespace fnvr {

#if FNVR_HAS_HAILO

using namespace hailort;

// mmap-backed page-aligned scratch buffer. libhailort's docs require
// PAGE_SIZE alignment for output buffers (otherwise memory corruption at
// the tail); for inputs it's a performance thing but also affects whether
// libhailort can DMA-map the buffer directly vs. bounce-copy. Using
// std::vector is not enough — the data pointer alignment isn't guaranteed.
struct PageAlignedBuffer {
    uint8_t* ptr = nullptr;
    size_t   size = 0;
    size_t   capacity = 0;  // mmap'd size (rounded up to page)

    void allocate(size_t n) {
        free();
        long page = ::sysconf(_SC_PAGESIZE);
        if (page <= 0) page = 4096;
        capacity = ((n + page - 1) / page) * page;
        void* p = ::mmap(nullptr, capacity, PROT_READ | PROT_WRITE,
                         MAP_ANONYMOUS | MAP_PRIVATE, -1, 0);
        if (p == MAP_FAILED) {
            throw std::bad_alloc();
        }
        ptr = reinterpret_cast<uint8_t*>(p);
        size = n;
        std::memset(ptr, 0, capacity);
    }
    void free() {
        if (ptr) {
            ::munmap(ptr, capacity);
            ptr = nullptr;
            size = 0;
            capacity = 0;
        }
    }
    PageAlignedBuffer() = default;
    ~PageAlignedBuffer() { free(); }
    PageAlignedBuffer(const PageAlignedBuffer&) = delete;
    PageAlignedBuffer& operator=(const PageAlignedBuffer&) = delete;
};

// hailo_bbox_float32_t layout, packed, per the hailort public header:
//   float32 y_min, x_min, y_max, x_max, score
// Keep this local so we don't leak the hailort typedef up into headers;
// hailo_inference.h stays hailort-free so pipeline.cpp doesn't need the
// hailort include path at its compile site.
struct HailoBboxF32 {
    float y_min;
    float x_min;
    float y_max;
    float x_max;
    float score;
};
static_assert(sizeof(HailoBboxF32) == 5 * sizeof(float),
              "HailoBboxF32 must be packed");

struct HailoInference::Impl {
    std::unique_ptr<VDevice>            vdevice;
    std::shared_ptr<InferModel>         infer_model;
    ConfiguredInferModel                configured;
    ConfiguredInferModel::Bindings      bindings;

    // Scratch buffers reused across calls. Page-aligned via mmap — required
    // by libhailort for DMA safety. Sized once at construction from the
    // model's reported frame sizes so we pay the allocation cost once.
    PageAlignedBuffer                   input_buffer;   // 640*640*3 RGB
    PageAlignedBuffer                   output_buffer;  // NMS output, model-sized

    std::string                         output_name;

    // Decoded NMS shape — used by the parser to bound class iteration.
    uint32_t                            num_classes      = 0;
    uint32_t                            max_bboxes_class = 0;
};

HailoInference& HailoInference::Instance(const std::string& hef_path) {
    // Narrow singleton semantics: first caller wins the HEF path; subsequent
    // callers reuse the same instance regardless of what they passed. The
    // supervisor uses a single HEF for iteration 1, so this is fine; if we
    // ever multi-HEF, this changes to a keyed map.
    static HailoInference* instance = nullptr;
    static std::once_flag init_flag;
    static std::exception_ptr init_err;

    std::call_once(init_flag, [&]{
        try {
            instance = new HailoInference(hef_path);
        } catch (...) {
            init_err = std::current_exception();
        }
    });
    if (init_err) std::rethrow_exception(init_err);
    return *instance;
}

HailoInference::HailoInference(const std::string& hef_path)
    : impl_(std::make_unique<Impl>())
{
    // One VDevice per process with direct /dev/hailo0 access.
    // Multi-process sharing is handled by our hailo-broker daemon which
    // owns this code path exclusively; the supervisor's pipeline workers
    // talk to the broker over a unix socket (see hailo_client.cpp), so
    // only the broker process ever runs this path.
    auto vdev_exp = VDevice::create();
    if (!vdev_exp) {
        throw std::runtime_error(
            "HailoInference: VDevice::create failed: " +
            std::to_string(static_cast<int>(vdev_exp.status())));
    }
    impl_->vdevice = vdev_exp.release();

    auto model_exp = impl_->vdevice->create_infer_model(hef_path);
    if (!model_exp) {
        throw std::runtime_error(
            "HailoInference: create_infer_model(" + hef_path + ") failed: " +
            std::to_string(static_cast<int>(model_exp.status())));
    }
    impl_->infer_model = model_exp.release();

    // The yolov11l HEF from Hailo Model Zoo ships with on-chip NMS already
    // configured as HAILO_FORMAT_ORDER_HAILO_NMS_BY_CLASS + FLOAT32 — exactly
    // what our parser wants. Overriding via set_format_order / set_format_type
    // here fails configure() with HAILO_HEF_NOT_COMPATIBLE_WITH_DEVICE (93)
    // on HailoRT 4.23.0 even when the requested format matches the HEF's
    // native output. Leaving the defaults is both simpler and correct —
    // confirmed against `hailortcli parse-hef yolov11l.hef` which reports
    // the same layout we decode in Infer().

    // Configure (compiles the model onto the device). Blocking.
    auto conf_exp = impl_->infer_model->configure();
    if (!conf_exp) {
        throw std::runtime_error(
            "HailoInference: configure() failed: " +
            std::to_string(static_cast<int>(conf_exp.status())));
    }
    impl_->configured = conf_exp.release();

    auto bind_exp = impl_->configured.create_bindings();
    if (!bind_exp) {
        throw std::runtime_error(
            "HailoInference: create_bindings failed: " +
            std::to_string(static_cast<int>(bind_exp.status())));
    }
    impl_->bindings = bind_exp.release();

    // Size and wire input buffer — contract with caller: RGB 640*640*3 bytes.
    size_t expected_in = static_cast<size_t>(kInputWidth) * kInputHeight * 3;
    size_t in_frame_size = 0;
    {
        auto input_exp = impl_->infer_model->input();
        if (!input_exp) {
            throw std::runtime_error(
                "HailoInference: infer_model.input() failed: " +
                std::to_string(static_cast<int>(input_exp.status())));
        }
        auto input = input_exp.release();
        in_frame_size = input.get_frame_size();
    }
    if (in_frame_size != expected_in) {
        throw std::runtime_error(
            "HailoInference: model input frame size " +
            std::to_string(in_frame_size) + " != expected " +
            std::to_string(expected_in) +
            " — HEF isn't the 640x640 RGB yolov11l we built against.");
    }
    impl_->input_buffer.allocate(expected_in);

    {
        auto in_bind_exp = impl_->bindings.input();
        if (!in_bind_exp) {
            throw std::runtime_error("HailoInference: bindings.input() failed");
        }
        auto in_bind = in_bind_exp.release();
        auto set_in = in_bind.set_buffer(MemoryView(
            impl_->input_buffer.ptr, impl_->input_buffer.size));
        if (HAILO_SUCCESS != set_in) {
            throw std::runtime_error(
                "HailoInference: bindings input set_buffer failed: " +
                std::to_string(static_cast<int>(set_in)));
        }
    }

    // Size and wire output buffer. For NMS_BY_CLASS / FLOAT32, libhailort
    // returns a per-class packed layout:
    //   for each of `num_classes`: float32 count; hailo_bbox_float32_t[count]
    // The per-class block is padded to max_bboxes_per_class. We let
    // libhailort report the total size via get_frame_size and derive the
    // shape from get_nms_shape().
    size_t out_frame_size = 0;
    {
        auto output_exp = impl_->infer_model->output();
        if (!output_exp) {
            throw std::runtime_error(
                "HailoInference: infer_model.output() (2) failed: " +
                std::to_string(static_cast<int>(output_exp.status())));
        }
        auto output = output_exp.release();
        impl_->output_name = output.name();
        out_frame_size = output.get_frame_size();

        auto nms_shape_exp = output.get_nms_shape();
        if (!nms_shape_exp) {
            throw std::runtime_error(
                "HailoInference: get_nms_shape failed (HEF not NMS?): " +
                std::to_string(static_cast<int>(nms_shape_exp.status())));
        }
        auto nms_shape = nms_shape_exp.release();
        impl_->num_classes      = nms_shape.number_of_classes;
        impl_->max_bboxes_class = nms_shape.max_bboxes_per_class;
    }
    impl_->output_buffer.allocate(out_frame_size);

    {
        auto out_bind_exp = impl_->bindings.output();
        if (!out_bind_exp) {
            throw std::runtime_error("HailoInference: bindings.output() failed");
        }
        auto out_bind = out_bind_exp.release();
        // MemoryView sized at the real frame size (libhailort writes only
        // that many bytes); the mmap backing is page-padded so any tail-page
        // scribble lands in safe padding.
        auto set_out = out_bind.set_buffer(MemoryView(
            impl_->output_buffer.ptr, impl_->output_buffer.size));
        if (HAILO_SUCCESS != set_out) {
            throw std::runtime_error(
                "HailoInference: bindings output set_buffer failed: " +
                std::to_string(static_cast<int>(set_out)));
        }
    }

    std::cerr << "hailo: configured yolov11l — "
              << impl_->num_classes << " classes, up to "
              << impl_->max_bboxes_class << " bboxes/class, "
              << "input=" << expected_in << "B, output=" << out_frame_size << "B\n";
}

HailoInference::~HailoInference() = default;

bool HailoInference::Infer(const uint8_t* rgb,
                           std::vector<HailoDetection>& out,
                           float score_threshold)
{
    out.clear();

    std::lock_guard<std::mutex> lock(mu_);

    // Copy the caller's RGB into our pinned input buffer. The bindings
    // captured the pointer at init time — we overwrite the bytes in
    // place. For the multi_process_service path, calling create_bindings()
    // per frame leaks server-side handles and triggers HAILO_INTERNAL_FAILURE
    // (status 8) after a few frames, which cascades into HAILO_STREAM_ABORT
    // (status 63) for every subsequent request.
    std::memcpy(impl_->input_buffer.ptr, rgb, impl_->input_buffer.size);

    // Re-set the buffer views on the existing Bindings each call. This is
    // cheap (just updates the MemoryView inside the existing InferStream
    // handle — no server-side allocation) and fixes the "all-zero output"
    // issue the direct VDevice path had when we only set the buffer once
    // at init.
    {
        auto in_bind_exp = impl_->bindings.input();
        if (!in_bind_exp) return false;
        auto in_bind = in_bind_exp.release();
        auto s = in_bind.set_buffer(MemoryView(impl_->input_buffer.ptr,
                                               impl_->input_buffer.size));
        if (s != HAILO_SUCCESS) return false;
    }
    {
        auto out_bind_exp = impl_->bindings.output();
        if (!out_bind_exp) return false;
        auto out_bind = out_bind_exp.release();
        auto s = out_bind.set_buffer(MemoryView(impl_->output_buffer.ptr,
                                                impl_->output_buffer.size));
        if (s != HAILO_SUCCESS) return false;
    }

    // Fire the async job and wait for it — same pattern as the hailort
    // basic example. An earlier attempt used the sync `run()` API which
    // returned HAILO_SUCCESS but produced an all-zero output buffer every
    // frame; async with explicit wait actually fills the output.
    auto wait_ready = impl_->configured.wait_for_async_ready(
        std::chrono::milliseconds(1000));
    if (HAILO_SUCCESS != wait_ready) {
        std::cerr << "hailo: wait_for_async_ready failed: "
                  << static_cast<int>(wait_ready) << "\n";
        return false;
    }
    auto job_exp = impl_->configured.run_async(impl_->bindings);
    if (!job_exp) {
        std::cerr << "hailo: run_async failed: "
                  << static_cast<int>(job_exp.status()) << "\n";
        return false;
    }
    auto& job = job_exp.value();
    auto wait_status = job.wait(std::chrono::milliseconds(1000));
    if (HAILO_SUCCESS != wait_status) {
        std::cerr << "hailo: infer job wait failed: "
                  << static_cast<int>(wait_status) << "\n";
        return false;
    }

    // Parse NMS_BY_CLASS output. Layout per libhailort's nms_post_process.cpp
    // (write_bboxes_to_buffer): the buffer is COMPACT (variable-stride), NOT
    // the fixed-max-bboxes-per-class stride I originally assumed.
    //
    //   Class c's count lives at offset:
    //       4*c + 20 * (sum of detection counts in classes [0, c))
    //   Class c's bboxes live immediately after that count:
    //       4*(c+1) + 20 * (sum of detection counts in classes [0, c))
    //
    // Walking in class order, we can accumulate the running bbox-offset as
    // we go.
    const uint8_t* p = impl_->output_buffer.ptr;
    uint32_t dets_accumulated = 0;

    out.reserve(64);  // typical frame has <64 detections total
    for (uint32_t c = 0; c < impl_->num_classes; ++c) {
        size_t count_offset = 4 * static_cast<size_t>(c) +
                              sizeof(HailoBboxF32) * dets_accumulated;
        if (count_offset + sizeof(float) > impl_->output_buffer.size) break;

        float count_f;
        std::memcpy(&count_f, p + count_offset, sizeof(float));
        uint32_t count = static_cast<uint32_t>(count_f);
        if (count == 0) continue;
        if (count > impl_->max_bboxes_class) {
            // Defensive: malformed output shouldn't happen but skip rather
            // than overrun.
            break;
        }

        size_t bboxes_offset = count_offset + sizeof(float);
        if (bboxes_offset + count * sizeof(HailoBboxF32) > impl_->output_buffer.size) break;

        const HailoBboxF32* bboxes =
            reinterpret_cast<const HailoBboxF32*>(p + bboxes_offset);
        for (uint32_t i = 0; i < count; ++i) {
            const HailoBboxF32& b = bboxes[i];
            if (b.score < score_threshold) continue;

            HailoDetection det;
            det.class_id    = static_cast<int>(c);
            det.confidence  = b.score;
            det.x_min       = b.x_min;
            det.y_min       = b.y_min;
            det.x_max       = b.x_max;
            det.y_max       = b.y_max;
            out.push_back(det);
        }
        dets_accumulated += count;
    }

    return true;
}

#else // FNVR_HAS_HAILO

// Stubs for dev builds without libhailort installed. The pipeline code
// checks cam_.detector_backend at runtime and only takes the hailo path
// when explicitly requested — on a stub build, any camera with
// detector_backend="hailo" will hit the Instance() call below and get a
// loud failure, which the caller (hailo_probe_ctx_new) converts into a
// "run without detections" fallback for that camera.

struct HailoInference::Impl {};

HailoInference& HailoInference::Instance(const std::string&) {
    throw std::runtime_error(
        "HailoInference: this build of pipeline-supervisor has no libhailort. "
        "Install HailoRT via deploy/hailo/install-hailo-host.sh and rebuild.");
}

HailoInference::HailoInference(const std::string&) : impl_() {}
HailoInference::~HailoInference() = default;
bool HailoInference::Infer(const uint8_t*, std::vector<HailoDetection>&, float) {
    return false;
}

#endif // FNVR_HAS_HAILO

} // namespace fnvr

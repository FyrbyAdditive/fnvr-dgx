#include "hailo_inference.h"

#include <atomic>
#include <cassert>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <future>
#include <iostream>
#include <mutex>
#include <queue>
#include <stdexcept>
#include <thread>
#include <vector>

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

// Hailo-side batch size. Libhailort submits up to this many frames in one
// `run_async(vector<Bindings>)` call; the inference thread drains
// concurrent client requests into a batch of up to this size without
// blocking for more frames to arrive.
//
// 4 matches a common sweet spot on Hailo-8L for yolov11l — hits pipeline
// parallelism without starving any slot. Bump if you find >=4 hailo
// cameras reliably saturating the device.
static constexpr size_t kMaxBatch = 4;

// Backpressure: max outstanding requests waiting on the inference thread.
// Beyond this, Infer() returns false immediately rather than pile up 1.2MB
// RGB frames while the accelerator stalls.
static constexpr size_t kMaxQueued = 16;

// mmap-backed page-aligned scratch buffer. libhailort requires PAGE_SIZE
// alignment for output buffers (otherwise tail corruption) and strongly
// prefers it for inputs (DMA-mappable vs. bounce-copy).
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

    // Moveable so we can hold a PageAlignedBuffer inside a Slot that
    // itself lives in a std::vector. Move-from zeroes the source so its
    // destructor is a no-op.
    PageAlignedBuffer(PageAlignedBuffer&& other) noexcept
        : ptr(other.ptr), size(other.size), capacity(other.capacity) {
        other.ptr = nullptr;
        other.size = 0;
        other.capacity = 0;
    }
    PageAlignedBuffer& operator=(PageAlignedBuffer&& other) noexcept {
        if (this != &other) {
            free();
            ptr = other.ptr; size = other.size; capacity = other.capacity;
            other.ptr = nullptr; other.size = 0; other.capacity = 0;
        }
        return *this;
    }
};

// hailo_bbox_float32_t layout, packed. Kept local so hailo_inference.h
// stays hailort-free for downstream consumers.
struct HailoBboxF32 {
    float y_min;
    float x_min;
    float y_max;
    float x_max;
    float score;
};
static_assert(sizeof(HailoBboxF32) == 5 * sizeof(float),
              "HailoBboxF32 must be packed");

// One batch position: private input + output scratch + a persistent
// Bindings pointing at them. Bindings are created once during Impl ctor
// via configured_.create_bindings(); each inference cycle re-set_buffer's
// them so libhailort sees the same pointers but we keep the known-good
// "single-call" contract.
struct Slot {
    PageAlignedBuffer                   input;
    PageAlignedBuffer                   output;
    ConfiguredInferModel::Bindings      bindings;
};

// A single enqueued inference request. Owned by the client thread via
// the future; the inference thread fulfils the promise after batching.
struct Request {
    const uint8_t*                     rgb;
    std::vector<HailoDetection>*       out;   // caller-owned
    float                              score_threshold;
    std::promise<bool>                 done;
};

struct HailoInference::Impl {
    std::unique_ptr<VDevice>            vdevice;
    std::shared_ptr<InferModel>         infer_model;
    ConfiguredInferModel                configured;
    std::vector<Slot>                   slots;  // kMaxBatch entries

    // Decoded NMS shape — same for every slot.
    uint32_t                            num_classes      = 0;
    uint32_t                            max_bboxes_class = 0;

    // Request queue + signalling.
    std::queue<std::unique_ptr<Request>> queue;
    std::mutex                          q_mu;
    std::condition_variable             q_cv;
    std::atomic<bool>                   stop{false};
    std::thread                         inference_thread;

    // Parses one slot's output buffer into `out`. Uses the compact
    // variable-stride NMS_BY_CLASS layout libhailort actually writes (per
    // libhailort's nms_post_process.cpp::write_bboxes_to_buffer): class c's
    // count lives at offset `4*c + 20 * sum(prior_counts)`; bboxes follow.
    void parse_nms(const uint8_t* p, size_t out_size,
                   std::vector<HailoDetection>& out, float score_threshold) const
    {
        out.clear();
        out.reserve(64);
        uint32_t dets_accumulated = 0;
        for (uint32_t c = 0; c < num_classes; ++c) {
            size_t count_offset = 4 * static_cast<size_t>(c) +
                                  sizeof(HailoBboxF32) * dets_accumulated;
            if (count_offset + sizeof(float) > out_size) break;

            float count_f;
            std::memcpy(&count_f, p + count_offset, sizeof(float));
            uint32_t count = static_cast<uint32_t>(count_f);
            if (count == 0) continue;
            if (count > max_bboxes_class) break;

            size_t bboxes_offset = count_offset + sizeof(float);
            if (bboxes_offset + count * sizeof(HailoBboxF32) > out_size) break;

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
    }

    // Runs on the dedicated inference thread. Drains up to kMaxBatch
    // requests per pass (blocking only for the first; subsequent drains
    // are opportunistic) and ships them through libhailort in one
    // `run_async(vector<Bindings>)` call.
    void RunLoop() {
        std::vector<std::unique_ptr<Request>> batch;
        batch.reserve(kMaxBatch);

        while (!stop.load()) {
            batch.clear();
            {
                std::unique_lock<std::mutex> lk(q_mu);
                q_cv.wait(lk, [&]{ return stop.load() || !queue.empty(); });
                if (stop.load() && queue.empty()) break;

                // Drain up to kMaxBatch without blocking.
                while (batch.size() < kMaxBatch && !queue.empty()) {
                    batch.emplace_back(std::move(queue.front()));
                    queue.pop();
                }
            }
            if (batch.empty()) continue;

            ProcessBatch(batch);
        }

        // Drain any remaining requests with false on shutdown.
        std::lock_guard<std::mutex> lk(q_mu);
        while (!queue.empty()) {
            queue.front()->done.set_value(false);
            queue.pop();
        }
    }

    void ProcessBatch(std::vector<std::unique_ptr<Request>>& batch) {
        const size_t n = batch.size();
        assert(n > 0 && n <= kMaxBatch);

        // Copy each request's RGB into its slot and point Bindings there.
        // set_buffer() each call — same pattern as the single-frame path,
        // which is what works against libhailort's internal state.
        for (size_t i = 0; i < n; ++i) {
            std::memcpy(slots[i].input.ptr, batch[i]->rgb, slots[i].input.size);
            {
                auto in_exp = slots[i].bindings.input();
                if (!in_exp) { FailBatch(batch); return; }
                auto in = in_exp.release();
                if (in.set_buffer(MemoryView(slots[i].input.ptr,
                                             slots[i].input.size)) != HAILO_SUCCESS) {
                    FailBatch(batch); return;
                }
            }
            {
                auto out_exp = slots[i].bindings.output();
                if (!out_exp) { FailBatch(batch); return; }
                auto out = out_exp.release();
                if (out.set_buffer(MemoryView(slots[i].output.ptr,
                                              slots[i].output.size)) != HAILO_SUCCESS) {
                    FailBatch(batch); return;
                }
            }
        }

        // Wait for pipeline capacity for `n` frames, then submit them all
        // in one run_async call. libhailort internally pipelines the N
        // frames through the HEF's 4 contexts.
        auto wait_ready = configured.wait_for_async_ready(
            std::chrono::milliseconds(1000), static_cast<uint32_t>(n));
        if (HAILO_SUCCESS != wait_ready) {
            std::cerr << "hailo: wait_for_async_ready(n=" << n << ") failed: "
                      << static_cast<int>(wait_ready) << "\n";
            FailBatch(batch); return;
        }

        std::vector<ConfiguredInferModel::Bindings> vb;
        vb.reserve(n);
        for (size_t i = 0; i < n; ++i) vb.push_back(slots[i].bindings);

        auto job_exp = configured.run_async(vb);
        if (!job_exp) {
            std::cerr << "hailo: run_async(batch=" << n << ") failed: "
                      << static_cast<int>(job_exp.status()) << "\n";
            FailBatch(batch); return;
        }
        auto& job = job_exp.value();
        auto wait_status = job.wait(std::chrono::milliseconds(1000));
        if (HAILO_SUCCESS != wait_status) {
            std::cerr << "hailo: batch job wait failed: "
                      << static_cast<int>(wait_status) << "\n";
            FailBatch(batch); return;
        }

        // Success — parse each slot's output into its owner's vector and
        // fulfil the promise.
        for (size_t i = 0; i < n; ++i) {
            parse_nms(slots[i].output.ptr, slots[i].output.size,
                      *batch[i]->out, batch[i]->score_threshold);
            batch[i]->done.set_value(true);
        }
    }

    void FailBatch(std::vector<std::unique_ptr<Request>>& batch) {
        for (auto& r : batch) {
            if (r) {
                r->out->clear();
                r->done.set_value(false);
            }
        }
    }
};

HailoInference& HailoInference::Instance(const std::string& hef_path) {
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

    // CRITICAL: set batch size BEFORE configure(). Without this the
    // configured model is batch-1 and the vector<Bindings> run_async
    // overload either errors or silently serialises.
    impl_->infer_model->set_batch_size(static_cast<uint16_t>(kMaxBatch));

    auto conf_exp = impl_->infer_model->configure();
    if (!conf_exp) {
        throw std::runtime_error(
            "HailoInference: configure(batch=" + std::to_string(kMaxBatch) +
            ") failed: " +
            std::to_string(static_cast<int>(conf_exp.status())));
    }
    impl_->configured = conf_exp.release();

    // Discover input/output sizes + NMS shape from the just-configured
    // model. These are the same for every slot.
    size_t expected_in = static_cast<size_t>(kInputWidth) * kInputHeight * 3;
    {
        auto input_exp = impl_->infer_model->input();
        if (!input_exp) {
            throw std::runtime_error(
                "HailoInference: infer_model.input() failed: " +
                std::to_string(static_cast<int>(input_exp.status())));
        }
        auto input = input_exp.release();
        size_t in_frame_size = input.get_frame_size();
        if (in_frame_size != expected_in) {
            throw std::runtime_error(
                "HailoInference: model input frame size " +
                std::to_string(in_frame_size) + " != expected " +
                std::to_string(expected_in) +
                " — HEF isn't the 640x640 RGB yolov11l we built against.");
        }
    }

    size_t out_frame_size = 0;
    {
        auto output_exp = impl_->infer_model->output();
        if (!output_exp) {
            throw std::runtime_error(
                "HailoInference: infer_model.output() failed: " +
                std::to_string(static_cast<int>(output_exp.status())));
        }
        auto output = output_exp.release();
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

    // Allocate slots: each gets its own input/output scratch + a fresh
    // Bindings pre-pointed at them. These persist for the lifetime of the
    // singleton.
    impl_->slots.resize(kMaxBatch);
    for (size_t i = 0; i < kMaxBatch; ++i) {
        impl_->slots[i].input.allocate(expected_in);
        impl_->slots[i].output.allocate(out_frame_size);

        auto bind_exp = impl_->configured.create_bindings();
        if (!bind_exp) {
            throw std::runtime_error(
                "HailoInference: create_bindings[" + std::to_string(i) +
                "] failed: " +
                std::to_string(static_cast<int>(bind_exp.status())));
        }
        impl_->slots[i].bindings = bind_exp.release();

        // Initial set_buffer so the bindings reference something real even
        // before the first Infer() memcpy. RunLoop will re-set before each
        // batch anyway, but this is cheap insurance.
        auto ib = impl_->slots[i].bindings.input().release();
        if (ib.set_buffer(MemoryView(impl_->slots[i].input.ptr,
                                     impl_->slots[i].input.size))
            != HAILO_SUCCESS) {
            throw std::runtime_error("HailoInference: initial input set_buffer failed");
        }
        auto ob = impl_->slots[i].bindings.output().release();
        if (ob.set_buffer(MemoryView(impl_->slots[i].output.ptr,
                                     impl_->slots[i].output.size))
            != HAILO_SUCCESS) {
            throw std::runtime_error("HailoInference: initial output set_buffer failed");
        }
    }

    std::cerr << "hailo: configured yolov11l — "
              << impl_->num_classes << " classes, up to "
              << impl_->max_bboxes_class << " bboxes/class, "
              << "batch_size=" << kMaxBatch << ", "
              << "input=" << expected_in << "B, output=" << out_frame_size << "B\n";

    // Spawn the inference thread last so Impl is fully constructed before
    // it could possibly see a request. (Impl::RunLoop is a member so it
    // captures `this` implicitly via the thread ctor.)
    impl_->inference_thread = std::thread(&Impl::RunLoop, impl_.get());
}

HailoInference::~HailoInference() {
    if (impl_) {
        impl_->stop.store(true);
        impl_->q_cv.notify_all();
        if (impl_->inference_thread.joinable()) {
            impl_->inference_thread.join();
        }
    }
}

bool HailoInference::Infer(const uint8_t* rgb,
                           std::vector<HailoDetection>& out,
                           float score_threshold)
{
    out.clear();

    auto req = std::make_unique<Request>();
    req->rgb = rgb;
    req->out = &out;
    req->score_threshold = score_threshold;
    auto fut = req->done.get_future();

    {
        std::lock_guard<std::mutex> lk(impl_->q_mu);
        if (impl_->stop.load()) return false;
        if (impl_->queue.size() >= kMaxQueued) {
            static std::atomic<int> warned{0};
            if (warned.fetch_add(1) % 100 == 0) {
                std::cerr << "broker: queue full (" << kMaxQueued
                          << ") — dropping request\n";
            }
            return false;
        }
        impl_->queue.push(std::move(req));
    }
    impl_->q_cv.notify_one();

    return fut.get();
}

#else // FNVR_HAS_HAILO

// Stubs for dev builds without libhailort installed.

struct HailoInference::Impl {};

HailoInference& HailoInference::Instance(const std::string&) {
    throw std::runtime_error(
        "HailoInference: this build has no libhailort. Install HailoRT "
        "and rebuild.");
}

HailoInference::HailoInference(const std::string&) : impl_() {}
HailoInference::~HailoInference() = default;
bool HailoInference::Infer(const uint8_t*, std::vector<HailoDetection>&, float) {
    return false;
}

#endif // FNVR_HAS_HAILO

} // namespace fnvr

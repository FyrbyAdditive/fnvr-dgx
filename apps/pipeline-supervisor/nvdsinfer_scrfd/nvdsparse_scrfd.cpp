// Custom nvinfer bbox parser for SCRFD-10G (insightface, ICLR'22).
//
// The ONNX (prepped by tools/model-prep/prep_scrfd.py) outputs, per
// stride s ∈ {8, 16, 32}:
//   score_{s} [(W/s)*(H/s)*2, 1]  — face probability per anchor
//   bbox_{s}  [(W/s)*(H/s)*2, 4]  — distances (l, t, r, b) from the
//                                   anchor centre, in stride units
//   kps_{s}   [(W/s)*(H/s)*2, 10] — 5 landmarks (NOT read here: stock
//     DS parsers can't attach per-object landmarks; ml-worker
//     re-detects them on the published crop — see
//     docs/architecture/face-id.md)
// 2 anchors per cell share a centre: cell = i/2, cx = (cell % W/s)*s.
// Parser owns NMS (cluster-mode=4 in scrfd.txt).
//
// The decode maths must stay in lockstep with the python twin
// apps/ml-worker/fnvr_ml/scrfd.py.
//
// Build: CUDA_VER=... make   (mirrors ../nvdsinfer_rfdetr)

#include <algorithm>
#include <cmath>
#include <cstring>
#include <string>
#include <vector>

#include "nvdsinfer_custom_impl.h"

namespace {

struct Det {
    float x1, y1, x2, y2, score;
};

float iou(const Det& a, const Det& b) {
    const float xx1 = std::max(a.x1, b.x1);
    const float yy1 = std::max(a.y1, b.y1);
    const float xx2 = std::min(a.x2, b.x2);
    const float yy2 = std::min(a.y2, b.y2);
    const float inter = std::max(0.f, xx2 - xx1) * std::max(0.f, yy2 - yy1);
    const float ua = (a.x2 - a.x1) * (a.y2 - a.y1) +
                     (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
    return ua > 0.f ? inter / ua : 0.f;
}

void nms(std::vector<Det>& dets, float thresh) {
    std::sort(dets.begin(), dets.end(),
              [](const Det& a, const Det& b) { return a.score > b.score; });
    std::vector<Det> keep;
    keep.reserve(dets.size());
    for (const auto& d : dets) {
        bool dup = false;
        for (const auto& k : keep) {
            if (iou(d, k) > thresh) { dup = true; break; }
        }
        if (!dup) keep.push_back(d);
    }
    dets.swap(keep);
}

const NvDsInferLayerInfo* findLayer(
    std::vector<NvDsInferLayerInfo> const& layers, const std::string& name) {
    for (const auto& l : layers) {
        if (l.layerName && name == l.layerName) return &l;
    }
    return nullptr;
}

}  // namespace

extern "C" bool NvDsInferParseCustomSCRFD(
    std::vector<NvDsInferLayerInfo> const& outputLayersInfo,
    NvDsInferNetworkInfo const& networkInfo,
    NvDsInferParseDetectionParams const& detectionParams,
    std::vector<NvDsInferObjectDetectionInfo>& objectList);

extern "C" bool NvDsInferParseCustomSCRFD(
    std::vector<NvDsInferLayerInfo> const& outputLayersInfo,
    NvDsInferNetworkInfo const& networkInfo,
    NvDsInferParseDetectionParams const& detectionParams,
    std::vector<NvDsInferObjectDetectionInfo>& objectList) {
    constexpr int kStrides[3] = {8, 16, 32};
    constexpr int kAnchors = 2;
    constexpr float kNmsIou = 0.4f;

    const float conf =
        detectionParams.numClassesConfigured > 0
            ? detectionParams.perClassPreclusterThreshold[0]
            : 0.4f;
    const float W = float(networkInfo.width);
    const float H = float(networkInfo.height);

    std::vector<Det> dets;
    for (int s : kStrides) {
        const auto* score =
            findLayer(outputLayersInfo, "score_" + std::to_string(s));
        const auto* bbox =
            findLayer(outputLayersInfo, "bbox_" + std::to_string(s));
        if (!score || !bbox || !score->buffer || !bbox->buffer) return false;
        const float* sc = static_cast<const float*>(score->buffer);
        const float* bb = static_cast<const float*>(bbox->buffer);
        const int cells_w = networkInfo.width / s;
        const int n = cells_w * int(networkInfo.height / s) * kAnchors;
        for (int i = 0; i < n; i++) {
            if (sc[i] < conf) continue;
            const int cell = i / kAnchors;
            const float cx = float(cell % cells_w) * float(s);
            const float cy = float(cell / cells_w) * float(s);
            Det d;
            d.x1 = std::max(0.f, cx - bb[i * 4 + 0] * float(s));
            d.y1 = std::max(0.f, cy - bb[i * 4 + 1] * float(s));
            d.x2 = std::min(W, cx + bb[i * 4 + 2] * float(s));
            d.y2 = std::min(H, cy + bb[i * 4 + 3] * float(s));
            d.score = sc[i];
            if (d.x2 - d.x1 < 2.f || d.y2 - d.y1 < 2.f) continue;
            dets.push_back(d);
        }
    }
    nms(dets, kNmsIou);

    objectList.reserve(dets.size());
    for (const auto& d : dets) {
        NvDsInferObjectDetectionInfo obj{};
        obj.classId = 0;
        obj.detectionConfidence = d.score;
        obj.left = d.x1;
        obj.top = d.y1;
        obj.width = d.x2 - d.x1;
        obj.height = d.y2 - d.y1;
        objectList.push_back(obj);
    }
    return true;
}

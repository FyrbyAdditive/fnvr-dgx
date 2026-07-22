// Custom nvinfer bbox parser for RF-DETR ONNX exports.
//
// RF-DETR is an NMS-free DETR: the export emits, per frame,
//   boxes  [Q, 4]  — cx, cy, w, h, normalised to [0, 1]
//   logits [Q, C]  — per-query class logits (sigmoid activation)
// Layer identification is by name when the export names its outputs
// (boxes/dets vs logits/labels/scores), falling back to trailing
// dimension (4 → boxes, else logits) for renamed exports. The dim
// heuristic alone would swap the two on a C==4 head, where both
// outputs end in 4. Confidence = sigmoid(max logit); one candidate
// per query; cluster-mode=4 (no clustering) downstream.
//
// Build: CUDA_VER=... make   (see Makefile — mirrors DeepStream-Yolo's)

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstring>
#include <string>
#include <vector>

#include "nvdsinfer_custom_impl.h"

static inline float sigmoidf(float x) { return 1.f / (1.f + std::exp(-x)); }

extern "C" bool NvDsInferParseCustomRFDETR(
    std::vector<NvDsInferLayerInfo> const& outputLayersInfo,
    NvDsInferNetworkInfo const& networkInfo,
    NvDsInferParseDetectionParams const& detectionParams,
    std::vector<NvDsInferObjectDetectionInfo>& objectList);

extern "C" bool NvDsInferParseCustomRFDETR(
    std::vector<NvDsInferLayerInfo> const& outputLayersInfo,
    NvDsInferNetworkInfo const& networkInfo,
    NvDsInferParseDetectionParams const& detectionParams,
    std::vector<NvDsInferObjectDetectionInfo>& objectList) {
    const NvDsInferLayerInfo* boxes = nullptr;
    const NvDsInferLayerInfo* logits = nullptr;

    // Names first — see header comment.
    for (const auto& l : outputLayersInfo) {
        if (!l.layerName) continue;
        std::string name(l.layerName);
        std::transform(name.begin(), name.end(), name.begin(),
                       [](unsigned char c) { return std::tolower(c); });
        if (!boxes && (name.find("box") != std::string::npos ||
                       name.find("dets") != std::string::npos)) {
            boxes = &l;
        } else if (!logits && (name.find("logit") != std::string::npos ||
                               name.find("label") != std::string::npos ||
                               name.find("score") != std::string::npos ||
                               name.find("class") != std::string::npos)) {
            logits = &l;
        }
    }
    // Trailing-dim fallback for exports whose names matched neither.
    for (const auto& l : outputLayersInfo) {
        if (&l == boxes || &l == logits) continue;
        if (l.inferDims.numDims < 1) continue;
        const unsigned last = l.inferDims.d[l.inferDims.numDims - 1];
        if (last == 4 && !boxes) boxes = &l;
        else if (!logits) logits = &l;
        else if (last != 4 && l.inferDims.numDims >= 2) logits = &l;
    }
    if (!boxes || !logits || boxes == logits ||
        !boxes->buffer || !logits->buffer) return false;

    // Trailing-dim products give Q and C robustly across [Q,C] vs
    // [1,Q,C] exports (nvinfer strips the batch dim, but be safe).
    unsigned qb = 1, qc = 1;
    for (int i = 0; i < boxes->inferDims.numDims - 1; i++) qb *= boxes->inferDims.d[i];
    const unsigned C = logits->inferDims.d[logits->inferDims.numDims - 1];
    for (int i = 0; i < logits->inferDims.numDims - 1; i++) qc *= logits->inferDims.d[i];
    const unsigned Q = std::min(qb, qc);
    if (Q == 0 || C == 0) return false;

    const float* b = static_cast<const float*>(boxes->buffer);
    const float* s = static_cast<const float*>(logits->buffer);
    const float W = float(networkInfo.width);
    const float H = float(networkInfo.height);

    objectList.reserve(Q / 4);
    for (unsigned q = 0; q < Q; q++) {
        // Per-query best class.
        unsigned best = 0;
        float best_logit = s[q * C];
        for (unsigned c = 1; c < C; c++) {
            const float v = s[q * C + c];
            if (v > best_logit) { best_logit = v; best = c; }
        }
        const float conf = sigmoidf(best_logit);
        float thr = 0.3f;
        if (best < detectionParams.perClassPreclusterThreshold.size()) {
            thr = detectionParams.perClassPreclusterThreshold[best];
        }
        if (conf < thr) continue;

        const float cx = b[q * 4 + 0] * W;
        const float cy = b[q * 4 + 1] * H;
        const float bw = b[q * 4 + 2] * W;
        const float bh = b[q * 4 + 3] * H;

        NvDsInferObjectDetectionInfo obj{};
        obj.classId = best;
        obj.detectionConfidence = conf;
        obj.left   = std::max(0.f, cx - bw / 2.f);
        obj.top    = std::max(0.f, cy - bh / 2.f);
        obj.width  = std::min(W - obj.left, bw);
        obj.height = std::min(H - obj.top, bh);
        if (obj.width <= 0 || obj.height <= 0) continue;
        objectList.push_back(obj);
    }
    return true;
}

CHECK_CUSTOM_PARSE_FUNC_PROTOTYPE(NvDsInferParseCustomRFDETR);

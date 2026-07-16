// Custom nvinfer parsers for the global ANPR stack (replaces the
// US-only TAO LPDNet/LPRNet pair):
//
//  NvDsInferParseCustomPlateDet — open-image-models yolo-v9-t
//    "*-license-plate-end2end" ONNX. EfficientNMS is baked into the
//    graph, so the outputs are already final:
//      num_dets [1], det_boxes [N,4] (xyxy, input pixels),
//      det_scores [N], det_classes [N]
//    Identified by name substring, with dim-shape fallbacks.
//
//  NvDsInferParsePlateOCRCCT — fast-plate-ocr v2 CCT models. Output is
//    [max_plate_slots, alphabet_len] per-slot char probabilities
//    (possibly flattened). Decode = per-slot argmax → charset lookup,
//    skip pad char, mean confidence. The charset is read ONCE from
//    /var/lib/fnvr/models/anpr/plateocr.labels — generated at image
//    build FROM THE MODEL'S OWN CONFIG (hand-typed charsets produce
//    plausible-but-wrong plates). The decoded string is attached as a
//    single classifier attribute so the pipeline's extractPlateText()
//    keeps working unchanged.

#include <algorithm>
#include <cmath>
#include <cstring>
#include <fstream>
#include <mutex>
#include <string>
#include <vector>

#include "nvdsinfer_custom_impl.h"

// ---------------------------------------------------------------------------
// Plate detector (end2end / EfficientNMS outputs)
// ---------------------------------------------------------------------------

extern "C" bool NvDsInferParseCustomPlateDet(
    std::vector<NvDsInferLayerInfo> const& outputLayersInfo,
    NvDsInferNetworkInfo const& networkInfo,
    NvDsInferParseDetectionParams const& detectionParams,
    std::vector<NvDsInferObjectDetectionInfo>& objectList);

extern "C" bool NvDsInferParseCustomPlateDet(
    std::vector<NvDsInferLayerInfo> const& outputLayersInfo,
    NvDsInferNetworkInfo const& networkInfo,
    NvDsInferParseDetectionParams const& detectionParams,
    std::vector<NvDsInferObjectDetectionInfo>& objectList) {
    const NvDsInferLayerInfo* num_dets = nullptr;
    const NvDsInferLayerInfo* det_boxes = nullptr;
    const NvDsInferLayerInfo* det_scores = nullptr;
    const NvDsInferLayerInfo* det_classes = nullptr;

    auto nameHas = [](const NvDsInferLayerInfo& l, const char* s) {
        return l.layerName && std::strstr(l.layerName, s) != nullptr;
    };
    for (const auto& l : outputLayersInfo) {
        if (nameHas(l, "num")) num_dets = &l;
        else if (nameHas(l, "box")) det_boxes = &l;
        else if (nameHas(l, "score")) det_scores = &l;
        else if (nameHas(l, "class")) det_classes = &l;
    }
    // Dim-based fallback if the export renamed things.
    for (const auto& l : outputLayersInfo) {
        const unsigned last = l.inferDims.numDims
            ? l.inferDims.d[l.inferDims.numDims - 1] : 0;
        if (!det_boxes && last == 4) det_boxes = &l;
    }

    const float W = float(networkInfo.width);
    const float H = float(networkInfo.height);
    float thr0 = 0.3f;
    if (!detectionParams.perClassPreclusterThreshold.empty())
        thr0 = detectionParams.perClassPreclusterThreshold[0];

    // Single-tensor end2end conventions (open-image-models yolo-v9-t
    // exports "output0" [N,7]: batch_idx, x1, y1, x2, y2, class, score;
    // some exports use [N,6] without the batch column).
    //
    // IMPORTANT: this function must NEVER return false — DS 9.1's
    // "Failed to parse bboxes" error path has a fatal free() (SIGSEGV
    // observed under gdb). Unknown layouts log once and yield an empty
    // detection list instead.
    if (outputLayersInfo.size() == 1 || (!det_scores && !det_boxes)) {
        const NvDsInferLayerInfo& out = outputLayersInfo[0];
        if (!out.buffer || out.inferDims.numDims < 1) return true;
        const unsigned last = out.inferDims.d[out.inferDims.numDims - 1];
        if (last != 6 && last != 7) {
            static bool warned = false;
            if (!warned) {
                warned = true;
                fprintf(stderr,
                        "plates parser: unexpected detector output width %u "
                        "(want 6 or 7) — emitting no plates\n", last);
            }
            return true;
        }
        unsigned N = 1;
        for (int i = 0; i < out.inferDims.numDims - 1; i++)
            N *= out.inferDims.d[i];
        const float* p = static_cast<const float*>(out.buffer);
        const unsigned stride = last;
        const unsigned off = (last == 7) ? 1 : 0;  // skip batch_idx col
        for (unsigned i = 0; i < N; i++) {
            const float* r = p + i * stride;
            // Column order after xyxy varies: [.., class, score] vs
            // [.., score, class]. The class column is integral (0.0 for
            // this single-class model); pick the other as confidence.
            float a = r[off + 4], b = r[off + 5];
            float conf = (last == 6) ? a
                         : (std::floor(a) == a && b >= 0.f && b <= 1.f) ? b
                         : a;
            if (!(conf > thr0) || conf > 1.f) continue;  // also drops NaN
            float x1 = r[off + 0], y1 = r[off + 1];
            float x2 = r[off + 2], y2 = r[off + 3];
            if (x2 <= 1.5f && y2 <= 1.5f) { x1 *= W; x2 *= W; y1 *= H; y2 *= H; }
            NvDsInferObjectDetectionInfo obj{};
            obj.classId = 0;
            obj.detectionConfidence = conf;
            obj.left   = std::max(0.f, x1);
            obj.top    = std::max(0.f, y1);
            obj.width  = std::min(W - obj.left, x2 - x1);
            obj.height = std::min(H - obj.top, y2 - y1);
            if (obj.width <= 0 || obj.height <= 0) continue;
            objectList.push_back(obj);
        }
        return true;
    }

    if (!det_boxes || !det_scores || !det_boxes->buffer || !det_scores->buffer)
        return true;  // never false — see comment above

    unsigned N = 1;
    for (int i = 0; i < det_boxes->inferDims.numDims - 1; i++)
        N *= det_boxes->inferDims.d[i];
    if (num_dets && num_dets->buffer) {
        const int nd = static_cast<const int*>(num_dets->buffer)[0];
        if (nd >= 0 && unsigned(nd) < N) N = unsigned(nd);
    }

    const float* boxes = static_cast<const float*>(det_boxes->buffer);
    const float* scores = static_cast<const float*>(det_scores->buffer);
    (void)det_classes;  // single-class model; kept for the quad shape

    for (unsigned i = 0; i < N; i++) {
        const float conf = scores[i];
        if (conf < thr0) continue;
        float x1 = boxes[i * 4 + 0];
        float y1 = boxes[i * 4 + 1];
        float x2 = boxes[i * 4 + 2];
        float y2 = boxes[i * 4 + 3];
        // Some exports emit normalised boxes; scale if so.
        if (x2 <= 1.5f && y2 <= 1.5f) { x1 *= W; x2 *= W; y1 *= H; y2 *= H; }
        NvDsInferObjectDetectionInfo obj{};
        obj.classId = 0;  // single class: plate
        obj.detectionConfidence = conf;
        obj.left   = std::max(0.f, x1);
        obj.top    = std::max(0.f, y1);
        obj.width  = std::min(W - obj.left, x2 - x1);
        obj.height = std::min(H - obj.top, y2 - y1);
        if (obj.width <= 0 || obj.height <= 0) continue;
        objectList.push_back(obj);
    }
    return true;
}

CHECK_CUSTOM_PARSE_FUNC_PROTOTYPE(NvDsInferParseCustomPlateDet);

// ---------------------------------------------------------------------------
// Plate OCR (fast-plate-ocr CCT: fixed slots × charset)
// ---------------------------------------------------------------------------

static const std::vector<std::string>& charset() {
    static std::vector<std::string> cs;
    static std::once_flag once;
    std::call_once(once, [] {
        const char* path = std::getenv("FNVR_PLATE_CHARSET");
        std::ifstream f(path && *path
                            ? path
                            : "/var/lib/fnvr/models/anpr/plateocr.labels");
        std::string line;
        while (std::getline(f, line)) {
            while (!line.empty() && (line.back() == '\r' || line.back() == '\n'))
                line.pop_back();
            cs.push_back(line);  // may be empty for a literal blank char
        }
    });
    return cs;
}

extern "C" bool NvDsInferParsePlateOCRCCT(
    std::vector<NvDsInferLayerInfo> const& outputLayersInfo,
    NvDsInferNetworkInfo const& networkInfo,
    float classifierThreshold,
    std::vector<NvDsInferAttribute>& attrList,
    std::string& descString);

extern "C" bool NvDsInferParsePlateOCRCCT(
    std::vector<NvDsInferLayerInfo> const& outputLayersInfo,
    NvDsInferNetworkInfo const& /*networkInfo*/,
    float classifierThreshold,
    std::vector<NvDsInferAttribute>& attrList,
    std::string& descString) {
    // Never return false — DS 9.1's classifier parse-failure path is
    // as fragile as the detector one. No decode → no attribute.
    const auto& cs = charset();
    if (cs.empty() || outputLayersInfo.empty()) return true;
    const unsigned C = unsigned(cs.size());

    // v2 global models emit TWO heads: "plate" [slots, C] and "region"
    // (plate-origin classifier). Pick by name, falling back to the
    // first layer whose element count divides by the charset size.
    const NvDsInferLayerInfo* out = nullptr;
    for (const auto& l : outputLayersInfo) {
        if (l.layerName && std::strcmp(l.layerName, "plate") == 0 && l.buffer) {
            out = &l;
            break;
        }
    }
    if (!out) {
        for (const auto& l : outputLayersInfo) {
            if (!l.buffer) continue;
            unsigned t = 1;
            for (int i = 0; i < l.inferDims.numDims; i++) t *= l.inferDims.d[i];
            if (t % C == 0 && t / C >= 4) { out = &l; break; }
        }
    }
    if (!out) return true;

    unsigned total = 1;
    for (int i = 0; i < out->inferDims.numDims; i++) total *= out->inferDims.d[i];
    if (C == 0 || total % C != 0) return true;
    const unsigned slots = total / C;
    const float* p = static_cast<const float*>(out->buffer);

    std::string plate;
    float conf_sum = 0.f;
    unsigned chars = 0;
    for (unsigned s = 0; s < slots; s++) {
        unsigned best = 0;
        float best_v = p[s * C];
        for (unsigned c = 1; c < C; c++) {
            if (p[s * C + c] > best_v) { best_v = p[s * C + c]; best = c; }
        }
        // Model may emit probabilities or logits; normalise defensively
        // for the confidence figure (argmax is invariant).
        float conf = best_v;
        if (best_v > 1.f || best_v < 0.f) {
            float denom = 0.f;
            for (unsigned c = 0; c < C; c++)
                denom += std::exp(p[s * C + c] - best_v);
            conf = 1.f / denom;
        }
        const std::string& ch = cs[best];
        if (ch == "_" || ch.empty()) continue;  // pad slot
        plate += ch;
        conf_sum += conf;
        chars++;
    }
    if (chars == 0) return true;  // nothing decoded; no attribute
    const float mean_conf = conf_sum / float(chars);
    if (mean_conf < classifierThreshold) return true;

    NvDsInferAttribute attr{};
    attr.attributeIndex = 0;
    attr.attributeValue = 1;
    attr.attributeConfidence = mean_conf;
    attr.attributeLabel = strdup(plate.c_str());  // freed by nvinfer
    attrList.push_back(attr);
    descString = plate;
    return true;
}

CHECK_CUSTOM_CLASSIFIER_PARSE_FUNC_PROTOTYPE(NvDsInferParsePlateOCRCCT);

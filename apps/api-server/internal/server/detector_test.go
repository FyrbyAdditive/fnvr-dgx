package server

import (
	"strings"
	"testing"

	"github.com/fnvr/fnvr/apps/api-server/internal/settings"
)

// The clobber regression: a client that predates interval /
// inference_backend sends only the six fields it knows. Those two must
// survive the round-trip untouched.
func TestMergeDetectorKeepsOmittedFields(t *testing.T) {
	cur := settings.Detector{
		ModelFamily:      "rfdetr",
		RFDETRVariant:    "base",
		YoloVariant:      "yolo26x",
		YoloPrecision:    "fp16",
		AnprEnabled:      true,
		FaceIDEnabled:    true,
		InferenceBackend: "triton",
		Interval:         2,
	}
	legacyBody := `{"model_family":"rfdetr","rfdetr_variant":"base",
		"yolo26_variant":"yolo26x","yolo26_precision":"fp16",
		"anpr_enabled":false,"face_id_enabled":true}`
	got, err := mergeDetector(cur, strings.NewReader(legacyBody))
	if err != nil {
		t.Fatal(err)
	}
	if got.InferenceBackend != "triton" {
		t.Errorf("inference_backend clobbered: got %q want triton", got.InferenceBackend)
	}
	if got.Interval != 2 {
		t.Errorf("interval clobbered: got %d want 2", got.Interval)
	}
	if got.AnprEnabled {
		t.Error("anpr_enabled: explicit false in body must apply")
	}
}

func TestMergeDetectorExplicitZeroApplies(t *testing.T) {
	cur := settings.Detector{InferenceBackend: "triton", Interval: 3}
	got, err := mergeDetector(cur, strings.NewReader(`{"interval":0,"inference_backend":"nvinfer"}`))
	if err != nil {
		t.Fatal(err)
	}
	if got.Interval != 0 {
		t.Errorf("explicit interval 0: got %d", got.Interval)
	}
	if got.InferenceBackend != "nvinfer" {
		t.Errorf("explicit backend: got %q", got.InferenceBackend)
	}
}

func TestMergeDetectorBadJSON(t *testing.T) {
	cur := settings.Detector{Interval: 1}
	got, err := mergeDetector(cur, strings.NewReader(`{nope`))
	if err == nil {
		t.Fatal("want error on bad json")
	}
	if got.Interval != 1 {
		t.Error("bad json must return current settings unchanged")
	}
}

package settings

import (
	"strings"
	"testing"
)

func validDetector() Detector {
	return Detector{
		ModelFamily:      "rfdetr",
		RFDETRVariant:    "base",
		YoloVariant:      "yolo26x",
		YoloPrecision:    "fp16",
		InferenceBackend: "nvinfer",
		Interval:         0,
	}
}

func TestDetectorValidate(t *testing.T) {
	cases := []struct {
		name    string
		mutate  func(*Detector)
		wantErr string // "" = valid
	}{
		{"baseline valid", func(d *Detector) {}, ""},
		{"triton with rfdetr ok", func(d *Detector) { d.InferenceBackend = "triton" }, ""},
		{"triton with yolo26 rejected", func(d *Detector) {
			d.InferenceBackend = "triton"
			d.ModelFamily = "yolo26"
		}, "requires model_family=rfdetr"},
		{"empty backend normalised", func(d *Detector) { d.InferenceBackend = "" }, ""},
		{"bogus backend", func(d *Detector) { d.InferenceBackend = "tensorflow" }, "invalid inference_backend"},
		{"fp8 rejected", func(d *Detector) { d.YoloPrecision = "fp8" }, "invalid yolo26_precision"},
		{"nvfp4 rejected", func(d *Detector) { d.YoloPrecision = "nvfp4" }, "invalid yolo26_precision"},
		{"int8 ok", func(d *Detector) { d.YoloPrecision = "int8" }, ""},
		{"interval below range", func(d *Detector) { d.Interval = -1 }, "invalid interval"},
		{"interval above range", func(d *Detector) { d.Interval = 5 }, "invalid interval"},
		{"interval max ok", func(d *Detector) { d.Interval = 4 }, ""},
		{"custom fnvr variant ok", func(d *Detector) { d.YoloVariant = "fnvr-v2" }, ""},
		{"bogus variant", func(d *Detector) { d.YoloVariant = "yolov8n" }, "invalid yolo26_variant"},
		{"bogus family", func(d *Detector) { d.ModelFamily = "detr" }, "invalid model_family"},
		{"bogus rfdetr variant", func(d *Detector) { d.RFDETRVariant = "xl" }, "invalid rfdetr_variant"},
	}
	for _, c := range cases {
		d := validDetector()
		c.mutate(&d)
		err := d.Validate()
		if c.wantErr == "" {
			if err != nil {
				t.Errorf("%s: unexpected error %v", c.name, err)
			}
			continue
		}
		if err == nil || !strings.Contains(err.Error(), c.wantErr) {
			t.Errorf("%s: got %v, want error containing %q", c.name, err, c.wantErr)
		}
	}
}

func TestDetectorValidateNormalises(t *testing.T) {
	d := validDetector()
	d.InferenceBackend = ""
	d.RFDETRVariant = ""
	if err := d.Validate(); err != nil {
		t.Fatal(err)
	}
	if d.InferenceBackend != "nvinfer" {
		t.Errorf("backend: got %q want nvinfer", d.InferenceBackend)
	}
	if d.RFDETRVariant != "base" {
		t.Errorf("rfdetr_variant: got %q want base", d.RFDETRVariant)
	}
}

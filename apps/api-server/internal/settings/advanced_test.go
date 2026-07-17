package settings

import (
	"encoding/json"
	"testing"
)

func specFor(t *testing.T, key string) AdvancedSpec {
	t.Helper()
	s, ok := advancedByKey[key]
	if !ok {
		t.Fatalf("key %q not in whitelist", key)
	}
	return s
}

func TestValidateAdvancedValue(t *testing.T) {
	cases := []struct {
		key   string
		raw   string
		valid bool
	}{
		// float range edges
		{"faces.match_threshold", "0.01", true},
		{"faces.match_threshold", "0.99", true},
		{"faces.match_threshold", "0.005", false},
		{"faces.match_threshold", "1.0", false},
		{"faces.match_threshold", `"0.5"`, false}, // string, not number
		{"storage.min_free_pct", "12.5", true},
		{"storage.min_free_pct", "50", true},
		{"storage.min_free_pct", "51", false},
		// int: rejects fractions and out-of-range
		{"detections.hot_hours", "24", true},
		{"detections.hot_hours", "168", true},
		{"detections.hot_hours", "0", false},
		{"detections.hot_hours", "24.5", false},
		{"detections.suppression_hamming_threshold", "8", true},
		{"detections.suppression_hamming_threshold", "17", false},
		// hh:mm
		{"ml.cluster.batch_schedule", `"03:00"`, true},
		{"ml.cluster.batch_schedule", `"23:59"`, true},
		{"ml.cluster.batch_schedule", `"3:05"`, true},
		{"ml.cluster.batch_schedule", `"25:99"`, false},
		{"ml.cluster.batch_schedule", `"0300"`, false},
		{"ml.cluster.batch_schedule", "300", false}, // number, not string
	}
	for _, c := range cases {
		err := validateAdvancedValue(specFor(t, c.key), json.RawMessage(c.raw))
		if c.valid && err != nil {
			t.Errorf("%s = %s: unexpected error %v", c.key, c.raw, err)
		}
		if !c.valid && err == nil {
			t.Errorf("%s = %s: expected error", c.key, c.raw)
		}
	}
}

func TestWhitelistCoversEveryKind(t *testing.T) {
	for _, spec := range AdvancedWhitelist {
		switch spec.Kind {
		case KindFloat, KindInt, KindHHMM:
		default:
			t.Errorf("%s: unknown kind %q", spec.Key, spec.Kind)
		}
		if spec.Default == nil {
			t.Errorf("%s: missing default", spec.Key)
		}
	}
}

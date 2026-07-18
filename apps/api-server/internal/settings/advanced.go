package settings

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
)

// Advanced settings: the whitelist of runtime tuning knobs that used to
// be psql-only. Each is consumed by a running service (event-processor,
// storage-manager, ml-worker) on its own reload cycle — no restart
// needed. Ranges mirror the consumers' own clamps so nothing the API
// accepts gets silently clamped downstream.

type AdvancedKind string

const (
	KindFloat AdvancedKind = "float"
	KindInt   AdvancedKind = "int"
	KindHHMM  AdvancedKind = "hhmm"
)

type AdvancedSpec struct {
	Key      string
	Kind     AdvancedKind
	Min, Max float64 // numeric kinds only
	Default  any
}

var AdvancedWhitelist = []AdvancedSpec{
	// Face matching (event-processor, ~30s reload).
	{Key: "faces.match_threshold", Kind: KindFloat, Min: 0.01, Max: 0.99, Default: 0.55},
	{Key: "faces.match_margin", Kind: KindFloat, Min: 0, Max: 0.5, Default: 0.05},
	{Key: "faces.negative_penalty_weight", Kind: KindFloat, Min: 0, Max: 2, Default: 1.0},
	// Detections (event-processor + api-server/storage-manager).
	{Key: "detections.suppression_hamming_threshold", Kind: KindInt, Min: 4, Max: 16, Default: 8},
	{Key: "detections.hot_hours", Kind: KindInt, Min: 1, Max: 168, Default: 24},
	// Face capture (pipeline probe; resolved at worker spawn — a
	// pipeline restart is required for changes to take effect).
	{Key: "faces.enrol.dedup_similarity", Kind: KindFloat, Min: 0.5, Max: 0.999, Default: 0.90},
	{Key: "faces.enrol.max_per_action", Kind: KindInt, Min: 1, Max: 50, Default: 8},
	{Key: "faces.enrol.min_det_score", Kind: KindFloat, Min: 0, Max: 0.99, Default: 0.5},
	{Key: "faces.enrol.max_abs_yaw", Kind: KindFloat, Min: 0.05, Max: 1.0, Default: 0.35},
	{Key: "faces.enrol.min_blur", Kind: KindFloat, Min: 0, Max: 500, Default: 30},
	{Key: "faces.capture.interval_ms", Kind: KindInt, Min: 250, Max: 10000, Default: 1500},
	{Key: "faces.capture.max_per_track", Kind: KindInt, Min: 1, Max: 100, Default: 12},
	{Key: "faces.capture.min_confidence", Kind: KindFloat, Min: 0, Max: 0.99, Default: 0.55},
	{Key: "faces.capture.min_px", Kind: KindInt, Min: 10, Max: 200, Default: 30},
	// Face thumbnail retention (storage-manager cycle). Floor of 8 days
	// is deliberate: enrolment sources (recent feed ≤168h, clusters
	// ≤7d) can never reference a thumb older than 7 days, so pruning
	// can never race an enrolment.
	{Key: "faces.thumbs_retention_days", Kind: KindInt, Min: 8, Max: 365, Default: 30},
	// Storage (storage-manager purge cycle).
	{Key: "storage.min_free_pct", Kind: KindFloat, Min: 0, Max: 50, Default: 10.0},
	// ML (ml-worker nightly scheduler).
	{Key: "ml.cluster.batch_schedule", Kind: KindHHMM, Default: "03:00"},
}

var advancedByKey = func() map[string]AdvancedSpec {
	m := make(map[string]AdvancedSpec, len(AdvancedWhitelist))
	for _, s := range AdvancedWhitelist {
		m[s.Key] = s
	}
	return m
}()

var hhmmRe = regexp.MustCompile(`^([01]?\d|2[0-3]):[0-5]\d$`)

// validateAdvancedValue checks one raw JSON value against its spec.
// Pure — unit tested without a DB.
func validateAdvancedValue(spec AdvancedSpec, raw json.RawMessage) error {
	switch spec.Kind {
	case KindFloat, KindInt:
		var v float64
		if err := json.Unmarshal(raw, &v); err != nil {
			return fmt.Errorf("%s: expected a number", spec.Key)
		}
		if spec.Kind == KindInt && v != float64(int64(v)) {
			return fmt.Errorf("%s: expected an integer", spec.Key)
		}
		if v < spec.Min || v > spec.Max {
			return fmt.Errorf("%s: %v out of range [%v, %v]", spec.Key, v, spec.Min, spec.Max)
		}
	case KindHHMM:
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return fmt.Errorf("%s: expected an HH:MM string", spec.Key)
		}
		if !hhmmRe.MatchString(s) {
			return fmt.Errorf("%s: %q is not a valid HH:MM time", spec.Key, s)
		}
	default:
		return fmt.Errorf("%s: unknown kind %q", spec.Key, spec.Kind)
	}
	return nil
}

// GetAdvanced returns every whitelisted key with its stored value, or
// its default when the row is missing or unparsable.
func (s *Store) GetAdvanced(ctx context.Context) (map[string]any, error) {
	out := make(map[string]any, len(AdvancedWhitelist))
	for _, spec := range AdvancedWhitelist {
		out[spec.Key] = spec.Default
		raw, err := s.Get(ctx, spec.Key)
		if err != nil {
			continue // missing → default; transient DB errors also fall back
		}
		if validateAdvancedValue(spec, raw) != nil {
			continue // out-of-range psql edits render as the default
		}
		var v any
		if json.Unmarshal(raw, &v) == nil {
			out[spec.Key] = v
		}
	}
	return out, nil
}

// SetAdvanced validates every provided key/value first (unknown keys
// are rejected outright), then writes only the provided keys.
func (s *Store) SetAdvanced(ctx context.Context, updates map[string]json.RawMessage) error {
	if len(updates) == 0 {
		return fmt.Errorf("no settings provided")
	}
	for key, raw := range updates {
		spec, ok := advancedByKey[key]
		if !ok {
			return fmt.Errorf("unknown setting %q", key)
		}
		if err := validateAdvancedValue(spec, raw); err != nil {
			return err
		}
	}
	for key, raw := range updates {
		if err := s.Set(ctx, key, raw); err != nil {
			return err
		}
	}
	return nil
}

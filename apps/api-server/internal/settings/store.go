// Package settings backs the system-wide key/value store used by the
// Settings page. Values are JSON blobs; each setting has a typed helper
// so the API handlers don't open-code validation.
package settings

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrNotFound = errors.New("setting not found")

type Store struct{ pool *pgxpool.Pool }

func NewStore(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// Get returns the raw JSON for a key. Callers that want typed access
// should use the helper methods below.
func (s *Store) Get(ctx context.Context, key string) (json.RawMessage, error) {
	var raw []byte
	err := s.pool.QueryRow(ctx,
		`SELECT value FROM settings WHERE key = $1`, key).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return raw, nil
}

// Set upserts a key's JSON value. No validation here — callers should
// use the typed helpers that validate before writing.
func (s *Store) Set(ctx context.Context, key string, value json.RawMessage) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO settings (key, value, updated_at)
		VALUES ($1, $2, NOW())
		ON CONFLICT (key) DO UPDATE
		  SET value = EXCLUDED.value, updated_at = NOW()`, key, value)
	return err
}

// --- typed helpers ---

// validYoloVariants is the whitelist of YOLO26 size suffixes. Anything
// else gets rejected at Set time so the pipeline entrypoint can trust
// the DB value without re-validating.
var validYoloVariants = map[string]struct{}{
	"yolo26n": {}, "yolo26s": {}, "yolo26m": {}, "yolo26l": {}, "yolo26x": {},
}
// INT8 is technically wired but hits an upstream TRT assertion during
// calibration on YOLO26 ONNX (see docs/known-issues.md). Disabled at
// the validator layer until resolved. Remove the "commented" entry to
// re-enable.
var validPrecisions = map[string]struct{}{
	"fp16": {},
	// "int8": {},  // disabled — see docs/known-issues.md
}

type Detector struct {
	YoloVariant   string `json:"yolo26_variant"`
	YoloPrecision string `json:"yolo26_precision"`
	// AnprEnabled toggles the LPDNet + LPRNet SGIE chain in the
	// pipeline. Off by default so the two extra nvinfer stages don't
	// eat GPU on installs that don't care about plates. Takes effect
	// on pipeline restart (Settings UI does this automatically).
	AnprEnabled bool `json:"anpr_enabled"`
}

// GetDetector reads the detector settings, falling back to defaults if a
// key is missing (e.g. after a fresh install before the migration's seed
// row runs — belt-and-braces).
func (s *Store) GetDetector(ctx context.Context) (Detector, error) {
	d := Detector{YoloVariant: "yolo26x", YoloPrecision: "fp16"}
	if raw, err := s.Get(ctx, "detector.yolo26_variant"); err == nil {
		_ = json.Unmarshal(raw, &d.YoloVariant)
	} else if !errors.Is(err, ErrNotFound) {
		return d, err
	}
	if raw, err := s.Get(ctx, "detector.yolo26_precision"); err == nil {
		_ = json.Unmarshal(raw, &d.YoloPrecision)
	} else if !errors.Is(err, ErrNotFound) {
		return d, err
	}
	if raw, err := s.Get(ctx, "detector.anpr_enabled"); err == nil {
		_ = json.Unmarshal(raw, &d.AnprEnabled)
	} else if !errors.Is(err, ErrNotFound) {
		return d, err
	}
	return d, nil
}

// SetDetector validates and upserts detector settings. Any invalid value
// produces an error and no write happens.
func (s *Store) SetDetector(ctx context.Context, d Detector) error {
	if _, ok := validYoloVariants[d.YoloVariant]; !ok {
		return fmt.Errorf("invalid yolo26_variant %q", d.YoloVariant)
	}
	if _, ok := validPrecisions[d.YoloPrecision]; !ok {
		return fmt.Errorf("invalid yolo26_precision %q", d.YoloPrecision)
	}
	vb, _ := json.Marshal(d.YoloVariant)
	pb, _ := json.Marshal(d.YoloPrecision)
	ab, _ := json.Marshal(d.AnprEnabled)
	if err := s.Set(ctx, "detector.yolo26_variant", vb); err != nil {
		return err
	}
	if err := s.Set(ctx, "detector.yolo26_precision", pb); err != nil {
		return err
	}
	return s.Set(ctx, "detector.anpr_enabled", ab)
}

// HAConfig is the Home Assistant bridge config surfaced via /settings/ha.
// The bridge runs inside notification-dispatcher; when `Enabled` is true
// it connects to `BrokerURL` and publishes MQTT auto-discovery +
// per-camera state. Password is stored plain in JSONB (same as the
// notification-channel configs today — broker creds live in one row
// for the operator to rotate).
type HAConfig struct {
	Enabled         bool   `json:"enabled"`
	BrokerURL       string `json:"broker_url"`
	Username        string `json:"username"`
	Password        string `json:"password"`
	DiscoveryPrefix string `json:"discovery_prefix"`
	TopicPrefix     string `json:"topic_prefix"`
}

// GetHAConfig returns the stored HA config with sensible defaults
// filled in for missing fields.
func (s *Store) GetHAConfig(ctx context.Context) (HAConfig, error) {
	cfg := HAConfig{
		BrokerURL:       "tcp://mosquitto:1883",
		DiscoveryPrefix: "homeassistant",
		TopicPrefix:     "fnvr",
	}
	raw, err := s.Get(ctx, "ha.config")
	if err == nil {
		_ = json.Unmarshal(raw, &cfg)
	} else if !errors.Is(err, ErrNotFound) {
		return cfg, err
	}
	if cfg.DiscoveryPrefix == "" {
		cfg.DiscoveryPrefix = "homeassistant"
	}
	if cfg.TopicPrefix == "" {
		cfg.TopicPrefix = "fnvr"
	}
	return cfg, nil
}

func (s *Store) SetHAConfig(ctx context.Context, c HAConfig) error {
	b, _ := json.Marshal(c)
	return s.Set(ctx, "ha.config", b)
}

// ClassMutes is the three-bucket class-mute configuration applied by
// event-processor: global covers every camera; indoor/outdoor apply on
// top of global to cameras tagged with the matching location_kind.
// Per-camera overrides (on the cameras row) can add or subtract from
// the resolved set. Always-non-nil slices so the JSON shape is stable.
type ClassMutes struct {
	Global  []string `json:"global"`
	Indoor  []string `json:"indoor"`
	Outdoor []string `json:"outdoor"`
}

func (s *Store) GetClassMutes(ctx context.Context) (ClassMutes, error) {
	m := ClassMutes{Global: []string{}, Indoor: []string{}, Outdoor: []string{}}
	for _, kv := range []struct {
		key string
		dst *[]string
	}{
		{"classes.disabled.global", &m.Global},
		{"classes.disabled.indoor", &m.Indoor},
		{"classes.disabled.outdoor", &m.Outdoor},
	} {
		raw, err := s.Get(ctx, kv.key)
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				continue
			}
			return m, err
		}
		_ = json.Unmarshal(raw, kv.dst)
		if *kv.dst == nil {
			*kv.dst = []string{}
		}
	}
	return m, nil
}

func (s *Store) SetClassMutes(ctx context.Context, m ClassMutes) error {
	for _, kv := range []struct {
		key string
		src []string
	}{
		{"classes.disabled.global", normaliseClassList(m.Global)},
		{"classes.disabled.indoor", normaliseClassList(m.Indoor)},
		{"classes.disabled.outdoor", normaliseClassList(m.Outdoor)},
	} {
		b, _ := json.Marshal(kv.src)
		if err := s.Set(ctx, kv.key, b); err != nil {
			return err
		}
	}
	return nil
}

// normaliseClassList returns a non-nil slice with empty strings and
// duplicates removed. Keeps the on-disk JSON tidy and lets the engine
// skip the "is this empty" check.
func normaliseClassList(in []string) []string {
	out := make([]string, 0, len(in))
	seen := map[string]struct{}{}
	for _, s := range in {
		if s == "" {
			continue
		}
		if _, dup := seen[s]; dup {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out
}

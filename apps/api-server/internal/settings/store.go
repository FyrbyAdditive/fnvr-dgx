// Package settings backs the system-wide key/value store used by the
// Settings page. Values are JSON blobs; each setting has a typed helper
// so the API handlers don't open-code validation.
package settings

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

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
// INT8 is served via offline trtexec calibration (see
// docs/deployment/known-issues.md and deploy/docker/calibrate-yolo26.sh).
// The in-process TRT calibrator hits an assertion on TRT 10.3 so the
// entrypoint runs the offline path on first INT8 boot; this validator
// accepts the setting and lets that flow take over.
var validPrecisions = map[string]struct{}{
	"fp16": {},
	"int8": {},
}

type Detector struct {
	YoloVariant   string `json:"yolo26_variant"`
	YoloPrecision string `json:"yolo26_precision"`
	// AnprEnabled toggles the LPDNet + LPRNet SGIE chain in the
	// pipeline. Off by default so the two extra nvinfer stages don't
	// eat GPU on installs that don't care about plates. Takes effect
	// on pipeline restart (Settings UI does this automatically).
	AnprEnabled bool `json:"anpr_enabled"`
	// FaceIDEnabled toggles the SCRFD + ArcFace SGIE chain for face
	// detect + embed. Same scaling + restart story as AnprEnabled.
	FaceIDEnabled bool `json:"face_id_enabled"`
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
	if raw, err := s.Get(ctx, "detector.face_id_enabled"); err == nil {
		_ = json.Unmarshal(raw, &d.FaceIDEnabled)
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
	fb, _ := json.Marshal(d.FaceIDEnabled)
	if err := s.Set(ctx, "detector.yolo26_variant", vb); err != nil {
		return err
	}
	if err := s.Set(ctx, "detector.yolo26_precision", pb); err != nil {
		return err
	}
	if err := s.Set(ctx, "detector.anpr_enabled", ab); err != nil {
		return err
	}
	return s.Set(ctx, "detector.face_id_enabled", fb)
}

// Face match threshold — cosine similarity floor above which a
// detection is considered to match an enrolled person. Callable
// from event-processor via a Postgres read; no Go code path today
// reads it directly but API handlers may soon.
func (s *Store) GetFaceMatchThreshold(ctx context.Context) (float64, error) {
	const def = 0.40
	raw, err := s.Get(ctx, "faces.match_threshold")
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return def, nil
		}
		return def, err
	}
	var t float64
	if err := json.Unmarshal(raw, &t); err != nil || t <= 0 || t >= 1 {
		return def, nil
	}
	return t, nil
}

func (s *Store) SetFaceMatchThreshold(ctx context.Context, t float64) error {
	if t <= 0 || t >= 1 {
		return fmt.Errorf("threshold must be in (0,1)")
	}
	b, _ := json.Marshal(t)
	return s.Set(ctx, "faces.match_threshold", b)
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

// CalibrationStatus surfaces yolo26 INT8 calibration state to the
// UI. LastRun is null until the first attempt; LastError is null
// when the most recent attempt succeeded (or none has run yet), so
// the client can distinguish "not run" from "ran and failed".
type CalibrationStatus struct {
	ImageCount int        `json:"image_count"`
	LastRun    *time.Time `json:"last_run,omitempty"`
	LastError  string     `json:"last_error,omitempty"`
	// EngineSize and TableSHA256 are populated by the entrypoint on
	// successful calibration so the UI can show the user what was
	// produced. Zero / empty when calibration hasn't succeeded.
	EngineSize  int64  `json:"engine_size,omitempty"`
	TableSHA256 string `json:"table_sha256,omitempty"`
}

// GetCalibrationStatus reads the three calibration.* rows. Missing
// rows fall back to zero values (fresh install before migration 0018
// ran — defensive).
func (s *Store) GetCalibrationStatus(ctx context.Context) (CalibrationStatus, error) {
	var c CalibrationStatus
	if raw, err := s.Get(ctx, "calibration.image_count"); err == nil {
		_ = json.Unmarshal(raw, &c.ImageCount)
	} else if !errors.Is(err, ErrNotFound) {
		return c, err
	}
	if raw, err := s.Get(ctx, "calibration.last_run"); err == nil {
		// Stored as a JSON string (RFC3339) or JSON null.
		var ts string
		if err := json.Unmarshal(raw, &ts); err == nil && ts != "" {
			if t, perr := time.Parse(time.RFC3339Nano, ts); perr == nil {
				c.LastRun = &t
			}
		}
	} else if !errors.Is(err, ErrNotFound) {
		return c, err
	}
	if raw, err := s.Get(ctx, "calibration.last_error"); err == nil {
		var s string
		if err := json.Unmarshal(raw, &s); err == nil {
			c.LastError = s
		}
	} else if !errors.Is(err, ErrNotFound) {
		return c, err
	}
	if raw, err := s.Get(ctx, "calibration.engine_size"); err == nil {
		_ = json.Unmarshal(raw, &c.EngineSize)
	}
	if raw, err := s.Get(ctx, "calibration.table_sha256"); err == nil {
		_ = json.Unmarshal(raw, &c.TableSHA256)
	}
	return c, nil
}

// SetCalibrationStatus upserts any subset of the calibration fields.
// Nil pointers / empty strings / zero values are persisted as JSON
// null so the UI can distinguish "not set" from "set to zero".
func (s *Store) SetCalibrationStatus(ctx context.Context, c CalibrationStatus) error {
	countB, _ := json.Marshal(c.ImageCount)
	if err := s.Set(ctx, "calibration.image_count", countB); err != nil {
		return err
	}
	var runB []byte
	if c.LastRun != nil {
		runB, _ = json.Marshal(c.LastRun.UTC().Format(time.RFC3339Nano))
	} else {
		runB = []byte("null")
	}
	if err := s.Set(ctx, "calibration.last_run", runB); err != nil {
		return err
	}
	var errB []byte
	if c.LastError != "" {
		errB, _ = json.Marshal(c.LastError)
	} else {
		errB = []byte("null")
	}
	if err := s.Set(ctx, "calibration.last_error", errB); err != nil {
		return err
	}
	sizeB, _ := json.Marshal(c.EngineSize)
	if err := s.Set(ctx, "calibration.engine_size", sizeB); err != nil {
		return err
	}
	shaB, _ := json.Marshal(c.TableSHA256)
	return s.Set(ctx, "calibration.table_sha256", shaB)
}

// SetCalibrationImageCount updates just the image_count row.
// Called repeatedly by the sampler goroutine so the UI progress bar
// moves; keeping it separate from the full upsert avoids flapping
// last_run / last_error on every increment.
func (s *Store) SetCalibrationImageCount(ctx context.Context, n int) error {
	b, _ := json.Marshal(n)
	return s.Set(ctx, "calibration.image_count", b)
}

// --- alarm state ---

var validAlarmStates = map[string]struct{}{
	"home":     {},
	"away":     {},
	"disarmed": {},
}

// AlarmState is the global armed/disarmed mode. Rules can opt in to a
// specific state via their active_when field. "disarmed" is the default
// so a fresh install doesn't silently suppress rules that depend on the
// state being set.
type AlarmState struct {
	State string `json:"state"` // "home" | "away" | "disarmed"
}

func (s *Store) GetAlarm(ctx context.Context) (AlarmState, error) {
	a := AlarmState{State: "disarmed"}
	raw, err := s.Get(ctx, "alarm.state")
	if errors.Is(err, ErrNotFound) {
		return a, nil
	}
	if err != nil {
		return a, err
	}
	// Stored shape is the full struct; tolerate a bare string too in
	// case someone sets the key via psql.
	if err := json.Unmarshal(raw, &a); err != nil {
		var str string
		if jerr := json.Unmarshal(raw, &str); jerr == nil {
			a.State = str
		}
	}
	if _, ok := validAlarmStates[a.State]; !ok {
		a.State = "disarmed"
	}
	return a, nil
}

func (s *Store) SetAlarm(ctx context.Context, a AlarmState) error {
	if _, ok := validAlarmStates[a.State]; !ok {
		return fmt.Errorf("invalid alarm state %q", a.State)
	}
	b, _ := json.Marshal(a)
	return s.Set(ctx, "alarm.state", b)
}

// --- pipeline tunables ---

// GetPipelineStartupGrace returns the seconds-of-grace window during
// which the supervisor tolerates a flapping worker without publishing
// `failed`. Used to silence "pipeline failed" flashes for sources that
// need a few seconds (or a few respawns) to establish their upstream —
// MediaMTX-proxied cameras, slow RTSPS handshakes, cold-boot devices.
// Clamped to [0, 600]. Default 60.
func (s *Store) GetPipelineStartupGrace(ctx context.Context) (int, error) {
	const def = 60
	raw, err := s.Get(ctx, "pipeline.startup_grace_sec")
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return def, nil
		}
		return def, err
	}
	var n int
	if err := json.Unmarshal(raw, &n); err != nil {
		return def, nil
	}
	if n < 0 {
		n = 0
	}
	if n > 600 {
		n = 600
	}
	return n, nil
}

func (s *Store) SetPipelineStartupGrace(ctx context.Context, n int) error {
	if n < 0 || n > 600 {
		return fmt.Errorf("startup_grace_sec must be in [0, 600]")
	}
	b, _ := json.Marshal(n)
	return s.Set(ctx, "pipeline.startup_grace_sec", b)
}

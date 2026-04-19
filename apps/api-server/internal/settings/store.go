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
var validPrecisions = map[string]struct{}{
	"fp16": {}, "int8": {},
}

type Detector struct {
	YoloVariant   string `json:"yolo26_variant"`
	YoloPrecision string `json:"yolo26_precision"`
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
	if err := s.Set(ctx, "detector.yolo26_variant", vb); err != nil {
		return err
	}
	return s.Set(ctx, "detector.yolo26_precision", pb)
}

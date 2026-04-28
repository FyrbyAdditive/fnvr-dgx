// Package flags manages object-detection false-positive / relabel
// flags. Each flag both drives live suppression (via event-processor's
// pHash library) AND contributes a row to a YOLO-format dataset tree
// under /var/lib/fnvr/datasets/objects/ for future off-device
// training.
package flags

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrNotFound = errors.New("object flag not found")

type BBox struct {
	X float32 `json:"x"`
	Y float32 `json:"y"`
	W float32 `json:"w"`
	H float32 `json:"h"`
}

type Flag struct {
	ID             int64     `json:"id"`
	DetectionID    *int64    `json:"detection_id"`
	// EventID is the short hex string the pipeline assigned to the
	// source detection — also the filename of the JPEG thumb written
	// at probe time under {DataDir}/thumbs/objects/{event_id}.jpg.
	// Snapshotted onto the flag so retention pruning the underlying
	// detection row doesn't break the thumbnail endpoint.
	EventID        *string   `json:"event_id"`
	CameraID       string    `json:"camera_id"`
	TS             time.Time `json:"ts"`
	ClassOriginal  string    `json:"class_original"`
	ClassCorrected *string   `json:"class_corrected"`
	BBox           BBox      `json:"bbox"`
	PHash          *uint64   `json:"phash"`
	FramePath      string    `json:"frame_path"`
	LabelPath      string    `json:"label_path"`
	CreatedBy      *string   `json:"created_by"`
	CreatedAt      time.Time `json:"created_at"`
	DismissedAt    *time.Time `json:"dismissed_at"`
}

// CreateArgs bundles what the handler needs to write a flag.
//
// For *detection-derived* flags (the original flow) the handler reads
// detection.id/ts/camera_id/bbox/attributes from PG and populates the
// fields here; phash comes from the detection's `attributes.phash`
// string (16-hex-char lowercase).
//
// For *manual* flags (drawn straight onto a frozen Live tile) there's
// no underlying detection — DetectionID and PHash are nil. The flag
// still contributes a YOLO dataset row but doesn't enter the
// pHash-based suppression library.
type CreateArgs struct {
	DetectionID    *int64
	EventID        *string // short hex string keying the on-disk thumb
	CameraID       string
	TS             time.Time
	ClassOriginal  string
	ClassCorrected *string
	BBox           BBox
	PHash          *uint64
	FramePath      string // relative to DataDir
	LabelPath      string // relative to DataDir
	CreatedBy      *string
}

type Store struct {
	pool *pgxpool.Pool
}

func NewStore(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// Create inserts a flag row. The caller is expected to have already
// written the frame JPEG + label .txt + regenerated dataset.yaml; we
// just persist the pointers. Returns the new row including its
// assigned id.
func (s *Store) Create(ctx context.Context, a CreateArgs) (Flag, error) {
	bboxJSON, err := json.Marshal(a.BBox)
	if err != nil {
		return Flag{}, err
	}
	var f Flag
	err = s.pool.QueryRow(ctx, `
		INSERT INTO object_flags
		    (detection_id, event_id, camera_id, ts, class_original, class_corrected,
		     bbox, phash, frame_path, label_path, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)
		RETURNING id, detection_id, event_id, camera_id, ts, class_original,
		          class_corrected, bbox, phash, frame_path, label_path,
		          created_by, created_at, dismissed_at`,
		nullableInt64(a.DetectionID), derefOrNil(a.EventID),
		a.CameraID, a.TS, a.ClassOriginal,
		derefOrNil(a.ClassCorrected), string(bboxJSON),
		// pgx's pgtype for bigint is int64; pHash is a full 64-bit
		// value which we store as a *signed* int64. The bit pattern
		// round-trips so the event-processor's bits.OnesCount64 path
		// works either way. nil → SQL NULL (manual flags).
		nullablePHashArg(a.PHash),
		a.FramePath, a.LabelPath, derefOrNil(a.CreatedBy),
	).Scan(&f.ID, &nullableInt64Scan{&f.DetectionID}, &f.EventID, &f.CameraID, &f.TS, &f.ClassOriginal,
		&f.ClassCorrected, &bboxJSON, &scanPHashPtr{&f.PHash}, &f.FramePath, &f.LabelPath,
		&f.CreatedBy, &f.CreatedAt, &f.DismissedAt)
	if err != nil {
		return Flag{}, err
	}
	_ = json.Unmarshal(bboxJSON, &f.BBox)
	return f, nil
}

// List returns flags, newest first. Any filter left as its zero value
// is ignored (so the no-filter call returns everything for the Flags
// page). includeDismissed=false excludes soft-deleted rows.
type ListFilter struct {
	CameraID         string
	ClassOriginal    string
	IncludeDismissed bool
	Limit            int // 0 → default 200
}

func (s *Store) List(ctx context.Context, f ListFilter) ([]Flag, error) {
	if f.Limit <= 0 || f.Limit > 1000 {
		f.Limit = 200
	}
	where := []string{}
	args := []any{}
	add := func(v any) string {
		args = append(args, v)
		return "$" + itoa(len(args))
	}
	if !f.IncludeDismissed {
		where = append(where, "dismissed_at IS NULL")
	}
	if f.CameraID != "" {
		where = append(where, "camera_id = "+add(f.CameraID))
	}
	if f.ClassOriginal != "" {
		where = append(where, "class_original = "+add(f.ClassOriginal))
	}
	sql := `SELECT id, detection_id, event_id, camera_id, ts, class_original,
	               class_corrected, bbox, phash, frame_path, label_path,
	               created_by, created_at, dismissed_at
	        FROM object_flags`
	if len(where) > 0 {
		sql += " WHERE " + strings.Join(where, " AND ")
	}
	sql += " ORDER BY created_at DESC LIMIT " + add(f.Limit)

	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Flag, 0, 16)
	for rows.Next() {
		var fl Flag
		var bboxJSON []byte
		if err := rows.Scan(&fl.ID, &nullableInt64Scan{&fl.DetectionID}, &fl.EventID,
			&fl.CameraID, &fl.TS,
			&fl.ClassOriginal, &fl.ClassCorrected, &bboxJSON,
			&scanPHashPtr{&fl.PHash}, &fl.FramePath, &fl.LabelPath,
			&fl.CreatedBy, &fl.CreatedAt, &fl.DismissedAt); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(bboxJSON, &fl.BBox)
		out = append(out, fl)
	}
	return out, rows.Err()
}

// Dismiss soft-deletes a flag. The event-processor's next reload
// drops it from the suppression library. Returns ErrNotFound if the
// row is already dismissed or doesn't exist.
func (s *Store) Dismiss(ctx context.Context, id int64) (Flag, error) {
	var f Flag
	var bboxJSON []byte
	err := s.pool.QueryRow(ctx, `
		UPDATE object_flags SET dismissed_at = NOW()
		WHERE id = $1 AND dismissed_at IS NULL
		RETURNING id, detection_id, event_id, camera_id, ts, class_original,
		          class_corrected, bbox, phash, frame_path, label_path,
		          created_by, created_at, dismissed_at`, id,
	).Scan(&f.ID, &nullableInt64Scan{&f.DetectionID}, &f.EventID, &f.CameraID, &f.TS, &f.ClassOriginal,
		&f.ClassCorrected, &bboxJSON, &scanPHashPtr{&f.PHash}, &f.FramePath, &f.LabelPath,
		&f.CreatedBy, &f.CreatedAt, &f.DismissedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Flag{}, ErrNotFound
	}
	if err != nil {
		return Flag{}, err
	}
	_ = json.Unmarshal(bboxJSON, &f.BBox)
	return f, nil
}

// Get returns a single flag regardless of dismissed state (admin UI
// needs to show the dismissed ones).
func (s *Store) Get(ctx context.Context, id int64) (Flag, error) {
	var f Flag
	var bboxJSON []byte
	err := s.pool.QueryRow(ctx, `
		SELECT id, detection_id, event_id, camera_id, ts, class_original,
		       class_corrected, bbox, phash, frame_path, label_path,
		       created_by, created_at, dismissed_at
		FROM object_flags WHERE id = $1`, id,
	).Scan(&f.ID, &nullableInt64Scan{&f.DetectionID}, &f.EventID, &f.CameraID, &f.TS, &f.ClassOriginal,
		&f.ClassCorrected, &bboxJSON, &scanPHashPtr{&f.PHash}, &f.FramePath, &f.LabelPath,
		&f.CreatedBy, &f.CreatedAt, &f.DismissedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Flag{}, ErrNotFound
	}
	if err != nil {
		return Flag{}, err
	}
	_ = json.Unmarshal(bboxJSON, &f.BBox)
	return f, nil
}

// DeleteFiles removes the on-disk frame + label for a dismissed flag.
// Called by the handler when the caller passes ?purge=true.
// dataDir is FNVR_DATA_DIR; frame_path and label_path on the flag are
// relative.
func DeleteFiles(dataDir string, f Flag) error {
	for _, p := range []string{f.FramePath, f.LabelPath} {
		if p == "" {
			continue
		}
		abs := filepath.Join(dataDir, p)
		if err := os.Remove(abs); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove %s: %w", abs, err)
		}
	}
	return nil
}

// --- helpers ---

func derefOrNil[T any](p *T) any {
	if p == nil {
		return nil
	}
	return *p
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [12]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

// scanPHashPtr adapts a nullable int64 pgx column into a *uint64 dst.
// NULL → nil; otherwise reinterpret the bit pattern (bits.OnesCount64
// is identity over the signed/unsigned cast).
type scanPHashPtr struct{ dst **uint64 }

func (s *scanPHashPtr) Scan(src any) error {
	switch v := src.(type) {
	case int64:
		u := uint64(v)
		*s.dst = &u
		return nil
	case nil:
		*s.dst = nil
		return nil
	default:
		return fmt.Errorf("scanPHashPtr: unsupported %T", src)
	}
}

// nullableInt64Scan unmarshals a nullable BIGINT into a *int64 dst.
type nullableInt64Scan struct{ dst **int64 }

func (s *nullableInt64Scan) Scan(src any) error {
	switch v := src.(type) {
	case int64:
		x := v
		*s.dst = &x
		return nil
	case nil:
		*s.dst = nil
		return nil
	default:
		return fmt.Errorf("nullableInt64Scan: unsupported %T", src)
	}
}

// nullableInt64 returns nil for a nil pointer (so pgx writes SQL
// NULL) or the value otherwise. The arg type must be `any` because
// pgx interprets typed-nil and untyped-nil differently for NOT NULL
// columns; returning untyped nil is the safe path.
func nullableInt64(p *int64) any {
	if p == nil {
		return nil
	}
	return *p
}

// nullablePHashArg returns nil or the int64 reinterpretation of *p.
func nullablePHashArg(p *uint64) any {
	if p == nil {
		return nil
	}
	return int64(*p)
}

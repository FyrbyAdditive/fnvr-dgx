// Package classes is the single source of truth for the detection
// class taxonomy. Backed by the detection_classes table seeded with
// the 80 COCO classes; the user can disable or extend the list from
// the Settings UI. Replaces the hard-coded CocoClasses slice that
// used to live in apps/api-server/internal/flags/dataset.go.
package classes

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrNotFound      = errors.New("class not found")
	ErrInvalidSlug   = errors.New("slug must be 1..40 chars, lowercase letters/digits/spaces/hyphens")
	ErrSlugInUse     = errors.New("a class with that slug already exists")
	ErrSeedImmutable = errors.New("seeded COCO classes cannot be deleted; disable instead")
	ErrHasFlags      = errors.New("class has flagged samples; cannot delete")
)

// Slugs are case-insensitive (we lowercase on insert) and intentionally
// permissive about spaces because the seeded COCO list has multi-word
// entries ("traffic light", "fire hydrant", "wine glass"). Length cap
// of 40 chars is a sanity guard, not a product constraint.
var slugRE = regexp.MustCompile(`^[a-z0-9][a-z0-9 -]{0,39}$`)

type Class struct {
	ID          int       `json:"id"`
	Slug        string    `json:"slug"`
	DisplayName string    `json:"display_name"`
	YoloID      int       `json:"yolo_id"`
	Origin      string    `json:"origin"`
	Enabled     bool      `json:"enabled"`
	CreatedAt   time.Time `json:"created_at"`
}

type Store struct {
	pool *pgxpool.Pool
}

func NewStore(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// List returns every row in yolo_id order. The Settings page shows the
// full list; everything else (Live tab, dataset, label files) filters
// to enabled rows via Enabled().
func (s *Store) List(ctx context.Context) ([]Class, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, slug, display_name, yolo_id, origin, enabled, created_at
		  FROM detection_classes
		 ORDER BY yolo_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Class, 0, 80)
	for rows.Next() {
		var c Class
		if err := rows.Scan(&c.ID, &c.Slug, &c.DisplayName, &c.YoloID,
			&c.Origin, &c.Enabled, &c.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// Enabled returns only rows with enabled=TRUE. This is what the
// dataset.yaml regenerator and the relabel UI consume.
func (s *Store) Enabled(ctx context.Context) ([]Class, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, slug, display_name, yolo_id, origin, enabled, created_at
		  FROM detection_classes
		 WHERE enabled = TRUE
		 ORDER BY yolo_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Class, 0, 80)
	for rows.Next() {
		var c Class
		if err := rows.Scan(&c.ID, &c.Slug, &c.DisplayName, &c.YoloID,
			&c.Origin, &c.Enabled, &c.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// SlugToYoloID is the lookup the YOLO label-file writer needs:
// translate "person" → 0 so labels.txt has the right integer. Includes
// disabled classes too — a flag created against a since-disabled class
// (e.g. user disabled "kite" after one was already flagged) still has
// to write a valid label file. The dataset.yaml regenerator filters
// disabled out separately.
func (s *Store) SlugToYoloID(ctx context.Context) (map[string]int, error) {
	rows, err := s.pool.Query(ctx, `SELECT slug, yolo_id FROM detection_classes`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]int, 80)
	for rows.Next() {
		var slug string
		var id int
		if err := rows.Scan(&slug, &id); err != nil {
			return nil, err
		}
		out[slug] = id
	}
	return out, rows.Err()
}

// CreateArgs is the body of POST /admin/classes. Origin is forced to
// 'custom' on insert; only the seed migration writes 'coco' rows.
type CreateArgs struct {
	Slug        string
	DisplayName string
}

// Create inserts a new custom class. yolo_id auto-assigned to MAX+1
// so the model that's eventually trained will emit it as the next
// integer above the current max.
func (s *Store) Create(ctx context.Context, args CreateArgs) (Class, error) {
	slug := strings.ToLower(strings.TrimSpace(args.Slug))
	display := strings.TrimSpace(args.DisplayName)
	if !slugRE.MatchString(slug) {
		return Class{}, ErrInvalidSlug
	}
	if display == "" {
		display = strings.Title(slug) //nolint:staticcheck // OK for ASCII slugs
	}
	var c Class
	err := s.pool.QueryRow(ctx, `
		INSERT INTO detection_classes (slug, display_name, yolo_id, origin, enabled)
		VALUES ($1, $2,
		        COALESCE((SELECT MAX(yolo_id)+1 FROM detection_classes), 0),
		        'custom', TRUE)
		RETURNING id, slug, display_name, yolo_id, origin, enabled, created_at`,
		slug, display).Scan(&c.ID, &c.Slug, &c.DisplayName, &c.YoloID,
		&c.Origin, &c.Enabled, &c.CreatedAt)
	if err != nil {
		// Postgres unique_violation on slug — surface a clean error.
		if strings.Contains(err.Error(), "detection_classes_slug_key") {
			return Class{}, ErrSlugInUse
		}
		return Class{}, fmt.Errorf("insert: %w", err)
	}
	return c, nil
}

// PatchArgs allows the user to toggle enabled or rename display_name.
// slug and yolo_id are immutable: changing them would invalidate every
// label file already on disk and every settings/rules row that refers
// to the slug.
type PatchArgs struct {
	Enabled     *bool
	DisplayName *string
}

func (s *Store) Patch(ctx context.Context, id int, args PatchArgs) (Class, error) {
	// Build the SET clause dynamically so PATCH is partial — caller can
	// send {"enabled": false} without clobbering display_name.
	sets := []string{}
	vals := []any{}
	i := 1
	if args.Enabled != nil {
		sets = append(sets, fmt.Sprintf("enabled = $%d", i))
		vals = append(vals, *args.Enabled)
		i++
	}
	if args.DisplayName != nil {
		v := strings.TrimSpace(*args.DisplayName)
		if v == "" {
			return Class{}, errors.New("display_name cannot be empty")
		}
		sets = append(sets, fmt.Sprintf("display_name = $%d", i))
		vals = append(vals, v)
		i++
	}
	if len(sets) == 0 {
		return s.Get(ctx, id)
	}
	vals = append(vals, id)
	q := fmt.Sprintf(`UPDATE detection_classes SET %s WHERE id = $%d
	                  RETURNING id, slug, display_name, yolo_id, origin, enabled, created_at`,
		strings.Join(sets, ", "), i)
	var c Class
	err := s.pool.QueryRow(ctx, q, vals...).Scan(&c.ID, &c.Slug, &c.DisplayName,
		&c.YoloID, &c.Origin, &c.Enabled, &c.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Class{}, ErrNotFound
	}
	return c, err
}

// SetEnabledBulk applies many enabled flips in one transaction, so a
// Settings "Save & restart" can't half-apply the taxonomy: either every
// change lands or none does. Unknown ids roll the whole batch back.
func (s *Store) SetEnabledBulk(ctx context.Context, changes map[int]bool) error {
	if len(changes) == 0 {
		return nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for id, enabled := range changes {
		tag, err := tx.Exec(ctx,
			`UPDATE detection_classes SET enabled = $1 WHERE id = $2`, enabled, id)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return fmt.Errorf("%w: id %d", ErrNotFound, id)
		}
	}
	return tx.Commit(ctx)
}

func (s *Store) Get(ctx context.Context, id int) (Class, error) {
	var c Class
	err := s.pool.QueryRow(ctx, `
		SELECT id, slug, display_name, yolo_id, origin, enabled, created_at
		  FROM detection_classes WHERE id = $1`, id).Scan(
		&c.ID, &c.Slug, &c.DisplayName, &c.YoloID, &c.Origin, &c.Enabled, &c.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Class{}, ErrNotFound
	}
	return c, err
}

// Delete removes a custom class. Refuses if origin='coco' (use Patch
// to disable instead) or if any object_flags row still references the
// slug — keeps the dataset tree internally consistent.
func (s *Store) Delete(ctx context.Context, id int) error {
	c, err := s.Get(ctx, id)
	if err != nil {
		return err
	}
	if c.Origin == "coco" {
		return ErrSeedImmutable
	}
	var n int
	if err := s.pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM object_flags
		 WHERE class_original = $1 OR class_corrected = $1`, c.Slug).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return ErrHasFlags
	}
	_, err = s.pool.Exec(ctx, `DELETE FROM detection_classes WHERE id = $1`, id)
	return err
}

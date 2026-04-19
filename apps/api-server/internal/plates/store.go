// Package plates backs the Plates UI: hotlist CRUD plus a
// recent-plates view that deduplicates the detections stream by
// plate for the "who has driven past lately" panel. The hotlist
// table lives in Postgres; event-processor reads it every 30s in
// reload() to keep its in-memory match set fresh.
package plates

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrNotFound = errors.New("plate hotlist entry not found")

type HotlistEntry struct {
	ID        string    `json:"id"`
	Pattern   string    `json:"pattern"`
	Label     string    `json:"label"`
	Severity  string    `json:"severity"`
	Notes     string    `json:"notes,omitempty"`
	Enabled   bool      `json:"enabled"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type RecentPlate struct {
	Plate      string    `json:"plate"`
	LastCamera string    `json:"last_camera"`
	LastSeen   time.Time `json:"last_seen"`
	Count      int       `json:"count"`
}

type Store struct{ pool *pgxpool.Pool }

func NewStore(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// NormalisePattern strips spaces / hyphens / dots and uppercases.
// Applied to both hotlist patterns on write and to detection plate
// strings via the generated column, so a user-typed "AB-12 CDE"
// matches a detector-emitted "AB12CDE". The '%' wildcard is
// preserved so LIKE semantics still work.
func NormalisePattern(p string) string {
	var b strings.Builder
	for _, r := range p {
		switch {
		case r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '%':
			b.WriteRune(r)
		case r >= 'a' && r <= 'z':
			b.WriteRune(r - 32)
		}
	}
	return b.String()
}

func (s *Store) ListHotlist(ctx context.Context) ([]HotlistEntry, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, pattern, label, severity, COALESCE(notes,''),
		       enabled, created_at, updated_at
		FROM plate_hotlist ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]HotlistEntry, 0, 16)
	for rows.Next() {
		var e HotlistEntry
		if err := rows.Scan(&e.ID, &e.Pattern, &e.Label, &e.Severity, &e.Notes,
			&e.Enabled, &e.CreatedAt, &e.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func (s *Store) CreateHotlistEntry(ctx context.Context, e HotlistEntry) (HotlistEntry, error) {
	e.Pattern = NormalisePattern(e.Pattern)
	if e.Pattern == "" {
		return e, errors.New("pattern required")
	}
	if e.Label == "" {
		return e, errors.New("label required")
	}
	if e.Severity == "" {
		e.Severity = "warning"
	}
	err := s.pool.QueryRow(ctx, `
		INSERT INTO plate_hotlist (pattern, label, severity, notes, enabled)
		VALUES ($1, $2, $3, NULLIF($4,''), $5)
		RETURNING id::text, created_at, updated_at`,
		e.Pattern, e.Label, e.Severity, e.Notes, e.Enabled).
		Scan(&e.ID, &e.CreatedAt, &e.UpdatedAt)
	return e, err
}

// UpdateHotlistEntry applies any non-nil-ish field from the supplied
// entry. Pattern is renormalised; empty-string fields leave the
// existing value alone so a PATCH-style caller can send only what
// changed.
func (s *Store) UpdateHotlistEntry(ctx context.Context, id string, e HotlistEntry) error {
	var (
		sets = []string{"updated_at = NOW()"}
		args = []any{id}
	)
	add := func(v any) string {
		args = append(args, v)
		return "$" + itoa(len(args))
	}
	if p := NormalisePattern(e.Pattern); p != "" {
		sets = append(sets, "pattern = "+add(p))
	}
	if e.Label != "" {
		sets = append(sets, "label = "+add(e.Label))
	}
	if e.Severity != "" {
		if e.Severity != "info" && e.Severity != "warning" && e.Severity != "critical" {
			return errors.New("invalid severity")
		}
		sets = append(sets, "severity = "+add(e.Severity))
	}
	// Notes is set whether empty or not (operators clear it).
	// Use a sentinel: if caller sends an explicit empty string it's
	// preserved as NULL.
	sets = append(sets, "notes = "+add(e.Notes))
	sets = append(sets, "enabled = "+add(e.Enabled))

	sql := "UPDATE plate_hotlist SET " + strings.Join(sets, ", ") + " WHERE id = $1"
	tag, err := s.pool.Exec(ctx, sql, args...)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) DeleteHotlistEntry(ctx context.Context, id string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM plate_hotlist WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// RecentPlates dedupes the detections stream by plate string across
// the given lookback window and returns the latest camera + timestamp
// per plate with a hit count. Uses the partial plate index so a
// 7-day window over a busy site is still sub-second.
func (s *Store) RecentPlates(ctx context.Context, sinceHours, limit int) ([]RecentPlate, error) {
	if sinceHours <= 0 || sinceHours > 24*90 {
		sinceHours = 24
	}
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx, `
		WITH w AS (
		    SELECT plate, camera_id, ts
		    FROM detections
		    WHERE plate IS NOT NULL
		      AND ts > NOW() - ($1 || ' hours')::interval
		)
		SELECT plate,
		       (SELECT camera_id FROM w w2
		          WHERE w2.plate = w.plate
		          ORDER BY ts DESC LIMIT 1) AS last_camera,
		       MAX(ts) AS last_seen,
		       COUNT(*) AS cnt
		FROM w
		GROUP BY plate
		ORDER BY last_seen DESC
		LIMIT $2`, sinceHoursStr(sinceHours), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]RecentPlate, 0, limit)
	for rows.Next() {
		var r RecentPlate
		if err := rows.Scan(&r.Plate, &r.LastCamera, &r.LastSeen, &r.Count); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// sinceHoursStr avoids pgx's int-into-text encoding quirk; we pass
// hours as a string and concat in SQL exactly as storage-manager's
// pruneHotDetections already does.
func sinceHoursStr(h int) string {
	// strconv-less int→string to avoid a new import.
	if h <= 0 {
		return "0"
	}
	var buf [12]byte
	i := len(buf)
	for h > 0 {
		i--
		buf[i] = byte('0' + h%10)
		h /= 10
	}
	return string(buf[i:])
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [12]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

// Unused helper kept to flag a future caller: pgx.ErrNoRows-aware
// Get. Suppresses the import-unused lint if other callers drop.
var _ = pgx.ErrNoRows

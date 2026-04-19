// Package segments reads recorded fMP4 segments from the Postgres index
// that storage-manager maintains. Writes are storage-manager's job — this
// is a read-only view for the API.
package segments

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrNotFound = errors.New("segment not found")

type Segment struct {
	ID         int64     `json:"id"`
	CameraID   string    `json:"camera_id"`
	Path       string    `json:"-"` // never leaked to clients
	StartedAt  time.Time `json:"started_at"`
	EndedAt    *time.Time `json:"ended_at,omitempty"`
	DurationMS *int       `json:"duration_ms,omitempty"`
	Bytes      *int64     `json:"bytes,omitempty"`
	Codec      string     `json:"codec"`
	Protected  bool       `json:"protected"`
	Tier       string     `json:"tier"`
}

type Store struct {
	pool *pgxpool.Pool
}

func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

// ListQuery is the filter set for List. Any zero-value field is ignored.
type ListQuery struct {
	CameraID string
	From     time.Time
	To       time.Time
	Limit    int
}

// List returns segments matching the filter, newest first. If CameraID is
// empty, all cameras are included. If From/To are zero they're ignored.
func (s *Store) List(ctx context.Context, q ListQuery) ([]Segment, error) {
	limit := q.Limit
	if limit <= 0 || limit > 2000 {
		limit = 500
	}

	// Build a simple parameterised query. Keeping it inline is clearer
	// than a builder here — only three filters.
	sql := `SELECT id, camera_id, path, started_at, ended_at, duration_ms,
	               bytes, codec, protected, tier
	        FROM segments WHERE 1=1`
	args := []any{}
	argN := 0
	addArg := func(v any) string {
		argN++
		args = append(args, v)
		return "$" + itoa(argN)
	}
	if q.CameraID != "" {
		sql += " AND camera_id = " + addArg(q.CameraID)
	}
	if !q.From.IsZero() {
		sql += " AND started_at >= " + addArg(q.From)
	}
	if !q.To.IsZero() {
		sql += " AND started_at < " + addArg(q.To)
	}
	sql += " ORDER BY started_at DESC LIMIT " + addArg(limit)

	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]Segment, 0, 64)
	for rows.Next() {
		var s Segment
		if err := rows.Scan(&s.ID, &s.CameraID, &s.Path, &s.StartedAt, &s.EndedAt,
			&s.DurationMS, &s.Bytes, &s.Codec, &s.Protected, &s.Tier); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// Get returns a single segment by id.
func (s *Store) Get(ctx context.Context, id int64) (Segment, error) {
	var seg Segment
	err := s.pool.QueryRow(ctx, `
		SELECT id, camera_id, path, started_at, ended_at, duration_ms,
		       bytes, codec, protected, tier
		FROM segments WHERE id = $1`, id).Scan(
		&seg.ID, &seg.CameraID, &seg.Path, &seg.StartedAt, &seg.EndedAt,
		&seg.DurationMS, &seg.Bytes, &seg.Codec, &seg.Protected, &seg.Tier)
	if errors.Is(err, pgx.ErrNoRows) {
		return Segment{}, ErrNotFound
	}
	if err != nil {
		return Segment{}, err
	}
	return seg, nil
}

// itoa is a tiny int→string helper that avoids pulling in strconv purely
// for query building.
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

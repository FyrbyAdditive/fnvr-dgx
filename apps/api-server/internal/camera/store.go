package camera

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrNotFound = errors.New("camera not found")

type Camera struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	URL           string    `json:"url"`
	Substream     string    `json:"substream,omitempty"`
	RecordMode    string    `json:"record_mode"`
	Enabled       bool      `json:"enabled"`
	RetentionDays int       `json:"retention_days"`
	QuotaGB       int       `json:"quota_gb"`
	GroupID       string    `json:"group_id"`
	// EnabledDetectors is a whitelist of detector kinds (e.g. ["object"]) —
	// empty array means "every detector" (the friendly default so legacy
	// rows behave like they always did).
	EnabledDetectors []string `json:"enabled_detectors"`
	// LocationKind selects which class-mute bucket applies on top of
	// global (indoor/outdoor). nil = no bucket, only global applies.
	LocationKind *string `json:"location_kind,omitempty"`
	// MuteClassesOverride adds classes to the mute set for this camera
	// only (classes muted here even if not in global/location buckets).
	MuteClassesOverride []string `json:"mute_classes_override"`
	// UnmuteClassesOverride removes classes from the resolved mute set
	// for this camera only (re-enables an inherited mute).
	UnmuteClassesOverride []string  `json:"unmute_classes_override"`
	CreatedAt             time.Time `json:"created_at"`
	UpdatedAt             time.Time `json:"updated_at"`
}

type Store struct {
	pool *pgxpool.Pool
}

func NewStore(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

func (s *Store) List(ctx context.Context) ([]Camera, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, name, url, coalesce(substream,''), record_mode, enabled,
		       retention_days, quota_gb, group_id, enabled_detectors,
		       location_kind, mute_classes_override, unmute_classes_override,
		       created_at, updated_at
		FROM cameras ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Camera, 0)
	for rows.Next() {
		var c Camera
		if err := rows.Scan(&c.ID, &c.Name, &c.URL, &c.Substream, &c.RecordMode,
			&c.Enabled, &c.RetentionDays, &c.QuotaGB, &c.GroupID,
			&c.EnabledDetectors, &c.LocationKind, &c.MuteClassesOverride,
			&c.UnmuteClassesOverride, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) Get(ctx context.Context, id string) (Camera, error) {
	var c Camera
	err := s.pool.QueryRow(ctx, `
		SELECT id, name, url, coalesce(substream,''), record_mode, enabled,
		       retention_days, quota_gb, group_id, enabled_detectors,
		       location_kind, mute_classes_override, unmute_classes_override,
		       created_at, updated_at
		FROM cameras WHERE id = $1`, id).
		Scan(&c.ID, &c.Name, &c.URL, &c.Substream, &c.RecordMode, &c.Enabled,
			&c.RetentionDays, &c.QuotaGB, &c.GroupID, &c.EnabledDetectors,
			&c.LocationKind, &c.MuteClassesOverride, &c.UnmuteClassesOverride,
			&c.CreatedAt, &c.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return c, ErrNotFound
	}
	return c, err
}

// SetClassMuting updates any combination of {location_kind, mute_override,
// unmute_override}. Each argument is applied only if non-nil; that way the
// PATCH endpoint can send partial bodies without us having to pre-read the
// row. locKind points to "indoor" / "outdoor" / "" (empty string clears the
// tag and writes NULL); nil leaves it untouched. For the two slices, nil =
// don't change, empty = clear.
func (s *Store) SetClassMuting(ctx context.Context, id string,
	locKind *string, muteOverride, unmuteOverride []string) error {
	// Build the UPDATE dynamically so we only touch the columns that were
	// supplied. Always bumps updated_at.
	sets := []string{"updated_at = NOW()"}
	args := []any{id}
	add := func(v any) string {
		args = append(args, v)
		return "$" + itoa(len(args))
	}
	if locKind != nil {
		if *locKind == "" {
			sets = append(sets, "location_kind = NULL")
		} else {
			if *locKind != "indoor" && *locKind != "outdoor" {
				return errors.New("location_kind must be indoor, outdoor, or empty")
			}
			sets = append(sets, "location_kind = "+add(*locKind))
		}
	}
	if muteOverride != nil {
		sets = append(sets, "mute_classes_override = "+add(muteOverride))
	}
	if unmuteOverride != nil {
		sets = append(sets, "unmute_classes_override = "+add(unmuteOverride))
	}
	sql := "UPDATE cameras SET " + strings.Join(sets, ", ") + " WHERE id = $1"
	tag, err := s.pool.Exec(ctx, sql, args...)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// SetEnabledDetectors replaces the camera's detector whitelist. Nil = "all
// enabled" (empty array on disk). Returns ErrNotFound for unknown id.
func (s *Store) SetEnabledDetectors(ctx context.Context, id string, kinds []string) error {
	if kinds == nil {
		kinds = []string{}
	}
	tag, err := s.pool.Exec(ctx,
		`UPDATE cameras SET enabled_detectors=$2, updated_at=NOW() WHERE id=$1`,
		id, kinds)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) Create(ctx context.Context, c Camera) (Camera, error) {
	if c.RecordMode == "" {
		c.RecordMode = "continuous"
	}
	if c.RetentionDays == 0 {
		c.RetentionDays = 14
	}
	if c.QuotaGB == 0 {
		c.QuotaGB = 200
	}
	if c.GroupID == "" {
		c.GroupID = "default"
	}
	if c.ID == "" {
		id, err := s.uniqueSlug(ctx, c.Name)
		if err != nil {
			return c, err
		}
		c.ID = id
	}
	err := s.pool.QueryRow(ctx, `
		INSERT INTO cameras (id, name, url, substream, record_mode, enabled,
		                     retention_days, quota_gb, group_id)
		VALUES ($1,$2,$3,NULLIF($4,''),$5,true,$6,$7,$8)
		RETURNING created_at, updated_at`,
		c.ID, c.Name, c.URL, c.Substream, c.RecordMode,
		c.RetentionDays, c.QuotaGB, c.GroupID).
		Scan(&c.CreatedAt, &c.UpdatedAt)
	c.Enabled = true
	return c, err
}

var slugStripRe = regexp.MustCompile(`[^a-z0-9]+`)

// slugify converts "Front Door" → "front-door". Falls back to "camera" on
// empty inputs so we always have something to bump with a suffix.
func slugify(s string) string {
	s = strings.ToLower(s)
	s = slugStripRe.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	if s == "" {
		return "camera"
	}
	if len(s) > 48 {
		s = s[:48]
	}
	return s
}

// uniqueSlug turns a display name into a camera ID, bumping with -2, -3…
// on collision. Runs a handful of SELECTs in the worst case; the cameras
// table is small so this is fine.
func (s *Store) uniqueSlug(ctx context.Context, name string) (string, error) {
	base := slugify(name)
	candidate := base
	for i := 2; i < 1000; i++ {
		var exists bool
		err := s.pool.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM cameras WHERE id = $1)`, candidate).Scan(&exists)
		if err != nil {
			return "", err
		}
		if !exists {
			return candidate, nil
		}
		candidate = base + "-" + itoa(i)
	}
	return "", errors.New("could not allocate unique camera id")
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

func (s *Store) Delete(ctx context.Context, id string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM cameras WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) SetEnabled(ctx context.Context, id string, enabled bool) error {
	tag, err := s.pool.Exec(ctx, `UPDATE cameras SET enabled=$1, updated_at=NOW() WHERE id=$2`, enabled, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

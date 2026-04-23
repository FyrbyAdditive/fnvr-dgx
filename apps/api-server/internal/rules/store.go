// Package rules is the api-server-side store for rules + zones + incidents.
// event-processor has its own rules package that consumes these via the DB.
package rules

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrNotFound = errors.New("not found")

type Zone struct {
	ID             string          `json:"id"`
	CameraID       string          `json:"camera_id"`
	Name           string          `json:"name"`
	Kind           string          `json:"kind"`     // polygon | line | tripwire
	Geometry       json.RawMessage `json:"geometry"` // {"points":[x0,y0,x1,y1,...]}
	ExcludeClasses []string        `json:"exclude_classes"`
	ExcludeKinds   []string        `json:"exclude_kinds"`
	CreatedAt      time.Time       `json:"created_at"`
}

type Rule struct {
	ID         string          `json:"id"`
	Name       string          `json:"name"`
	Enabled    bool            `json:"enabled"`
	Definition json.RawMessage `json:"definition"`
	CreatedAt  time.Time       `json:"created_at"`
	UpdatedAt  time.Time       `json:"updated_at"`
}

type Incident struct {
	ID    string  `json:"id"`
	RuleID *string `json:"rule_id"`
	// CameraID is nullable so system-scope incidents (drift alerts,
	// future global ML events) can be represented alongside
	// per-camera ones. Callers that open the recording must guard on
	// this being non-nil.
	CameraID     *string    `json:"camera_id"`
	StartedAt    time.Time  `json:"started_at"`
	EndedAt      *time.Time `json:"ended_at"`
	Severity     string     `json:"severity"`
	Summary      string     `json:"summary"`
	Acknowledged bool       `json:"acknowledged"`
}

type Store struct{ pool *pgxpool.Pool }

func NewStore(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// --- Zones ---

func (s *Store) ListZones(ctx context.Context, cameraID string) ([]Zone, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, camera_id, name, kind, geometry,
		       exclude_classes, exclude_kinds, created_at
		FROM zones
		WHERE ($1 = '' OR camera_id = $1)
		ORDER BY created_at ASC`, cameraID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Zone, 0)
	for rows.Next() {
		var z Zone
		if err := rows.Scan(&z.ID, &z.CameraID, &z.Name, &z.Kind, &z.Geometry,
			&z.ExcludeClasses, &z.ExcludeKinds, &z.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, z)
	}
	return out, rows.Err()
}

func (s *Store) CreateZone(ctx context.Context, z Zone) (Zone, error) {
	if z.Kind == "" {
		z.Kind = "polygon"
	}
	if z.ExcludeClasses == nil {
		z.ExcludeClasses = []string{}
	}
	if z.ExcludeKinds == nil {
		z.ExcludeKinds = []string{}
	}
	err := s.pool.QueryRow(ctx, `
		INSERT INTO zones (camera_id, name, kind, geometry, exclude_classes, exclude_kinds)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id::text, created_at`,
		z.CameraID, z.Name, z.Kind, z.Geometry, z.ExcludeClasses, z.ExcludeKinds).
		Scan(&z.ID, &z.CreatedAt)
	return z, err
}

// UpdateZoneExclusions replaces the exclude_classes + exclude_kinds arrays
// on a zone. Nil inputs are treated as empty (caller may pass []string{}
// explicitly; nil means "clear"). Both arrays are always replaced together
// so partial writes can't leave an old value around.
func (s *Store) UpdateZoneExclusions(ctx context.Context, id string, classes, kinds []string) error {
	if classes == nil {
		classes = []string{}
	}
	if kinds == nil {
		kinds = []string{}
	}
	tag, err := s.pool.Exec(ctx,
		`UPDATE zones SET exclude_classes = $2, exclude_kinds = $3 WHERE id = $1`,
		id, classes, kinds)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) DeleteZone(ctx context.Context, id string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM zones WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// --- Rules ---

func (s *Store) ListRules(ctx context.Context) ([]Rule, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, name, enabled, definition, created_at, updated_at
		FROM rules ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Rule, 0)
	for rows.Next() {
		var r Rule
		if err := rows.Scan(&r.ID, &r.Name, &r.Enabled, &r.Definition, &r.CreatedAt, &r.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) CreateRule(ctx context.Context, r Rule) (Rule, error) {
	err := s.pool.QueryRow(ctx, `
		INSERT INTO rules (name, enabled, definition)
		VALUES ($1, COALESCE($2, TRUE), $3)
		RETURNING id::text, created_at, updated_at`,
		r.Name, r.Enabled, r.Definition).
		Scan(&r.ID, &r.CreatedAt, &r.UpdatedAt)
	return r, err
}

func (s *Store) DeleteRule(ctx context.Context, id string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM rules WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// UpdateRule overwrites name and/or definition on an existing rule.
// Fields passed as nil are left alone. Returns ErrNotFound if no row
// matches.
func (s *Store) UpdateRule(ctx context.Context, id string, name *string, definition json.RawMessage) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE rules
		   SET name = COALESCE($2, name),
		       definition = COALESCE($3, definition),
		       updated_at = NOW()
		 WHERE id = $1`,
		id, name, definition)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) SetRuleEnabled(ctx context.Context, id string, enabled bool) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE rules SET enabled = $1, updated_at = NOW() WHERE id = $2`,
		enabled, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// --- Incidents ---

func (s *Store) ListIncidents(ctx context.Context, limit int) ([]Incident, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, rule_id::text, camera_id, started_at, ended_at,
		       severity, summary, acknowledged
		FROM incidents ORDER BY started_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Incident, 0)
	for rows.Next() {
		var i Incident
		var ruleID *string
		if err := rows.Scan(&i.ID, &ruleID, &i.CameraID, &i.StartedAt, &i.EndedAt,
			&i.Severity, &i.Summary, &i.Acknowledged); err != nil {
			return nil, err
		}
		i.RuleID = ruleID
		out = append(out, i)
	}
	return out, rows.Err()
}

func (s *Store) AcknowledgeIncident(ctx context.Context, id string) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE incidents SET acknowledged = TRUE WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteIncident removes an incident row. Associated notification
// deliveries and subscriptions stay intact (they reference by id and
// will just stop matching). Returns ErrNotFound for unknown id.
func (s *Store) DeleteIncident(ctx context.Context, id string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM incidents WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// scanJSON is a convenience wrapper used only to suppress unused warnings
// when pgx.ErrNoRows is imported elsewhere; left in so future callers can
// resolve via this package.
var _ = pgx.ErrNoRows

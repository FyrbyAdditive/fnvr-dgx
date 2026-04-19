// Package notifications stores user-managed notification channels and the
// subscriptions that bind them to rules / cameras. Wire/delivery lives in
// apps/notification-dispatcher; this is the read/write surface the API
// exposes to the frontend.
package notifications

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrNotFound = errors.New("not found")

type Channel struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Kind      string          `json:"kind"` // webhook | ntfy
	Config    json.RawMessage `json:"config"`
	Enabled   bool            `json:"enabled"`
	CreatedAt time.Time       `json:"created_at"`
	UpdatedAt time.Time       `json:"updated_at"`
}

type Subscription struct {
	ID          string  `json:"id"`
	ChannelID   string  `json:"channel_id"`
	RuleID      *string `json:"rule_id,omitempty"`
	CameraID    *string `json:"camera_id,omitempty"`
	MinSeverity string  `json:"min_severity"`
}

type Delivery struct {
	ID          int64     `json:"id"`
	IncidentID  string    `json:"incident_id"`
	ChannelID   string    `json:"channel_id"`
	AttemptedAt time.Time `json:"attempted_at"`
	Succeeded   bool      `json:"succeeded"`
	StatusCode  *int      `json:"status_code,omitempty"`
	Error       *string   `json:"error,omitempty"`
}

type Store struct {
	pool *pgxpool.Pool
}

func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

// --- channels ---

func (s *Store) ListChannels(ctx context.Context) ([]Channel, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, name, kind, config, enabled, created_at, updated_at
		FROM notification_channels
		ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Channel, 0, 8)
	for rows.Next() {
		var c Channel
		if err := rows.Scan(&c.ID, &c.Name, &c.Kind, &c.Config, &c.Enabled,
			&c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) CreateChannel(ctx context.Context, c Channel) (Channel, error) {
	var out Channel
	err := s.pool.QueryRow(ctx, `
		INSERT INTO notification_channels (name, kind, config, enabled)
		VALUES ($1, $2, $3, COALESCE($4, TRUE))
		RETURNING id::text, name, kind, config, enabled, created_at, updated_at`,
		c.Name, c.Kind, c.Config, c.Enabled).Scan(
		&out.ID, &out.Name, &out.Kind, &out.Config, &out.Enabled,
		&out.CreatedAt, &out.UpdatedAt)
	return out, err
}

func (s *Store) DeleteChannel(ctx context.Context, id string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM notification_channels WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) SetChannelEnabled(ctx context.Context, id string, enabled bool) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE notification_channels SET enabled = $2, updated_at = NOW()
		WHERE id = $1`, id, enabled)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// --- subscriptions ---

func (s *Store) ListSubscriptions(ctx context.Context, channelID string) ([]Subscription, error) {
	q := `SELECT id::text, channel_id::text, rule_id::text, camera_id, min_severity
	      FROM notification_subscriptions`
	args := []any{}
	if channelID != "" {
		q += " WHERE channel_id = $1"
		args = append(args, channelID)
	}
	q += " ORDER BY created_at DESC"
	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Subscription, 0, 8)
	for rows.Next() {
		var sub Subscription
		var rid, cid *string
		if err := rows.Scan(&sub.ID, &sub.ChannelID, &rid, &cid, &sub.MinSeverity); err != nil {
			return nil, err
		}
		sub.RuleID = rid
		sub.CameraID = cid
		out = append(out, sub)
	}
	return out, rows.Err()
}

func (s *Store) CreateSubscription(ctx context.Context, sub Subscription) (Subscription, error) {
	var out Subscription
	var rid, cid *string
	err := s.pool.QueryRow(ctx, `
		INSERT INTO notification_subscriptions (channel_id, rule_id, camera_id, min_severity)
		VALUES ($1::uuid, NULLIF($2,'')::uuid, NULLIF($3,''), COALESCE(NULLIF($4,''), 'info'))
		RETURNING id::text, channel_id::text, rule_id::text, camera_id, min_severity`,
		sub.ChannelID, derefOrEmpty(sub.RuleID), derefOrEmpty(sub.CameraID), sub.MinSeverity).
		Scan(&out.ID, &out.ChannelID, &rid, &cid, &out.MinSeverity)
	out.RuleID = rid
	out.CameraID = cid
	return out, err
}

func (s *Store) DeleteSubscription(ctx context.Context, id string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM notification_subscriptions WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// --- deliveries (read-only, for debugging) ---

func (s *Store) RecentDeliveries(ctx context.Context, limit int) ([]Delivery, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id, incident_id::text, channel_id::text, attempted_at, succeeded, status_code, error
		FROM notification_deliveries
		ORDER BY attempted_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Delivery, 0, limit)
	for rows.Next() {
		var d Delivery
		if err := rows.Scan(&d.ID, &d.IncidentID, &d.ChannelID, &d.AttemptedAt,
			&d.Succeeded, &d.StatusCode, &d.Error); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func derefOrEmpty(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// Unused import guard.
var _ = pgx.ErrNoRows

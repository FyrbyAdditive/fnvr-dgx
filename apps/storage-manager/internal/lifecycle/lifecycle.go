// Package lifecycle owns segment indexing + tiering + purge.
//
// M2 scope:
//   - Walk the recordings tree, insert new segments into Postgres `segments`.
//   - Retention: delete segments older than each camera's retention_days,
//     unless `protected = TRUE`.
//   - Quota: if a camera's total bytes > quota_gb, drop oldest unprotected first.
//
// M3+: tiering (hot → warm → cold), SMART polling, disk-full policy,
// chain-of-custody export manifests.
package lifecycle

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Config struct {
	DatabaseURL   string
	RecordingsDir string
	ScanInterval  time.Duration
}

type Manager struct {
	cfg  Config
	pool *pgxpool.Pool
}

func New(ctx context.Context, cfg Config) (*Manager, error) {
	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, fmt.Errorf("pg: %w", err)
	}
	return &Manager{cfg: cfg, pool: pool}, nil
}

func (m *Manager) Close() {
	if m.pool != nil {
		m.pool.Close()
	}
}

func (m *Manager) Run(ctx context.Context) error {
	t := time.NewTicker(m.cfg.ScanInterval)
	defer t.Stop()
	if err := m.tick(ctx); err != nil {
		slog.Warn("initial tick", "err", err)
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
			if err := m.tick(ctx); err != nil {
				slog.Warn("tick", "err", err)
			}
		}
	}
}

func (m *Manager) tick(ctx context.Context) error {
	if err := m.indexNewSegments(ctx); err != nil {
		return err
	}
	if err := m.applyRetention(ctx); err != nil {
		return err
	}
	if err := m.applyQuota(ctx); err != nil {
		return err
	}
	return nil
}

// indexNewSegments walks recordings dir and upserts any segment not in the DB.
// Directory layout (set by the pipeline):
//
//	<root>/YYYY/MM/DD/HH/<camera-id>/seg-NNNNN.mp4
func (m *Manager) indexNewSegments(ctx context.Context) error {
	root := m.cfg.RecordingsDir
	info, err := os.Stat(root)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("%s is not a directory", root)
	}

	segRe := regexp.MustCompile(`seg-\d+\.mp4$`)

	return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() || !segRe.MatchString(d.Name()) {
			return nil
		}
		// camera id is the segment's parent dir name.
		cameraID := filepath.Base(filepath.Dir(path))
		st, err := os.Stat(path)
		if err != nil {
			return nil
		}
		// Upsert on the unique `path`. A file is tracked once and its `bytes`
		// field updates as the file grows — the pipeline is still appending.
		_, err = m.pool.Exec(ctx, `
			INSERT INTO segments (camera_id, path, started_at, bytes, codec, tier)
			VALUES ($1, $2, $3, $4, 'h264', 'hot')
			ON CONFLICT (path) DO UPDATE
			  SET bytes = EXCLUDED.bytes`,
			cameraID, path, st.ModTime(), st.Size())
		if err != nil && !strings.Contains(err.Error(), "foreign key") {
			slog.Debug("segment insert", "err", err, "path", path)
		}
		return nil
	})
}

func (m *Manager) applyRetention(ctx context.Context) error {
	rows, err := m.pool.Query(ctx, `
		SELECT s.id, s.path
		FROM segments s
		JOIN cameras c ON c.id = s.camera_id
		WHERE s.protected = FALSE
		  AND s.started_at < NOW() - (c.retention_days || ' days')::interval
		LIMIT 500`)
	if err != nil {
		return err
	}
	defer rows.Close()
	deleted := 0
	for rows.Next() {
		var id int64
		var path string
		if err := rows.Scan(&id, &path); err != nil {
			continue
		}
		if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			continue
		}
		_, _ = m.pool.Exec(ctx, `DELETE FROM segments WHERE id=$1`, id)
		deleted++
	}
	if deleted > 0 {
		slog.Info("retention purged", "count", deleted)
	}
	return nil
}

func (m *Manager) applyQuota(ctx context.Context) error {
	rows, err := m.pool.Query(ctx, `
		WITH t AS (
		  SELECT s.camera_id, COALESCE(SUM(s.bytes),0) AS total, c.quota_gb
		  FROM segments s JOIN cameras c ON c.id = s.camera_id
		  GROUP BY s.camera_id, c.quota_gb
		)
		SELECT camera_id, total, quota_gb FROM t WHERE total > quota_gb::bigint * 1073741824`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var camID string
		var total int64
		var quotaGB int
		if err := rows.Scan(&camID, &total, &quotaGB); err != nil {
			continue
		}
		slog.Warn("camera over quota — dropping oldest", "camera", camID, "bytes", total, "quota_gb", quotaGB)
		// Drop oldest unprotected segments until under quota.
		toDrop, err := m.pool.Query(ctx, `
			SELECT id, path, bytes FROM segments
			WHERE camera_id = $1 AND protected = FALSE
			ORDER BY started_at ASC`, camID)
		if err != nil {
			continue
		}
		limit := int64(quotaGB) * 1073741824
		for toDrop.Next() {
			var id, size int64
			var path string
			_ = toDrop.Scan(&id, &path, &size)
			if total <= limit {
				break
			}
			if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
				continue
			}
			_, _ = m.pool.Exec(ctx, `DELETE FROM segments WHERE id=$1`, id)
			total -= size
		}
		toDrop.Close()
	}
	return nil
}

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
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// freeSpacePercent returns the free space percentage (0..100) of the
// filesystem containing `path`. Uses statfs; falls back to error on
// missing / unreadable paths so the caller can skip the check.
func freeSpacePercent(path string) (float64, error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, err
	}
	total := stat.Blocks * uint64(stat.Bsize)
	avail := stat.Bavail * uint64(stat.Bsize)
	if total == 0 {
		return 0, fmt.Errorf("total blocks == 0")
	}
	return 100.0 * float64(avail) / float64(total), nil
}

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
	pcfg, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return nil, fmt.Errorf("pg parse: %w", err)
	}
	pcfg.MaxConns = 16
	pcfg.MinConns = 1
	pool, err := pgxpool.NewWithConfig(ctx, pcfg)
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
	if err := m.applyDiskPressure(ctx); err != nil {
		return err
	}
	if err := m.pruneHotDetections(ctx); err != nil {
		slog.Warn("prune hot detections", "err", err)
	}
	return nil
}

// siblingJsonl maps a recording path to its detection sidecar path:
// rec.mp4 → rec.jsonl, seg-00001.mp4 → seg-00001.jsonl, etc. The sidecar
// is written by event-processor and must be removed whenever the mp4 is
// retention-purged so detection metadata lifecycle matches the video's.
func siblingJsonl(mp4Path string) string {
	if !strings.HasSuffix(mp4Path, ".mp4") {
		return mp4Path + ".jsonl"
	}
	return strings.TrimSuffix(mp4Path, ".mp4") + ".jsonl"
}

// removeSegmentFiles removes both the mp4 and its sidecar JSONL. ENOENT
// on either is fine — the sidecar may legitimately not exist for an
// hour that had zero detections.
func removeSegmentFiles(mp4Path string) error {
	if err := os.Remove(mp4Path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if err := os.Remove(siblingJsonl(mp4Path)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		// Non-fatal: segment is gone, orphaned sidecar will never be
		// read (no matching segments row) and gets swept by a future
		// background pass. Log and continue.
		slog.Warn("sidecar remove", "path", siblingJsonl(mp4Path), "err", err)
	}
	return nil
}

// pruneHotDetections deletes rows from the detections table older than
// settings.detections_hot_hours. Older detections stay available via
// the per-segment .jsonl sidecar files, so this only affects the hot
// path (SSE buffer, rules engine track-history, recent-historic UI).
// Deletes in 10k batches to avoid long locks.
func (m *Manager) pruneHotDetections(ctx context.Context) error {
	var hotHoursRaw []byte
	err := m.pool.QueryRow(ctx,
		`SELECT value FROM settings WHERE key = 'detections.hot_hours'`).Scan(&hotHoursRaw)
	if err != nil {
		// Setting missing — don't prune (conservative). Happens during
		// first boot before migration 0007 runs.
		return nil
	}
	var hotHours int
	if err := json.Unmarshal(hotHoursRaw, &hotHours); err != nil || hotHours <= 0 {
		return nil
	}
	hotHoursStr := fmt.Sprintf("%d", hotHours)
	total := 0
	for i := 0; i < 50 && ctx.Err() == nil; i++ {
		tag, err := m.pool.Exec(ctx, `
			DELETE FROM detections
			WHERE id IN (
			  SELECT id FROM detections
			  WHERE ts < NOW() - ($1 || ' hours')::interval
			  LIMIT 10000
			)`, hotHoursStr)
		if err != nil {
			return err
		}
		n := int(tag.RowsAffected())
		total += n
		if n < 10000 {
			break
		}
	}
	if total > 0 {
		slog.Info("pruned hot detections", "count", total, "hot_hours", hotHours)
	}
	return nil
}

// applyDiskPressure drops the oldest indexed segments when the recordings
// filesystem drops below a free-space floor. Runs as the last guard after
// retention + quota — those are the intended policies; this is "don't let
// the disk fill up whatever happens".
func (m *Manager) applyDiskPressure(ctx context.Context) error {
	freePct, err := freeSpacePercent(m.cfg.RecordingsDir)
	if err != nil {
		return nil // don't fail a tick over a stat error
	}
	// Floor is tunable via settings.storage.min_free_pct so operators
	// on tiny dev disks or giant archive setups can lower/raise without
	// a restart. Cheap single-row SELECT every tick; falls back to 10%
	// on any error.
	minFreePct := loadMinFreePct(ctx, m.pool)
	if freePct < minFreePct {
		slog.Warn("disk pressure: dropping oldest segments",
			"free_pct", freePct, "floor", minFreePct)
	}
	if freePct >= minFreePct {
		return nil
	}

	rows, err := m.pool.Query(ctx, `
		SELECT id, path, bytes FROM segments
		WHERE protected = FALSE
		ORDER BY started_at ASC
		LIMIT 500`)
	if err != nil {
		return err
	}
	defer rows.Close()
	dropped := 0
	for rows.Next() {
		var id, size int64
		var path string
		if err := rows.Scan(&id, &path, &size); err != nil {
			continue
		}
		if err := removeSegmentFiles(path); err != nil {
			continue
		}
		_, _ = m.pool.Exec(ctx, `DELETE FROM segments WHERE id=$1`, id)
		dropped++
		// Re-check free space every 20 files so we stop as soon as we're
		// above the floor rather than dumping the whole oldest batch.
		if dropped%20 == 0 {
			if pct, err := freeSpacePercent(m.cfg.RecordingsDir); err == nil && pct >= minFreePct {
				break
			}
		}
	}
	if dropped > 0 {
		slog.Warn("disk pressure purged", "count", dropped)
	}
	return nil
}

// indexNewSegments walks recordings dir and upserts any segment not in the DB.
// Directory layout (MediaMTX recordPath
// `/var/lib/fnvr/recordings/%path/%Y-%m-%d_%H-%M-%S-%f`):
//
//	<root>/live_<camera-id>/YYYY-MM-DD_HH-MM-SS-ffffff.mp4
//
// The `live_` prefix is set by pipeline.cpp's rtspclientsink target
// path (rtsp://mediamtx:8554/live_<cam>); strip it to recover the
// camera id. The filename's timestamp is the segment's started_at —
// far more accurate than mtime because mtime advances as MediaMTX
// flushes fragments mid-segment.
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

	// MediaMTX filename pattern: 2026-04-28_15-19-14-694879.mp4.
	// %f produces 6-digit microseconds.
	mtxRe := regexp.MustCompile(`^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})-(\d{6})\.mp4$`)

	return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			return nil
		}
		match := mtxRe.FindStringSubmatch(d.Name())
		if match == nil {
			return nil
		}
		// Parent dir name is `live_<camera_id>` per pipeline.cpp's
		// rtspclientsink target. Strip the prefix; if it doesn't
		// match this layout (e.g. MediaMTX's `test` path), drop the
		// file from indexing — those aren't real cameras.
		parent := filepath.Base(filepath.Dir(path))
		const livePrefix = "live_"
		if !strings.HasPrefix(parent, livePrefix) {
			return nil
		}
		cameraID := parent[len(livePrefix):]
		// Started_at from the filename is reliable (MediaMTX names
		// the file at fragment-open). Use UTC since MediaMTX
		// formats with the container's clock which we keep on UTC.
		startedAt, perr := time.Parse(
			"2006-01-02_15-04-05",
			match[1]+"_"+match[2]+"-"+match[3]+"-"+match[4],
		)
		if perr != nil {
			return nil
		}
		st, err := os.Stat(path)
		if err != nil {
			return nil
		}
		// ended_at = mtime; updated each scan as MediaMTX appends.
		// Codec is unknown without ffprobe; the pipeline's rtspclientsink
		// passthrough preserves source codec, but we don't record that
		// here — the timeline player doesn't need codec to call
		// MediaMTX /get. Stamp 'h264' as a default so downstream code
		// expecting a non-empty codec value doesn't break; the actual
		// stream codec is whatever's on disk.
		mtime := st.ModTime()
		_, err = m.pool.Exec(ctx, `
			INSERT INTO segments (camera_id, path, started_at, ended_at,
			                     bytes, codec, tier, duration_ms)
			VALUES ($1, $2, $3, $4, $5, 'h264', 'hot',
			        GREATEST(0, EXTRACT(EPOCH FROM ($4::timestamptz - $3::timestamptz))*1000)::int)
			ON CONFLICT (path) DO UPDATE
			  SET bytes       = EXCLUDED.bytes,
			      ended_at    = EXCLUDED.ended_at,
			      duration_ms = GREATEST(0, EXTRACT(EPOCH FROM
			                    (EXCLUDED.ended_at - segments.started_at))*1000)::int`,
			cameraID, path, startedAt, mtime, st.Size())
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
		if err := removeSegmentFiles(path); err != nil {
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
			if err := removeSegmentFiles(path); err != nil {
				continue
			}
			_, _ = m.pool.Exec(ctx, `DELETE FROM segments WHERE id=$1`, id)
			total -= size
		}
		toDrop.Close()
	}
	return nil
}

// loadMinFreePct reads settings.storage.min_free_pct as a JSON number.
// Falls back to 10.0 on any failure (missing row, bad JSON, out of the
// [0, 50] sanity range) so a corrupt setting can't disable the
// emergency-purge safety net. Same pattern api-server uses when
// returning the value on /system/storage, so scraped values match.
func loadMinFreePct(ctx context.Context, pool *pgxpool.Pool) float64 {
	const def = 10.0
	var raw []byte
	err := pool.QueryRow(ctx,
		`SELECT value FROM settings WHERE key = 'storage.min_free_pct'`).Scan(&raw)
	if err != nil {
		return def
	}
	var v float64
	if err := json.Unmarshal(raw, &v); err != nil || v < 0 || v > 50 {
		return def
	}
	return v
}

package server

import (
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"net/http"
	"time"

	"github.com/fnvr/fnvr/apps/api-server/internal/system"
)

// handleSystemStorage returns one blob with everything the web Storage
// dashboard needs: disk-level free/total/pct, the configured emergency
// purge floor, and per-camera byte totals + derived days-of-headroom.
// Read-only; safe for viewers.
func (s *Server) handleSystemStorage(w http.ResponseWriter, r *http.Request) {
	type camRow struct {
		ID              string    `json:"id"`
		Name            string    `json:"name"`
		RetentionDays   int       `json:"retention_days"`
		QuotaGB         int       `json:"quota_gb"`
		BytesUsed       int64     `json:"bytes_used"`
		OldestSegment   *time.Time `json:"oldest_segment"`
		NewestSegment   *time.Time `json:"newest_segment"`
		SegmentCount    int64     `json:"segment_count"`
		GBPerDay        float64   `json:"gb_per_day"`
		DaysOfHeadroom  *float64  `json:"days_of_headroom"`
	}
	type resp struct {
		Disk       system.DiskUsage `json:"disk"`
		MinFreePct float64          `json:"min_free_pct"`
		Cameras    []camRow         `json:"cameras"`
	}

	// Recordings live under ${DataDir}/recordings by convention (see
	// docker-compose FNVR_RECORDINGS_DIR + storage-manager default).
	recordingsPath := s.cfg.DataDir + "/recordings"
	du, err := system.StatDisk(recordingsPath)
	if err != nil {
		// Fall back to DataDir itself so we still return *something*
		// useful on a fresh install without the recordings dir.
		du, err = system.StatDisk(s.cfg.DataDir)
		if err != nil {
			slog.Warn("statfs", "path", recordingsPath, "err", err)
		}
	}

	minFree := s.loadMinFreePct(r.Context())

	rows, err := s.pool.Query(r.Context(), `
		SELECT c.id, c.name, c.retention_days, c.quota_gb,
		       COALESCE(SUM(s.bytes), 0) AS bytes_used,
		       MIN(s.started_at)          AS oldest,
		       MAX(s.ended_at)            AS newest,
		       COUNT(s.id)                AS n
		FROM cameras c
		LEFT JOIN segments s ON s.camera_id = c.id
		GROUP BY c.id, c.name, c.retention_days, c.quota_gb
		ORDER BY c.name`)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()
	now := time.Now()
	out := resp{Disk: du, MinFreePct: minFree, Cameras: []camRow{}}
	for rows.Next() {
		var c camRow
		if err := rows.Scan(&c.ID, &c.Name, &c.RetentionDays, &c.QuotaGB,
			&c.BytesUsed, &c.OldestSegment, &c.NewestSegment, &c.SegmentCount); err != nil {
			continue
		}
		// gb_per_day — age-based so a camera added 2 hours ago doesn't
		// report thousands of GB/day from a burst of initial indexing.
		// Floor the age at 1 day so short-lived samples just report
		// their cumulative GB (still gives a usable lower bound).
		if c.OldestSegment != nil {
			ageDays := now.Sub(*c.OldestSegment).Hours() / 24.0
			if ageDays < 1 {
				ageDays = 1
			}
			c.GBPerDay = bytesToGB(c.BytesUsed) / ageDays
		}
		// days_of_headroom = min(retention, remaining-quota / rate).
		// Null when we can't divide sensibly.
		if c.GBPerDay > 0 {
			remainingGB := float64(c.QuotaGB) - bytesToGB(c.BytesUsed)
			if remainingGB < 0 {
				remainingGB = 0
			}
			fromQuota := remainingGB / c.GBPerDay
			h := math.Min(float64(c.RetentionDays), fromQuota)
			if h < 0 {
				h = 0
			}
			c.DaysOfHeadroom = &h
		}
		out.Cameras = append(out.Cameras, c)
	}
	writeJSON(w, http.StatusOK, out)
}

func bytesToGB(b int64) float64 {
	return float64(b) / (1024.0 * 1024.0 * 1024.0)
}

// loadMinFreePct reads the configurable emergency-purge floor from the
// settings table. Falls back to 10.0 on any error so a missing setting
// or bad JSON can't break the /storage endpoint.
func (s *Server) loadMinFreePct(ctx context.Context) float64 {
	const def = 10.0
	if s.settings == nil {
		return def
	}
	raw, err := s.settings.Get(ctx, "storage.min_free_pct")
	if err != nil {
		return def
	}
	var v float64
	if err := json.Unmarshal(raw, &v); err != nil || v < 0 || v > 50 {
		return def
	}
	return v
}

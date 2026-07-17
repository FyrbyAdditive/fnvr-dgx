package lifecycle

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"log/slog"
)

// Face-crop JPEG retention. The pipeline writes a 256×256 crop for
// every published face detection into /var/lib/fnvr/thumbs/faces —
// historically with NO cleanup, so the directory grew without bound
// (only GDPR erasure ever deleted anything). This pass prunes crops
// older than faces.thumbs_retention_days UNLESS they're referenced as
// enrolled-person evidence (face_embeddings.detection_id → the
// post-rename {pg_id}.jpg names, or upload-enrol's upload-<sha8>
// sources).
//
// Race safety: enrolment can only ever reference thumbs from the
// recent-faces feed (≤168h) or clusters (≤7d), and the retention
// floor is 8 days (enforced by the settings whitelist AND re-clamped
// here) — so a concurrent enrolment can never reference a file this
// pass is about to unlink. GDPR erasure deletes from the same dir
// independently; both sides tolerate ENOENT.

func loadFaceThumbRetentionDays(ctx context.Context, m *Manager) int {
	const def = 30
	var raw []byte
	err := m.pool.QueryRow(ctx,
		`SELECT value FROM settings WHERE key = 'faces.thumbs_retention_days'`).Scan(&raw)
	if err != nil {
		return def
	}
	var v int
	if err := json.Unmarshal(raw, &v); err != nil || v < 8 || v > 365 {
		return def
	}
	return v
}

// faceThumbReferenced decides whether a filename is enrolled-person
// evidence that must be kept regardless of age. Pure — unit-tested.
// Hex {event_id}.jpg orphans (pre-rename rows, crashed candidate
// stashes) are never referenced and age out. An all-digit hex id that
// collides with an enrolled pg id keeps the file — the fail-safe
// direction, and vanishingly unlikely.
func faceThumbReferenced(name string, keepIDs map[int64]struct{}, keepUploads map[string]struct{}) bool {
	base := strings.TrimSuffix(name, ".jpg")
	if strings.HasPrefix(base, "upload-") {
		_, ok := keepUploads[base]
		return ok
	}
	if id, err := strconv.ParseInt(base, 10, 64); err == nil {
		_, ok := keepIDs[id]
		return ok
	}
	return false
}

// pruneFaceThumbDir walks one directory applying the keep-sets and
// age cutoff. Split from the DB loading so tests run on a TempDir
// with stubbed sets. Returns (deleted, kept-by-reference).
func pruneFaceThumbDir(dir string, cutoff time.Time,
	keepIDs map[int64]struct{}, keepUploads map[string]struct{}) (int, int) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0, 0 // dir absent (face id never enabled) — nothing to do
	}
	deleted, kept := 0, 0
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jpg") {
			continue
		}
		if faceThumbReferenced(e.Name(), keepIDs, keepUploads) {
			kept++
			continue
		}
		info, err := e.Info()
		if err != nil || !info.ModTime().Before(cutoff) {
			continue
		}
		if err := os.Remove(filepath.Join(dir, e.Name())); err == nil {
			deleted++
		}
	}
	return deleted, kept
}

func (m *Manager) pruneFaceThumbs(ctx context.Context) error {
	days := loadFaceThumbRetentionDays(ctx, m)
	cutoff := time.Now().Add(-time.Duration(days) * 24 * time.Hour)

	keepIDs := map[int64]struct{}{}
	rows, err := m.pool.Query(ctx,
		`SELECT DISTINCT detection_id FROM face_embeddings WHERE detection_id IS NOT NULL`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil {
			keepIDs[id] = struct{}{}
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	keepUploads := map[string]struct{}{}
	rows, err = m.pool.Query(ctx,
		`SELECT DISTINCT source FROM face_embeddings WHERE source LIKE 'upload-%'`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var s string
		if rows.Scan(&s) == nil {
			keepUploads[s] = struct{}{}
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	deleted, kept := pruneFaceThumbDir(m.cfg.FaceThumbsDir, cutoff, keepIDs, keepUploads)
	if deleted > 0 {
		slog.Info("pruned face thumbs", "deleted", deleted,
			"kept_enrolled", kept, "retention_days", days)
	}
	return nil
}

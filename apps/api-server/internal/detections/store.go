// Package detections serves historic detection events to the Timeline
// UI. Recent events live in Postgres (`detections` table); older events
// live in per-segment JSONL sidecar files written by event-processor
// and colocated with each rec.mp4 on the recordings volume. This store
// transparently unions the two so the UI doesn't care where a given
// detection came from.
//
// The hot-window size (in hours) comes from the settings table — same
// value used by storage-manager's pruner — so the boundary is
// consistent across services without a shared config.
package detections

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/fnvr/fnvr/apps/api-server/internal/segments"
)

type Store struct {
	pool     *pgxpool.Pool
	segments *segments.Store
	root     string // /var/lib/fnvr/recordings
}

func NewStore(pool *pgxpool.Pool, segs *segments.Store, root string) *Store {
	return &Store{pool: pool, segments: segs, root: filepath.Clean(root)}
}

// Row is the on-wire shape the Timeline UI consumes. Matches the
// existing handler output so frontend changes aren't needed.
type Row struct {
	ID         int64           `json:"id"`
	EventID    string          `json:"event_id"`
	CameraID   string          `json:"camera_id"`
	TS         time.Time       `json:"ts"`
	ClassName  string          `json:"class_name"`
	Confidence float32         `json:"confidence"`
	BBox       json.RawMessage `json:"bbox"`
	TrackID    *string         `json:"track_id,omitempty"`
}

type ListArgs struct {
	CameraID string
	From     time.Time
	To       time.Time
	Limit    int
}

// List returns detections in the requested time range, sorted newest-
// first, capped at Limit. The boundary between Postgres and sidecar
// JSONL is settings.detections_hot_hours.
func (s *Store) List(ctx context.Context, a ListArgs) ([]Row, error) {
	if a.Limit <= 0 || a.Limit > 10_000 {
		a.Limit = 2000
	}
	now := time.Now()
	hotHours, _ := s.hotHours(ctx)
	var hotCutoff time.Time
	if hotHours > 0 {
		hotCutoff = now.Add(-time.Duration(hotHours) * time.Hour)
	}

	// Fast path: request entirely within the hot window, or no time
	// bound given at all (caller just wants recent). Straight PG query.
	if a.From.IsZero() || a.From.After(hotCutoff) || hotCutoff.IsZero() {
		return s.queryPG(ctx, a, a.From, a.To, a.Limit)
	}

	// Mixed path: cold range from sidecars, hot range from PG, unioned
	// and truncated to limit.
	coldTo := a.To
	if !a.To.IsZero() && a.To.After(hotCutoff) {
		coldTo = hotCutoff
	} else if a.To.IsZero() {
		coldTo = hotCutoff
	}
	cold, err := s.querySidecars(ctx, a, a.From, coldTo, a.Limit)
	if err != nil {
		return nil, err
	}

	var hot []Row
	if a.To.IsZero() || a.To.After(hotCutoff) {
		hot, err = s.queryPG(ctx, a, hotCutoff, a.To, a.Limit)
		if err != nil {
			return nil, err
		}
	}

	merged := append(hot, cold...)
	sort.Slice(merged, func(i, j int) bool {
		return merged[i].TS.After(merged[j].TS)
	})
	if len(merged) > a.Limit {
		merged = merged[:a.Limit]
	}
	return merged, nil
}

func (s *Store) hotHours(ctx context.Context) (int, error) {
	var raw []byte
	err := s.pool.QueryRow(ctx,
		`SELECT value FROM settings WHERE key='detections.hot_hours'`).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return 24, nil
	}
	if err != nil {
		return 24, err
	}
	var h int
	if err := json.Unmarshal(raw, &h); err != nil || h <= 0 {
		return 24, nil
	}
	return h, nil
}

func (s *Store) queryPG(ctx context.Context, a ListArgs, from, to time.Time, limit int) ([]Row, error) {
	sql := `SELECT id, event_id, camera_id, ts, class_name, confidence, bbox, track_id
	        FROM detections WHERE 1=1`
	args := []any{}
	addArg := func(v any) string {
		args = append(args, v)
		return "$" + strconv.Itoa(len(args))
	}
	if a.CameraID != "" {
		sql += " AND camera_id = " + addArg(a.CameraID)
	}
	if !from.IsZero() {
		sql += " AND ts >= " + addArg(from)
	}
	if !to.IsZero() {
		sql += " AND ts < " + addArg(to)
	}
	sql += " ORDER BY ts DESC LIMIT " + addArg(limit)

	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]Row, 0, 256)
	for rows.Next() {
		var r Row
		if err := rows.Scan(&r.ID, &r.EventID, &r.CameraID, &r.TS, &r.ClassName,
			&r.Confidence, &r.BBox, &r.TrackID); err != nil {
			continue
		}
		r.BBox = normaliseBBox(r.BBox)
		out = append(out, r)
	}
	return out, rows.Err()
}

// querySidecars enumerates segments overlapping [from, to] for the
// camera and reads their rec.jsonl files. Malformed lines are skipped.
// Result is unsorted (caller merges and re-sorts).
func (s *Store) querySidecars(ctx context.Context, a ListArgs, from, to time.Time, limit int) ([]Row, error) {
	segs, err := s.segments.List(ctx, segments.ListQuery{
		CameraID: a.CameraID,
		From:     from,
		To:       to,
		Limit:    2000,
	})
	if err != nil {
		return nil, err
	}
	out := make([]Row, 0, 256)
	for _, seg := range segs {
		if len(out) >= limit {
			break
		}
		// Guard path is under recordings root. Reused pattern from
		// handleSegmentFile.
		clean := filepath.Clean(seg.Path)
		if !strings.HasPrefix(clean+string(filepath.Separator), s.root+string(filepath.Separator)) {
			continue
		}
		sidecar := sidecarPath(clean)
		rows, err := s.readSidecar(sidecar, a.CameraID, from, to, limit-len(out))
		if err != nil {
			// Missing sidecar = hour had zero detections, or an older
			// segment predating the sidecar feature. Not an error.
			if !errors.Is(err, fs.ErrNotExist) {
				// Log via standard library — Store has no logger.
				// A caller using slog will see errors via returned
				// values; here we just continue to next segment.
			}
			continue
		}
		out = append(out, rows...)
	}
	return out, nil
}

func (s *Store) readSidecar(path, cameraFilter string, from, to time.Time, cap int) ([]Row, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), 256*1024)

	out := make([]Row, 0, 64)
	// Derive a stable per-file hash for the row ID. Sidecar rows have
	// no PG BIGSERIAL — we synthesize negative IDs deterministically so
	// React keys + any "seek to this detection" lookups stay stable
	// across requests and don't collide between files.
	pathHash := fnv64(path)
	for scanner.Scan() {
		if len(out) >= cap {
			break
		}
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		// Decoded as a generic event then reshaped to Row. The pipeline
		// serialises with lowercase bbox keys, so BBox is already ready.
		var ev sidecarEvent
		if err := json.Unmarshal(line, &ev); err != nil {
			// Truncated last line or garbage — skip.
			continue
		}
		if cameraFilter != "" && ev.CameraID != cameraFilter {
			continue
		}
		if !from.IsZero() && ev.TS.Before(from) {
			continue
		}
		if !to.IsZero() && !ev.TS.Before(to) {
			continue
		}
		// ID = negative 63-bit hash of (path, event_id) — unique per
		// event across files, never collides with PG BIGSERIAL (which
		// is always positive).
		id := int64(fnv64Combine(pathHash, ev.ID)) & 0x7fffffffffffffff
		if id == 0 {
			id = 1
		}
		r := Row{
			ID:         -id,
			EventID:    ev.ID,
			CameraID:   ev.CameraID,
			TS:         ev.TS,
			ClassName:  ev.ClassName,
			Confidence: ev.Confidence,
			BBox:       ev.BBox,
		}
		if ev.TrackID != "" {
			tid := ev.TrackID
			r.TrackID = &tid
		}
		out = append(out, r)
	}
	if err := scanner.Err(); err != nil {
		return out, fmt.Errorf("scan %s: %w", path, err)
	}
	return out, nil
}

// fnv64 / fnv64Combine: tiny inline FNV-1a over strings. Used to
// synthesize stable IDs for sidecar rows (no external dep).
func fnv64(s string) uint64 {
	const off, prime uint64 = 14695981039346656037, 1099511628211
	h := off
	for i := 0; i < len(s); i++ {
		h ^= uint64(s[i])
		h *= prime
	}
	return h
}
func fnv64Combine(seed uint64, s string) uint64 {
	const prime uint64 = 1099511628211
	h := seed
	for i := 0; i < len(s); i++ {
		h ^= uint64(s[i])
		h *= prime
	}
	return h
}

type sidecarEvent struct {
	ID         string          `json:"id"`
	CameraID   string          `json:"camera_id"`
	TS         time.Time       `json:"ts"`
	ClassName  string          `json:"class_name"`
	Kind       string          `json:"kind,omitempty"`
	Confidence float32         `json:"confidence"`
	BBox       json.RawMessage `json:"bbox"`
	TrackID    string          `json:"track_id,omitempty"`
}

// sidecarPath derives the JSONL sidecar path from an mp4 path.
// Mirrors storage-manager.siblingJsonl so naming stays in sync.
func sidecarPath(mp4 string) string {
	if !strings.HasSuffix(mp4, ".mp4") {
		return mp4 + ".jsonl"
	}
	return strings.TrimSuffix(mp4, ".mp4") + ".jsonl"
}

// normaliseBBox rewrites {X,Y,W,H} keys to {x,y,w,h}. Duplicated from
// server/segments.go so the Store is self-contained; both call sites
// do the same normalisation.
func normaliseBBox(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return raw
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return raw
	}
	if _, hasLower := m["x"]; hasLower {
		return raw
	}
	if _, hasUpper := m["X"]; !hasUpper {
		return raw
	}
	out := map[string]any{}
	for k, v := range m {
		switch k {
		case "X":
			out["x"] = v
		case "Y":
			out["y"] = v
		case "W":
			out["w"] = v
		case "H":
			out["h"] = v
		default:
			out[k] = v
		}
	}
	b, err := json.Marshal(out)
	if err != nil {
		return raw
	}
	return b
}

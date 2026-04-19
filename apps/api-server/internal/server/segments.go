package server

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/fnvr/fnvr/apps/api-server/internal/segments"
)

// handleListSegments: GET /api/v1/segments?camera_id=X&from=RFC3339&to=RFC3339&limit=N
func (s *Server) handleListSegments(w http.ResponseWriter, r *http.Request) {
	q := segments.ListQuery{
		CameraID: r.URL.Query().Get("camera_id"),
	}
	if v := r.URL.Query().Get("from"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			http.Error(w, "bad 'from' (need RFC3339)", http.StatusBadRequest)
			return
		}
		q.From = t
	}
	if v := r.URL.Query().Get("to"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			http.Error(w, "bad 'to' (need RFC3339)", http.StatusBadRequest)
			return
		}
		q.To = t
	}
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err == nil {
			q.Limit = n
		}
	}
	out, err := s.segments.List(r.Context(), q)
	if err != nil {
		slog.Error("list segments", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// handleSegmentFile: GET /api/v1/segments/{id}/file — streams MP4 with
// Range support (http.ServeContent does the heavy lifting).
func (s *Server) handleSegmentFile(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	seg, err := s.segments.Get(r.Context(), id)
	if errors.Is(err, segments.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	// Defense-in-depth: only allow paths under the configured recordings
	// root. storage-manager writes the path from its own walk, but we
	// double-check here because this is the serving boundary.
	root := filepath.Clean(s.cfg.DataDir + "/recordings")
	clean := filepath.Clean(seg.Path)
	if !strings.HasPrefix(clean+string(filepath.Separator), root+string(filepath.Separator)) {
		slog.Warn("segment path escapes root", "path", seg.Path, "root", root)
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	f, err := os.Open(clean)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			http.Error(w, "file missing (purged?)", http.StatusGone)
			return
		}
		slog.Error("open segment", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Accept-Ranges", "bytes")
	// Short cache — segments don't change once closed, but "hot" ones may
	// still be appending while a browser replays them.
	w.Header().Set("Cache-Control", "private, max-age=5")
	http.ServeContent(w, r, filepath.Base(clean), st.ModTime(), f)
}

// handleListDetections: GET /api/v1/detections?camera_id=X&from=TS&to=TS&limit=N
//
// Returns historic detections from Postgres for rendering event pins on the
// timeline. Live-streaming detections go through SSE — this is the archival
// read path.
func (s *Server) handleListDetections(w http.ResponseWriter, r *http.Request) {
	cameraID := r.URL.Query().Get("camera_id")
	limit := 2000
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 10000 {
			limit = n
		}
	}
	var fromT, toT time.Time
	if v := r.URL.Query().Get("from"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			http.Error(w, "bad 'from'", http.StatusBadRequest)
			return
		}
		fromT = t
	}
	if v := r.URL.Query().Get("to"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			http.Error(w, "bad 'to'", http.StatusBadRequest)
			return
		}
		toT = t
	}

	sql := `SELECT id, event_id, camera_id, ts, class_name, confidence, bbox, track_id
	        FROM detections WHERE 1=1`
	args := []any{}
	argN := 0
	add := func(v any) string {
		argN++
		args = append(args, v)
		return "$" + strconv.Itoa(argN)
	}
	if cameraID != "" {
		sql += " AND camera_id = " + add(cameraID)
	}
	if !fromT.IsZero() {
		sql += " AND ts >= " + add(fromT)
	}
	if !toT.IsZero() {
		sql += " AND ts < " + add(toT)
	}
	sql += " ORDER BY ts DESC LIMIT " + add(limit)

	rows, err := s.pool.Query(r.Context(), sql, args...)
	if err != nil {
		slog.Error("list detections", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	type outRow struct {
		ID         int64           `json:"id"`
		EventID    string          `json:"event_id"`
		CameraID   string          `json:"camera_id"`
		TS         time.Time       `json:"ts"`
		ClassName  string          `json:"class_name"`
		Confidence float32         `json:"confidence"`
		BBox       json.RawMessage `json:"bbox"`
		TrackID    *string         `json:"track_id,omitempty"`
	}
	out := make([]outRow, 0, 256)
	for rows.Next() {
		var o outRow
		if err := rows.Scan(&o.ID, &o.EventID, &o.CameraID, &o.TS, &o.ClassName,
			&o.Confidence, &o.BBox, &o.TrackID); err != nil {
			continue
		}
		// Older rows were written before the engine grew lowercase JSON
		// tags — normalise keys here so the frontend sees a single shape.
		o.BBox = normaliseBBox(o.BBox)
		out = append(out, o)
	}
	writeJSON(w, http.StatusOK, out)
}

// normaliseBBox rewrites {X,Y,W,H} keys to {x,y,w,h}. A no-op for already-
// normalised rows. Cheap enough to run on every response.
func normaliseBBox(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return raw
	}
	var m map[string]float32
	if err := json.Unmarshal(raw, &m); err != nil {
		return raw
	}
	needs := false
	for k := range m {
		if k == "X" || k == "Y" || k == "W" || k == "H" {
			needs = true
			break
		}
	}
	if !needs {
		return raw
	}
	out := map[string]float32{
		"x": m["X"] + m["x"],
		"y": m["Y"] + m["y"],
		"w": m["W"] + m["w"],
		"h": m["H"] + m["h"],
	}
	b, err := json.Marshal(out)
	if err != nil {
		return raw
	}
	return b
}

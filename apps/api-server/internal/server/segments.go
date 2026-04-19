package server

import (
	"errors"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/fnvr/fnvr/apps/api-server/internal/detections"
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
// Thin adapter over detections.Store.List — the store merges Postgres
// (recent) + per-segment JSONL sidecars (older) so the UI sees a single
// unified result whether detections still live in PG or have aged out
// to their rec.jsonl companion files.
func (s *Server) handleListDetections(w http.ResponseWriter, r *http.Request) {
	args := detectionArgsFromRequest(r)
	if args.errResponse != "" {
		http.Error(w, args.errResponse, http.StatusBadRequest)
		return
	}
	out, err := s.detections.List(r.Context(), args.list)
	if err != nil {
		slog.Error("list detections", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

type detectionsReq struct {
	list        detections.ListArgs
	errResponse string
}

func detectionArgsFromRequest(r *http.Request) detectionsReq {
	var req detectionsReq
	req.list.CameraID = r.URL.Query().Get("camera_id")
	req.list.Kind = r.URL.Query().Get("kind")
	req.list.PlatePattern = r.URL.Query().Get("plate")
	req.list.Limit = 2000
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 10000 {
			req.list.Limit = n
		}
	}
	if v := r.URL.Query().Get("from"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			req.errResponse = "bad 'from'"
			return req
		}
		req.list.From = t
	}
	if v := r.URL.Query().Get("to"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			req.errResponse = "bad 'to'"
			return req
		}
		req.list.To = t
	}
	return req
}


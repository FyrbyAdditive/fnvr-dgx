package server

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"time"

	"github.com/fnvr/fnvr/apps/api-server/internal/auth"
	"github.com/fnvr/fnvr/apps/api-server/internal/flags"
)

// handleFlagDetection records a false-positive / relabel flag for a
// detection already in Postgres. The detection row is expected to
// carry `phash` in its `attributes` JSON (emitted by the pipeline
// probe); without it we can't populate the suppression library, so
// we 422 rather than silently creating a flag that won't do
// anything.
//
// Path `:id` is the detection's **event_id** (short hex string, the
// one that lands in the SSE stream) — not the PG row id. We resolve
// to the PG row here so the UI never has to know about the PG id.
//
// Body:
//
//	{"class_corrected": "person" | null}
//
// Null class_corrected = "this is nothing". Non-null must be one of
// the COCO class names — anything else 400s; new-class support is a
// later slice.
func (s *Server) handleFlagDetection(w http.ResponseWriter, r *http.Request) {
	if s.flags == nil {
		http.Error(w, "flags not configured", http.StatusNotImplemented)
		return
	}
	eventID := r.PathValue("id")
	if eventID == "" {
		http.Error(w, "missing event id", http.StatusBadRequest)
		return
	}

	var body struct {
		ClassCorrected *string `json:"class_corrected"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if body.ClassCorrected != nil {
		// Non-null corrections must match a known YOLO class.
		found := false
		for _, c := range flags.CocoClasses {
			if c == *body.ClassCorrected {
				found = true
				break
			}
		}
		if !found {
			http.Error(w, "class_corrected must be one of the COCO 80 classes "+
				"(new classes are not supported yet)", http.StatusBadRequest)
			return
		}
	}

	// The path component may be either the detection's event_id (the
	// short hex string from the pipeline, used by pre-pg_id clients)
	// or the PG row id (numeric, from the accepted-subject payload's
	// `pg_id` field). Try numeric first — it's unambiguous — else fall
	// through to event_id.
	var detID int64
	var cameraID, className string
	var ts time.Time
	var bboxJSON, attrJSON []byte
	var err error
	if pg, convErr := strconv.ParseInt(eventID, 10, 64); convErr == nil && pg > 0 {
		err = s.pool.QueryRow(r.Context(),
			`SELECT id, camera_id, ts, class_name, bbox, attributes
			 FROM detections WHERE id = $1`, pg).
			Scan(&detID, &cameraID, &ts, &className, &bboxJSON, &attrJSON)
	} else {
		err = s.pool.QueryRow(r.Context(),
			`SELECT id, camera_id, ts, class_name, bbox, attributes
			 FROM detections
			 WHERE event_id = $1
			 ORDER BY ts DESC LIMIT 1`, eventID).
			Scan(&detID, &cameraID, &ts, &className, &bboxJSON, &attrJSON)
	}
	if err != nil {
		// Most likely: the detection is already being suppressed by an
		// earlier flag so the current row was never persisted (the SSE
		// bus is on the accepted subject now, so a visible bbox should
		// imply a persisted row — a 404 here usually means the operator
		// is trying to flag the exact detection that spawned the
		// existing flag, or the flag's suppression window includes this
		// frame and they're clicking a stale client-side copy).
		// Secondary cause: the detection is older than
		// settings.detections_hot_hours and has been pruned.
		http.Error(w,
			"no matching detection row. It's likely already suppressed by an "+
				"existing flag for this camera + class — check the Flags page. "+
				"If the detection is older than the hot-retention window "+
				"it may have been pruned.",
			http.StatusNotFound)
		return
	}
	var bbox flags.BBox
	if err := json.Unmarshal(bboxJSON, &bbox); err != nil {
		http.Error(w, "bad bbox in detection row", http.StatusInternalServerError)
		return
	}
	phash, err := extractPHash(attrJSON)
	if err != nil {
		// Missing phash = the pipeline didn't emit one (likely an older
		// detection predating this slice). Refuse to flag; the UI can
		// message this.
		http.Error(w, "detection has no phash attribute — cannot flag. "+
			"Wait for a fresh detection of the same scene.",
			http.StatusUnprocessableEntity)
		return
	}

	// Capture the current live-preview JPEG for this camera as the
	// dataset frame. The pipeline writes these at 1 fps so timing
	// drift against the detection is ≤500 ms.
	jpegSrc, err := latestLiveJPEG(s.cfg.DataDir, cameraID)
	if err != nil {
		slog.Warn("flag: latest live jpeg missing",
			"camera", cameraID, "err", err)
		http.Error(w, "no recent live frame for this camera",
			http.StatusServiceUnavailable)
		return
	}

	// Write the dataset artefacts. We synthesise a placeholder flag
	// id by reserving one via a DB sequence advance, so the files can
	// be named before the row is inserted. Simpler in practice:
	// insert first with placeholder paths, then WriteArtifacts, then
	// UPDATE the row with the real paths. Keeps the filesystem and
	// the row atomic (the row exists without files only for a few
	// milliseconds before paths are patched).
	created, err := s.flags.Create(r.Context(), flags.CreateArgs{
		DetectionID:    detID,
		CameraID:       cameraID,
		TS:             ts,
		ClassOriginal:  className,
		ClassCorrected: body.ClassCorrected,
		BBox:           bbox,
		PHash:          phash,
		FramePath:      "", // filled after WriteArtifacts
		LabelPath:      "",
		CreatedBy:      sessionUserID(r),
	})
	if err != nil {
		slog.Error("flag: create failed", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	framePath, labelPath, err := flags.WriteArtifacts(
		s.cfg.DataDir, created.ID, jpegSrc, bbox, body.ClassCorrected)
	if err != nil {
		// Best-effort rollback: soft-dismiss the orphaned row so the
		// suppression library doesn't pick it up with empty paths.
		_, _ = s.flags.Dismiss(r.Context(), created.ID)
		slog.Error("flag: write artefacts", "flag_id", created.ID, "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	// Patch the paths on the row.
	if _, err := s.pool.Exec(r.Context(),
		`UPDATE object_flags SET frame_path=$1, label_path=$2 WHERE id=$3`,
		framePath, labelPath, created.ID); err != nil {
		slog.Error("flag: patch paths", "flag_id", created.ID, "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	created.FramePath = framePath
	created.LabelPath = labelPath

	if err := flags.RegenerateDatasetYAML(s.cfg.DataDir); err != nil {
		slog.Warn("flag: regenerate dataset.yaml", "err", err)
		// Non-fatal — the YAML can be regenerated later via any
		// subsequent flag or dismissal.
	}

	writeJSON(w, http.StatusCreated, created)
}

func (s *Server) handleListFlags(w http.ResponseWriter, r *http.Request) {
	if s.flags == nil {
		writeJSON(w, http.StatusOK, []struct{}{})
		return
	}
	q := r.URL.Query()
	filter := flags.ListFilter{
		CameraID:         q.Get("camera_id"),
		ClassOriginal:    q.Get("class_original"),
		IncludeDismissed: q.Get("dismissed") == "1",
	}
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			filter.Limit = n
		}
	}
	out, err := s.flags.List(r.Context(), filter)
	if err != nil {
		slog.Error("flags list", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleDismissFlag(w http.ResponseWriter, r *http.Request) {
	if s.flags == nil {
		http.Error(w, "flags not configured", http.StatusNotImplemented)
		return
	}
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "bad flag id", http.StatusBadRequest)
		return
	}
	dismissed, err := s.flags.Dismiss(r.Context(), id)
	if errors.Is(err, flags.ErrNotFound) {
		http.Error(w, "flag not found or already dismissed", http.StatusNotFound)
		return
	}
	if err != nil {
		slog.Error("flags dismiss", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if r.URL.Query().Get("purge") == "true" {
		if err := flags.DeleteFiles(s.cfg.DataDir, dismissed); err != nil {
			slog.Warn("flag: purge files", "err", err)
		}
	}
	if err := flags.RegenerateDatasetYAML(s.cfg.DataDir); err != nil {
		slog.Warn("flag: regenerate dataset.yaml after dismiss", "err", err)
	}
	writeJSON(w, http.StatusOK, dismissed)
}

func (s *Server) handleFlagStats(w http.ResponseWriter, r *http.Request) {
	if s.flags == nil {
		writeJSON(w, http.StatusOK, flags.Stats{ByCamera: map[string]int{}, ByClass: map[string]int{}})
		return
	}
	stats, err := s.flags.Stats(r.Context())
	if err != nil {
		slog.Error("flags stats", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, stats)
}

// handleObjectThumbnail serves the pipeline-cached object-detection
// JPEG. The pipeline writes these under {DataDir}/thumbs/objects/
// keyed by the detection's event_id (short hex string). We look the
// event_id up by PG detection id so the UI can build stable URLs
// from the detection row. 404 for detections predating this slice or
// whose thumb has been pruned.
func (s *Server) handleObjectThumbnail(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("detection_id")
	if i := len(idStr) - 4; i > 0 && idStr[i:] == ".jpg" {
		idStr = idStr[:i]
	}
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	var eventID string
	if err := s.pool.QueryRow(r.Context(),
		`SELECT event_id FROM detections WHERE id = $1`, id).Scan(&eventID); err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if s.cfg == nil || s.cfg.DataDir == "" {
		http.Error(w, "no data dir", http.StatusNotFound)
		return
	}
	path := filepath.Join(s.cfg.DataDir, "thumbs", "objects", eventID+".jpg")
	fd, err := os.Open(path)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	defer fd.Close()
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = io.Copy(w, fd)
}

// --- helpers ---

// extractPHash pulls the 64-bit pHash from a detection row's
// attributes JSONB. Pipeline emits it as 16-char lowercase hex under
// attributes.phash. Missing / malformed → error.
func extractPHash(attrJSON []byte) (uint64, error) {
	if len(attrJSON) == 0 {
		return 0, errors.New("no attributes")
	}
	var attr map[string]json.RawMessage
	if err := json.Unmarshal(attrJSON, &attr); err != nil {
		return 0, err
	}
	raw, ok := attr["phash"]
	if !ok {
		return 0, errors.New("no phash in attributes")
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return 0, err
	}
	if len(s) != 16 {
		return 0, fmt.Errorf("phash wrong length: %d", len(s))
	}
	b, err := hex.DecodeString(s)
	if err != nil {
		return 0, err
	}
	var p uint64
	for _, v := range b {
		p = (p << 8) | uint64(v)
	}
	return p, nil
}

// latestLiveJPEG returns the absolute path of the most recent live
// preview frame for the camera. The pipeline writes a 4-file ring
// under /var/lib/fnvr/live/<camera>.N.jpg at 1 fps via multifilesink.
// We pick whichever file has the newest mtime; typically ≤1 s old.
func latestLiveJPEG(dataDir, cameraID string) (string, error) {
	liveDir := filepath.Join(dataDir, "live")
	entries, err := os.ReadDir(liveDir)
	if err != nil {
		return "", err
	}
	type cand struct {
		path string
		mt   time.Time
	}
	var cands []cand
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		// Match "<camera>.<N>.jpg".
		if len(name) < len(cameraID)+5 {
			continue
		}
		if name[:len(cameraID)] != cameraID {
			continue
		}
		if name[len(cameraID)] != '.' {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		cands = append(cands, cand{
			path: filepath.Join(liveDir, name),
			mt:   info.ModTime(),
		})
	}
	if len(cands) == 0 {
		return "", errors.New("no live frames for camera")
	}
	sort.Slice(cands, func(i, j int) bool { return cands[i].mt.After(cands[j].mt) })
	return cands[0].path, nil
}

// sessionUserID extracts the UUID of the logged-in user from the
// request context; nil if the caller is an API-token session without
// a user id attached, or a request somehow bypassed the auth
// middleware. Kept resilient so a missing session doesn't reject the
// flag — created_by is audit only.
func sessionUserID(r *http.Request) *string {
	if sess, ok := auth.SessionFrom(r.Context()); ok && sess.UserID != "" {
		uid := sess.UserID
		return &uid
	}
	return nil
}

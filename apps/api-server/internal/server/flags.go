package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/fnvr/fnvr/apps/api-server/internal/auth"
	"github.com/fnvr/fnvr/apps/api-server/internal/flags"
)

// handleFlagDetection records a false-positive / relabel flag for a
// detection already in Postgres. The detection row is expected to
// have a non-NULL `phash` column (a generated stored column derived
// from `attributes->>'phash'`, populated for every object detection
// the pipeline probe hashes); without it we can't populate the
// suppression library, so we 422 rather than silently creating a
// flag that won't do anything.
//
// Path `:id` is the detection's **event_id** (short hex string, the
// one that lands in the SSE stream) — not the PG row id. We resolve
// to the PG row here so the UI never has to know about the PG id.
//
// Body:
//
//	{"class_corrected": "person" | null}
//
// Null class_corrected = "this is nothing". Non-null must match the
// slug of an enabled row in detection_classes; anything else 400s.
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
		// Non-null corrections must match a known + enabled class. The
		// list comes from the detection_classes table, not a hard-coded
		// slice — users add their own classes there.
		ok, err := s.classCorrectionAllowed(r.Context(), *body.ClassCorrected)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if !ok {
			http.Error(w, "class_corrected must match an enabled detection class "+
				"(see Settings → Classes)", http.StatusBadRequest)
			return
		}
	}

	// The path component may be either the detection's event_id (the
	// short hex string from the pipeline, used by pre-pg_id clients)
	// or the PG row id (numeric, from the accepted-subject payload's
	// `pg_id` field). Try numeric first — it's unambiguous — else fall
	// through to event_id. We always also read event_id back so we can
	// snapshot it onto the flag row (the on-disk JPEG thumb is keyed
	// by event_id; snapshotting lets the thumbnail endpoint survive
	// the source detection getting pruned by retention).
	var detID int64
	var cameraID, className, detEventID string
	var ts time.Time
	var bboxJSON []byte
	var detPHash *int64
	var err error
	if pg, convErr := strconv.ParseInt(eventID, 10, 64); convErr == nil && pg > 0 {
		err = s.pool.QueryRow(r.Context(),
			`SELECT id, event_id, camera_id, ts, class_name, bbox, phash
			 FROM detections WHERE id = $1`, pg).
			Scan(&detID, &detEventID, &cameraID, &ts, &className, &bboxJSON, &detPHash)
	} else {
		err = s.pool.QueryRow(r.Context(),
			`SELECT id, event_id, camera_id, ts, class_name, bbox, phash
			 FROM detections
			 WHERE event_id = $1
			 ORDER BY ts DESC LIMIT 1`, eventID).
			Scan(&detID, &detEventID, &cameraID, &ts, &className, &bboxJSON, &detPHash)
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
	if detPHash == nil {
		// Missing phash = the pipeline didn't emit one (likely an older
		// detection predating the phash slice). Refuse to flag; the UI
		// can message this.
		http.Error(w, "detection has no phash — cannot flag. "+
			"Wait for a fresh detection of the same scene.",
			http.StatusUnprocessableEntity)
		return
	}
	phash := uint64(*detPHash)

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
		DetectionID:    &detID,
		EventID:        &detEventID,
		CameraID:       cameraID,
		TS:             ts,
		ClassOriginal:  className,
		ClassCorrected: body.ClassCorrected,
		BBox:           bbox,
		PHash:          &phash,
		FramePath:      "", // filled after WriteArtifacts
		LabelPath:      "",
		CreatedBy:      sessionUserID(r),
	})
	if err != nil {
		slog.Error("flag: create failed", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	classLookup, err := s.classes.SlugToYoloID(r.Context())
	if err != nil {
		slog.Error("flag: load class lookup", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	framePath, labelPath, err := flags.WriteArtifacts(
		s.cfg.DataDir, created.ID, jpegSrc, bbox, body.ClassCorrected,
		flags.ClassLookup(classLookup))
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

	entries, _ := s.enabledClassEntries(r.Context())
	if err := flags.RegenerateDatasetYAML(s.cfg.DataDir, entries); err != nil {
		slog.Warn("flag: regenerate dataset.yaml", "err", err)
		// Non-fatal — the YAML can be regenerated later via any
		// subsequent flag or dismissal.
	}

	writeJSON(w, http.StatusCreated, created)
}

// handleManualFlag accepts a hand-drawn bounding box and persists it
// as a YOLO training label. Unlike handleFlagDetection, there's no
// underlying `detections` row — the operator drew a box on a frozen
// tile to teach the detector about something it currently misses.
//
// Body:
//
//	{
//	  "camera_id": "house-side",
//	  "bbox":      {"x": 0.21, "y": 0.40, "w": 0.14, "h": 0.22},
//	  "class":     "parcel"
//	}
//
// The bbox values are normalised [0,1] in the live tile's coordinate
// system — same convention as detection rows. We capture the most
// recent live-preview JPEG for the camera and write the YOLO label
// for it, so the dataset row trains the model to detect the class at
// roughly the spot the user drew.
//
// detection_id and phash on the resulting object_flags row are NULL,
// which keeps it out of the live-suppression library (the engine
// only loads phash-bearing rows). Class is required.
func (s *Server) handleManualFlag(w http.ResponseWriter, r *http.Request) {
	if s.flags == nil {
		http.Error(w, "flags not configured", http.StatusNotImplemented)
		return
	}
	var body struct {
		CameraID string     `json:"camera_id"`
		BBox     flags.BBox `json:"bbox"`
		Class    string     `json:"class"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	body.Class = trimSpaceLower(body.Class)
	if body.CameraID == "" || body.Class == "" {
		http.Error(w, "camera_id and class are required", http.StatusBadRequest)
		return
	}
	// Reject degenerate or out-of-frame boxes — these are almost
	// always front-end bugs, not legitimate labels, and they'd train
	// the model on garbage.
	if body.BBox.W <= 0 || body.BBox.H <= 0 ||
		body.BBox.X < 0 || body.BBox.Y < 0 ||
		body.BBox.X+body.BBox.W > 1 || body.BBox.Y+body.BBox.H > 1 {
		http.Error(w, "bbox must be normalised within [0,1] with positive width and height",
			http.StatusBadRequest)
		return
	}
	// Validate class against the enabled-class list — same check the
	// detection-derived flag handler uses for class_corrected.
	ok, err := s.classCorrectionAllowed(r.Context(), body.Class)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if !ok {
		http.Error(w, "class must match an enabled detection class "+
			"(see Settings → Classes)", http.StatusBadRequest)
		return
	}

	jpegSrc, err := latestLiveJPEG(s.cfg.DataDir, body.CameraID)
	if err != nil {
		slog.Warn("manual flag: latest live jpeg missing",
			"camera", body.CameraID, "err", err)
		http.Error(w, "no recent live frame for this camera",
			http.StatusServiceUnavailable)
		return
	}

	classCorrected := body.Class
	created, err := s.flags.Create(r.Context(), flags.CreateArgs{
		DetectionID:    nil, // manual flag — no underlying detection
		CameraID:       body.CameraID,
		TS:             time.Now().UTC(),
		ClassOriginal:  body.Class,
		ClassCorrected: &classCorrected,
		BBox:           body.BBox,
		PHash:          nil, // manual flag — no phash to suppress against
		FramePath:      "",
		LabelPath:      "",
		CreatedBy:      sessionUserID(r),
	})
	if err != nil {
		slog.Error("manual flag: create failed", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	classLookup, err := s.classes.SlugToYoloID(r.Context())
	if err != nil {
		slog.Error("manual flag: load class lookup", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	framePath, labelPath, err := flags.WriteArtifacts(
		s.cfg.DataDir, created.ID, jpegSrc, body.BBox, &classCorrected,
		flags.ClassLookup(classLookup))
	if err != nil {
		_, _ = s.flags.Dismiss(r.Context(), created.ID)
		slog.Error("manual flag: write artefacts",
			"flag_id", created.ID, "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if _, err := s.pool.Exec(r.Context(),
		`UPDATE object_flags SET frame_path=$1, label_path=$2 WHERE id=$3`,
		framePath, labelPath, created.ID); err != nil {
		slog.Error("manual flag: patch paths",
			"flag_id", created.ID, "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	created.FramePath = framePath
	created.LabelPath = labelPath

	entries, _ := s.enabledClassEntries(r.Context())
	if err := flags.RegenerateDatasetYAML(s.cfg.DataDir, entries); err != nil {
		slog.Warn("manual flag: regenerate dataset.yaml", "err", err)
	}

	writeJSON(w, http.StatusCreated, created)
}

// trimSpaceLower normalises a class slug from the wire body so casing
// or stray whitespace doesn't cause a "match an enabled class" error.
func trimSpaceLower(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
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
	entries, _ := s.enabledClassEntries(r.Context())
	if err := flags.RegenerateDatasetYAML(s.cfg.DataDir, entries); err != nil {
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
// keyed by the detection's event_id (short hex string).
//
// The path id is the flag row id (object_flags.id). The flag carries
// a snapshot of the source detection's event_id, so the JPEG keeps
// resolving even after detection retention prunes the source row.
//
// Legacy clients passed the detection id directly; we still try that
// path as a fallback (lookup detections.event_id by id) so existing
// bookmarks don't 404.
func (s *Server) handleObjectThumbnail(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	if i := len(idStr) - 4; i > 0 && idStr[i:] == ".jpg" {
		idStr = idStr[:i]
	}
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	if s.cfg == nil || s.cfg.DataDir == "" {
		http.Error(w, "no data dir", http.StatusNotFound)
		return
	}
	// Preferred path: id is a flag row id with a snapshotted event_id.
	// If the flag predates the event_id snapshot column the field is
	// NULL and we fall back to (a) treating the id as a detection id,
	// then (b) the flag's own captured frame_path as a last resort —
	// an old flag without event_id has no recoverable bbox-crop, but
	// frame_path points at the full live thumbnail at flag time which
	// at least shows the operator what they flagged.
	var eventID, framePath string
	var hasEvent, hasFrame bool
	if err := s.pool.QueryRow(r.Context(),
		`SELECT COALESCE(event_id, ''), frame_path FROM object_flags WHERE id = $1`,
		id).Scan(&eventID, &framePath); err == nil {
		hasEvent = eventID != ""
		hasFrame = framePath != ""
	} else {
		// Legacy URL: id is a detection id, look up its event_id.
		if err := s.pool.QueryRow(r.Context(),
			`SELECT event_id FROM detections WHERE id = $1`, id).Scan(&eventID); err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		hasEvent = true
	}
	if hasEvent {
		path := filepath.Join(s.cfg.DataDir, "thumbs", "objects", eventID+".jpg")
		if fd, err := os.Open(path); err == nil {
			defer fd.Close()
			w.Header().Set("Content-Type", "image/jpeg")
			w.Header().Set("Cache-Control", "public, max-age=86400")
			_, _ = io.Copy(w, fd)
			return
		}
	}
	if hasFrame {
		path := filepath.Join(s.cfg.DataDir, framePath)
		if fd, err := os.Open(path); err == nil {
			defer fd.Close()
			w.Header().Set("Content-Type", "image/jpeg")
			// Shorter cache: dataset frame is a fallback, not the
			// canonical thumb.
			w.Header().Set("Cache-Control", "public, max-age=3600")
			_, _ = io.Copy(w, fd)
			return
		}
	}
	http.Error(w, "not found", http.StatusNotFound)
}

// --- helpers ---

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

// enabledClassEntries fetches the enabled rows of detection_classes
// in yolo_id order and projects to the minimal shape RegenerateDatasetYAML
// consumes. Returned slice is empty (not nil) on no rows.
func (s *Server) enabledClassEntries(ctx context.Context) ([]flags.ClassEntry, error) {
	if s.classes == nil {
		return nil, nil
	}
	cs, err := s.classes.Enabled(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]flags.ClassEntry, 0, len(cs))
	for _, c := range cs {
		out = append(out, flags.ClassEntry{Slug: c.Slug, YoloID: c.YoloID})
	}
	return out, nil
}

// classCorrectionAllowed returns true if `slug` matches an enabled
// row in detection_classes. Used by the flag-create handler to refuse
// relabels into disabled or unknown classes.
func (s *Server) classCorrectionAllowed(ctx context.Context, slug string) (bool, error) {
	if s.classes == nil {
		// Defensive: if the classes store is unwired (shouldn't happen
		// in production) fall back to allowing any non-empty string so
		// flag creation isn't blocked.
		return slug != "", nil
	}
	enabled, err := s.classes.Enabled(ctx)
	if err != nil {
		return false, err
	}
	for _, c := range enabled {
		if c.Slug == slug {
			return true, nil
		}
	}
	return false, nil
}

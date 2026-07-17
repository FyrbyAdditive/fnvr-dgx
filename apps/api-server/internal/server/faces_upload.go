package server

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"

	"github.com/fnvr/fnvr/apps/api-server/internal/persons"
)

// handleUploadEnrol enrols a person from a photo upload rather than
// a live detection. Flow:
//
//   1. Multipart: `file` = JPEG/PNG, plus one of:
//      - `person_id`  → attach embedding to an existing person
//      - `new_label`  → create a new person with this label
//      Plus optional `face_index` (integer) to pick which face when
//      the uploaded photo has more than one.
//   2. Server hands the bytes to ml-worker /detect-and-embed.
//   3. Zero faces → 400. Multiple without `face_index` → 409 with
//      a list of bboxes so the client can re-post with the right
//      index.
//   4. On success, write a cropped thumbnail under
//      thumbs/faces/upload-<sha256[:8]>.jpg (served by the existing
//      thumbnail endpoint via its upload-id code path), enrol the
//      embedding with source="upload-<sha256[:8]>" and
//      detection_id=0.
//
// Admin-only; gated via the protected mux.
func (s *Server) handleUploadEnrol(w http.ResponseWriter, r *http.Request) {
	// 5 MiB cap is way more than needed for a face photo and keeps
	// multipart buffers tiny.
	if err := r.ParseMultipartForm(5 << 20); err != nil {
		http.Error(w, "invalid multipart or file too large", http.StatusBadRequest)
		return
	}
	personID := r.FormValue("person_id")
	newLabel := r.FormValue("new_label")
	if personID == "" && newLabel == "" {
		http.Error(w, "one of person_id or new_label is required", http.StatusBadRequest)
		return
	}
	faceIdx := 0
	if v := r.FormValue("face_index"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			faceIdx = n
		}
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "file field required", http.StatusBadRequest)
		return
	}
	defer file.Close()
	jpg, err := io.ReadAll(io.LimitReader(file, 10<<20))
	if err != nil || len(jpg) == 0 {
		http.Error(w, "failed to read file", http.StatusBadRequest)
		return
	}

	if s.mlWorker == nil {
		http.Error(w, "ml-worker not configured", http.StatusServiceUnavailable)
		return
	}
	faces, err := s.mlWorker.DetectAndEmbed(r.Context(), header.Filename, jpg)
	if err != nil {
		slog.Warn("upload enrol: ml-worker", "err", err)
		http.Error(w, "ml-worker unavailable", http.StatusServiceUnavailable)
		return
	}
	if len(faces) == 0 {
		http.Error(w, "no face detected in uploaded image", http.StatusBadRequest)
		return
	}
	if len(faces) > 1 && r.FormValue("face_index") == "" {
		// Tell the client which faces exist so the UI can ask the
		// operator to pick one before re-submitting.
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": "multiple faces found; resubmit with face_index",
			"faces": faces,
		})
		return
	}
	if faceIdx >= len(faces) {
		http.Error(w, "face_index out of range", http.StatusBadRequest)
		return
	}
	chosen := faces[faceIdx]
	if len(chosen.Embedding) != 512 {
		http.Error(w, "unexpected embedding size from ml-worker", http.StatusInternalServerError)
		return
	}

	// Resolve or create the person.
	if personID == "" {
		created, err := s.persons.Create(r.Context(), persons.Person{
			Label:   newLabel,
			Enabled: true,
		})
		if errors.Is(err, persons.ErrLabelTaken) {
			http.Error(w, "label already in use", http.StatusConflict)
			return
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		personID = created.ID
	}

	// Crop + cache the thumbnail so the UI renders the enrolled
	// face next to the embedding row. Hash-based filename keeps
	// re-uploads of the same image idempotent.
	sum := sha256.Sum256(jpg)
	shortHash := hex.EncodeToString(sum[:])[:8]
	cacheName := "upload-" + shortHash + ".jpg"
	source := "upload-" + shortHash

	if s.cfg != nil && s.cfg.DataDir != "" {
		cachePath := filepath.Join(s.cfg.DataDir, "thumbs", "faces", cacheName)
		// Crop with 1.4x pad to match live crops' visual style.
		cropped, cerr := cropBBoxJPEG(jpg, faceBox{
			X: chosen.BBox.X, Y: chosen.BBox.Y,
			W: chosen.BBox.W, H: chosen.BBox.H,
		}, 1.4)
		if cerr == nil {
			// Best-effort write; if the cache fails the enrolment
			// still succeeds, it just won't show a thumbnail.
			_ = writeFile(cachePath, cropped)
		} else {
			slog.Warn("upload enrol: crop", "err", cerr)
		}
	}

	emb, err := s.persons.AddEmbedding(r.Context(), personID,
		chosen.Embedding, source, 0)
	if err != nil {
		slog.Error("upload enrol: add embedding", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"person_id":     personID,
		"embedding":     emb,
		"face":          chosen,
		"source":        source,
		"retro_matched": s.runRetroMatch(r.Context()),
	})
}

// writeFile does a best-effort mkdir+write used by the upload crop
// path. Not atomic — concurrent reads of a half-written JPEG are
// fine because the thumbnail endpoint returns a new connection
// each time and browsers retry on broken image loads.
func writeFile(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

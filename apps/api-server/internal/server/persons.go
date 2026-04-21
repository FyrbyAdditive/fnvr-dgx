package server

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/fnvr/fnvr/apps/api-server/internal/auth"
	"github.com/fnvr/fnvr/apps/api-server/internal/persons"
)

func (s *Server) handleListPersons(w http.ResponseWriter, r *http.Request) {
	out, err := s.persons.List(r.Context())
	if err != nil {
		slog.Error("list persons", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if out == nil {
		out = []persons.Person{}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleCreatePerson(w http.ResponseWriter, r *http.Request) {
	var p persons.Person
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	// Default enabled unless the client explicitly sent false.
	if !p.Enabled {
		p.Enabled = true
	}
	out, err := s.persons.Create(r.Context(), p)
	if errors.Is(err, persons.ErrLabelTaken) {
		http.Error(w, "label already in use", http.StatusConflict)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (s *Server) handleUpdatePerson(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var body struct {
		Label        *string `json:"label,omitempty"`
		Notes        *string `json:"notes,omitempty"`
		Enabled      *bool   `json:"enabled,omitempty"`
		AlertOnMatch *bool   `json:"alert_on_match,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if err := s.persons.Update(r.Context(), id, body.Label, body.Notes,
		body.Enabled, body.AlertOnMatch); err != nil {
		if errors.Is(err, persons.ErrNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		if errors.Is(err, persons.ErrLabelTaken) {
			http.Error(w, "label already in use", http.StatusConflict)
			return
		}
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleDeletePerson is the right-to-erasure cascade. Beyond
// removing the person row it strips identity fields from past
// detections, deletes cached face thumbnails, and writes an
// audit row. Returns the ErasureReport so the UI can show the
// operator the scope of what was removed.
func (s *Server) handleDeletePerson(w http.ResponseWriter, r *http.Request) {
	actor := ""
	if sess, ok := auth.SessionFrom(r.Context()); ok {
		actor = sess.Username
	}
	report, err := s.persons.Erase(r.Context(), r.PathValue("id"), actor)
	if err != nil {
		if errors.Is(err, persons.ErrNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		slog.Error("erase person", "err", err, "person_id", r.PathValue("id"))
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, report)
}

func (s *Server) handleListPersonEmbeddings(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	out, err := s.persons.ListEmbeddings(r.Context(), id)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if out == nil {
		out = []persons.Embedding{}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleAddPersonEmbedding(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var body struct {
		Vector      []float32 `json:"vector"`
		Source      string    `json:"source"`
		DetectionID int64     `json:"detection_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if body.Source == "" {
		body.Source = "api"
	}
	e, err := s.persons.AddEmbedding(r.Context(), id, body.Vector, body.Source, body.DetectionID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusCreated, e)
}

func (s *Server) handleDeletePersonEmbedding(w http.ResponseWriter, r *http.Request) {
	eid := r.PathValue("embedding_id")
	if err := s.persons.DeleteEmbedding(r.Context(), eid); err != nil {
		if errors.Is(err, persons.ErrNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleBulkDeletePersonEmbeddings removes many embeddings from one
// person's pool in a single DB round-trip. The person id is taken
// from the URL and passed into the WHERE clause so a forged body
// can't reach across persons.
func (s *Server) handleBulkDeletePersonEmbeddings(w http.ResponseWriter, r *http.Request) {
	personID := r.PathValue("id")
	var body struct {
		IDs []string `json:"ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	n, err := s.persons.BulkDeleteEmbeddings(r.Context(), personID, body.IDs)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": n})
}

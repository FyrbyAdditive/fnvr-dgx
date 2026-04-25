package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/fnvr/fnvr/apps/api-server/internal/classes"
)

// GET /api/v1/admin/classes
// Lists every class. Anyone authenticated can read; the writes below
// are admin-gated at the route layer.
func (s *Server) handleListClasses(w http.ResponseWriter, r *http.Request) {
	if s.classes == nil {
		http.Error(w, "classes store unavailable", http.StatusServiceUnavailable)
		return
	}
	out, err := s.classes.List(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// POST /api/v1/admin/classes
// Body: {"slug": "parcel", "display_name": "Parcel"}
func (s *Server) handleCreateClass(w http.ResponseWriter, r *http.Request) {
	if s.classes == nil {
		http.Error(w, "classes store unavailable", http.StatusServiceUnavailable)
		return
	}
	var body struct {
		Slug        string `json:"slug"`
		DisplayName string `json:"display_name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	c, err := s.classes.Create(r.Context(), classes.CreateArgs{
		Slug:        body.Slug,
		DisplayName: body.DisplayName,
	})
	switch {
	case errors.Is(err, classes.ErrInvalidSlug):
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	case errors.Is(err, classes.ErrSlugInUse):
		http.Error(w, err.Error(), http.StatusConflict)
		return
	case err != nil:
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, c)
}

// PATCH /api/v1/admin/classes/{id}
// Body: any subset of {"enabled": bool, "display_name": string}
func (s *Server) handlePatchClass(w http.ResponseWriter, r *http.Request) {
	if s.classes == nil {
		http.Error(w, "classes store unavailable", http.StatusServiceUnavailable)
		return
	}
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	var body struct {
		Enabled     *bool   `json:"enabled"`
		DisplayName *string `json:"display_name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	c, err := s.classes.Patch(r.Context(), id, classes.PatchArgs{
		Enabled:     body.Enabled,
		DisplayName: body.DisplayName,
	})
	switch {
	case errors.Is(err, classes.ErrNotFound):
		http.Error(w, "not found", http.StatusNotFound)
		return
	case err != nil:
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

// DELETE /api/v1/admin/classes/{id}
// Refuses on seeded COCO rows (use PATCH enabled=false instead) and on
// custom classes that already have flagged samples in object_flags.
func (s *Server) handleDeleteClass(w http.ResponseWriter, r *http.Request) {
	if s.classes == nil {
		http.Error(w, "classes store unavailable", http.StatusServiceUnavailable)
		return
	}
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	switch err := s.classes.Delete(r.Context(), id); {
	case errors.Is(err, classes.ErrNotFound):
		http.Error(w, "not found", http.StatusNotFound)
	case errors.Is(err, classes.ErrSeedImmutable):
		http.Error(w, err.Error(), http.StatusConflict)
	case errors.Is(err, classes.ErrHasFlags):
		http.Error(w, err.Error(), http.StatusConflict)
	case err != nil:
		http.Error(w, err.Error(), http.StatusInternalServerError)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

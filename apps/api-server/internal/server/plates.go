package server

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/fnvr/fnvr/apps/api-server/internal/plates"
)

func (s *Server) handleListHotlist(w http.ResponseWriter, r *http.Request) {
	out, err := s.plates.ListHotlist(r.Context())
	if err != nil {
		slog.Error("plate hotlist list", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if out == nil {
		out = []plates.HotlistEntry{}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleCreateHotlist(w http.ResponseWriter, r *http.Request) {
	var e plates.HotlistEntry
	if err := json.NewDecoder(r.Body).Decode(&e); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	// Default enabled unless explicitly false.
	e.Enabled = true
	if r := r.URL.Query().Get("enabled"); r == "false" {
		e.Enabled = false
	}
	created, err := s.plates.CreateHotlistEntry(r.Context(), e)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

func (s *Server) handleUpdateHotlist(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var e plates.HotlistEntry
	if err := json.NewDecoder(r.Body).Decode(&e); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if err := s.plates.UpdateHotlistEntry(r.Context(), id, e); err != nil {
		if errors.Is(err, plates.ErrNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleDeleteHotlist(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := s.plates.DeleteHotlistEntry(r.Context(), id); err != nil {
		if errors.Is(err, plates.ErrNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleRecentPlates(w http.ResponseWriter, r *http.Request) {
	hours, _ := strconv.Atoi(r.URL.Query().Get("hours"))
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	out, err := s.plates.RecentPlates(r.Context(), hours, limit)
	if err != nil {
		slog.Error("recent plates", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if out == nil {
		out = []plates.RecentPlate{}
	}
	writeJSON(w, http.StatusOK, out)
}

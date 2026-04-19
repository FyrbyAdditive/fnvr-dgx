package server

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/fnvr/fnvr/apps/api-server/internal/camera"
	"github.com/fnvr/fnvr/apps/api-server/internal/settings"
)

func (s *Server) handleGetClassMutes(w http.ResponseWriter, r *http.Request) {
	m, err := s.settings.GetClassMutes(r.Context())
	if err != nil {
		slog.Error("get class mutes", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, m)
}

func (s *Server) handleUpdateClassMutes(w http.ResponseWriter, r *http.Request) {
	var m settings.ClassMutes
	if err := json.NewDecoder(r.Body).Decode(&m); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if err := s.settings.SetClassMutes(r.Context(), m); err != nil {
		slog.Error("set class mutes", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleUpdateCameraClasses accepts a PATCH body where each field is
// optional — absent keys don't change that column. Using pointers so
// null/absent is distinguishable from an explicit empty array (which
// clears the override).
func (s *Server) handleUpdateCameraClasses(w http.ResponseWriter, r *http.Request) {
	var body struct {
		LocationKind          *string   `json:"location_kind,omitempty"`
		MuteClassesOverride   *[]string `json:"mute_classes_override,omitempty"`
		UnmuteClassesOverride *[]string `json:"unmute_classes_override,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	var mute, unmute []string
	if body.MuteClassesOverride != nil {
		mute = *body.MuteClassesOverride
		if mute == nil {
			mute = []string{}
		}
	}
	if body.UnmuteClassesOverride != nil {
		unmute = *body.UnmuteClassesOverride
		if unmute == nil {
			unmute = []string{}
		}
	}
	id := r.PathValue("id")
	err := s.cameras.SetClassMuting(r.Context(), id, body.LocationKind, mute, unmute)
	if errors.Is(err, camera.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		// Validation errors (bad location_kind) are non-fatal; surface
		// as 400 so the UI can show them.
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

package server

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

// handleGetAdvancedSettings: GET /api/v1/settings/advanced — every
// whitelisted runtime knob with its stored-or-default value.
func (s *Server) handleGetAdvancedSettings(w http.ResponseWriter, r *http.Request) {
	out, err := s.settings.GetAdvanced(r.Context())
	if err != nil {
		slog.Error("get advanced settings", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// handleUpdateAdvancedSettings: PUT /api/v1/settings/advanced with a
// partial {key: value} object. Unknown keys and out-of-range values are
// 400s; only the provided keys are written.
func (s *Server) handleUpdateAdvancedSettings(w http.ResponseWriter, r *http.Request) {
	var updates map[string]json.RawMessage
	if err := json.NewDecoder(r.Body).Decode(&updates); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if err := s.settings.SetAdvanced(r.Context(), updates); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

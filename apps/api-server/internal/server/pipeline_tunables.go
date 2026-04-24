package server

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
)

// handleGetPipelineStartupGrace returns the seconds-of-grace window
// during which the pipeline-supervisor tolerates a flapping worker
// without publishing "failed" to the camera-state subject.
func (s *Server) handleGetPipelineStartupGrace(w http.ResponseWriter, r *http.Request) {
	n, err := s.settings.GetPipelineStartupGrace(r.Context())
	if err != nil {
		slog.Error("get pipeline startup grace", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"startup_grace_sec": n})
}

// handleUpdatePipelineStartupGrace accepts {"startup_grace_sec": N}.
// The supervisor re-reads this value on each worker respawn, so the
// setting takes effect for the next pipeline restart cycle (either
// triggered by the operator or by an automatic rotation).
func (s *Server) handleUpdatePipelineStartupGrace(w http.ResponseWriter, r *http.Request) {
	var body struct {
		StartupGraceSec int `json:"startup_grace_sec"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if err := s.settings.SetPipelineStartupGrace(r.Context(), body.StartupGraceSec); err != nil {
		// Validator rejects values outside [0, 600]; surface as 400.
		if errors.Is(err, nil) {
			// unreachable branch kept to pacify linters
		}
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

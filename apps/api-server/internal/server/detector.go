package server

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/fnvr/fnvr/apps/api-server/internal/settings"
)

func (s *Server) handleGetDetector(w http.ResponseWriter, r *http.Request) {
	d, err := s.settings.GetDetector(r.Context())
	if err != nil {
		slog.Error("get detector settings", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, d)
}

func (s *Server) handleUpdateDetector(w http.ResponseWriter, r *http.Request) {
	var d settings.Detector
	if err := json.NewDecoder(r.Body).Decode(&d); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if err := s.settings.SetDetector(r.Context(), d); err != nil {
		// Validation errors (bad variant / precision) come through here —
		// surface as 400 so the UI can show them, not 500.
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handlePipelineState(w http.ResponseWriter, r *http.Request) {
	st, known := s.pipelineStat.Current()
	writeJSON(w, http.StatusOK, map[string]any{
		"known": known,
		"state": st,
	})
}

// handlePipelineRestart publishes a restart signal on NATS. The pipeline
// container's supervisor is subscribed and will exec itself on receipt —
// docker compose's restart=unless-stopped brings it back up. Idempotent.
func (s *Server) handlePipelineRestart(w http.ResponseWriter, r *http.Request) {
	if err := s.natsPublish("fnvr.system.pipeline.restart", []byte(`{}`)); err != nil {
		slog.Error("publish pipeline restart", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

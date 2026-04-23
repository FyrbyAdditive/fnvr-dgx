package server

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"github.com/fnvr/fnvr/apps/api-server/internal/settings"
)

func (s *Server) handleGetAlarm(w http.ResponseWriter, r *http.Request) {
	a, err := s.settings.GetAlarm(r.Context())
	if err != nil {
		slog.Error("get alarm state", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, a)
}

func (s *Server) handleUpdateAlarm(w http.ResponseWriter, r *http.Request) {
	var a settings.AlarmState
	if err := json.NewDecoder(r.Body).Decode(&a); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	a.State = strings.ToLower(strings.TrimSpace(a.State))
	if err := s.settings.SetAlarm(r.Context(), a); err != nil {
		// Validator returns a descriptive error; surface as 400.
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	// Push the change to subscribers (event-processor's rules engine)
	// so rule gating reflects the new state without waiting for the
	// 30 s periodic reload. If NATS is unavailable the DB write still
	// wins on next reload; no need to fail the request.
	if s.natsPublish != nil {
		payload, _ := json.Marshal(a)
		if err := s.natsPublish("fnvr.settings.alarm.changed", payload); err != nil {
			slog.Warn("publish alarm state change", "err", err)
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

package server

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"github.com/fnvr/fnvr/apps/api-server/internal/settings"
)

func (s *Server) handleGetHAConfig(w http.ResponseWriter, r *http.Request) {
	cfg, err := s.settings.GetHAConfig(r.Context())
	if err != nil {
		slog.Error("get ha config", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	// Mask the password in GET responses — the UI inputs a new value
	// only when the admin wants to change it, matching how other
	// secret-ish fields are handled (e.g. ntfy token UIs mask on read).
	if cfg.Password != "" {
		cfg.Password = "••••••••"
	}
	writeJSON(w, http.StatusOK, cfg)
}

func (s *Server) handleUpdateHAConfig(w http.ResponseWriter, r *http.Request) {
	var cfg settings.HAConfig
	if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	// A password of "••••••••" means "keep the stored one". Otherwise
	// accept the submitted value (including empty string = clear).
	if strings.Trim(cfg.Password, "•") == "" && cfg.Password != "" {
		existing, err := s.settings.GetHAConfig(r.Context())
		if err == nil {
			cfg.Password = existing.Password
		}
	}
	if err := s.settings.SetHAConfig(r.Context(), cfg); err != nil {
		slog.Error("set ha config", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

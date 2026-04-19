package server

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/fnvr/fnvr/apps/api-server/internal/notifications"
)

// --- channels ---

func (s *Server) handleListChannels(w http.ResponseWriter, r *http.Request) {
	out, err := s.notifs.ListChannels(r.Context())
	if err != nil {
		slog.Error("list channels", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleCreateChannel(w http.ResponseWriter, r *http.Request) {
	var c notifications.Channel
	if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if c.Name == "" || c.Kind == "" || len(c.Config) == 0 {
		http.Error(w, "name, kind, config required", http.StatusBadRequest)
		return
	}
	if c.Kind != "webhook" && c.Kind != "ntfy" {
		http.Error(w, "kind must be webhook or ntfy", http.StatusBadRequest)
		return
	}
	out, err := s.notifs.CreateChannel(r.Context(), c)
	if err != nil {
		slog.Error("create channel", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (s *Server) handleDeleteChannel(w http.ResponseWriter, r *http.Request) {
	err := s.notifs.DeleteChannel(r.Context(), r.PathValue("id"))
	if errors.Is(err, notifications.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleEnableChannel(w http.ResponseWriter, r *http.Request) {
	s.setChannelEnabled(w, r, true)
}
func (s *Server) handleDisableChannel(w http.ResponseWriter, r *http.Request) {
	s.setChannelEnabled(w, r, false)
}
func (s *Server) setChannelEnabled(w http.ResponseWriter, r *http.Request, enabled bool) {
	err := s.notifs.SetChannelEnabled(r.Context(), r.PathValue("id"), enabled)
	if errors.Is(err, notifications.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- subscriptions ---

func (s *Server) handleListSubscriptions(w http.ResponseWriter, r *http.Request) {
	channelID := r.URL.Query().Get("channel_id")
	out, err := s.notifs.ListSubscriptions(r.Context(), channelID)
	if err != nil {
		slog.Error("list subs", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleCreateSubscription(w http.ResponseWriter, r *http.Request) {
	var sub notifications.Subscription
	if err := json.NewDecoder(r.Body).Decode(&sub); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if sub.ChannelID == "" {
		http.Error(w, "channel_id required", http.StatusBadRequest)
		return
	}
	if sub.MinSeverity == "" {
		sub.MinSeverity = "info"
	}
	out, err := s.notifs.CreateSubscription(r.Context(), sub)
	if err != nil {
		slog.Error("create sub", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (s *Server) handleDeleteSubscription(w http.ResponseWriter, r *http.Request) {
	err := s.notifs.DeleteSubscription(r.Context(), r.PathValue("id"))
	if errors.Is(err, notifications.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- deliveries (read-only) ---

func (s *Server) handleRecentDeliveries(w http.ResponseWriter, r *http.Request) {
	limit := 100
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			limit = n
		}
	}
	out, err := s.notifs.RecentDeliveries(r.Context(), limit)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

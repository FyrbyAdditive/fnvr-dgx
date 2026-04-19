package server

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/fnvr/fnvr/apps/api-server/internal/auth"
)

func (s *Server) handleListUsers(w http.ResponseWriter, r *http.Request) {
	users, err := s.auth.ListUsers(r.Context())
	if err != nil {
		slog.Error("list users", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if users == nil {
		users = []auth.User{}
	}
	writeJSON(w, http.StatusOK, users)
}

func (s *Server) handleCreateUser(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string    `json:"username"`
		Password string    `json:"password"`
		Role     auth.Role `json:"role"`
		APIOnly  bool      `json:"api_only"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if body.Username == "" {
		http.Error(w, "username required", http.StatusBadRequest)
		return
	}
	u, err := s.auth.CreateUser(r.Context(), body.Username, body.Password, body.Role, body.APIOnly)
	if errors.Is(err, auth.ErrInvalidRole) {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err != nil {
		// Username collision lands as a unique-constraint error from PG.
		// Surface as 409 if the message hints at it; otherwise 500.
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusCreated, u)
}

func (s *Server) handleUpdateUser(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var body struct {
		Role     *auth.Role `json:"role,omitempty"`
		Disabled *bool      `json:"disabled,omitempty"`
		Password *string    `json:"password,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	ctx := r.Context()
	if body.Role != nil {
		if err := s.auth.SetRole(ctx, id, *body.Role); err != nil {
			if errors.Is(err, auth.ErrLastAdmin) {
				http.Error(w, err.Error(), http.StatusConflict)
				return
			}
			if errors.Is(err, auth.ErrNotFound) {
				http.Error(w, "not found", http.StatusNotFound)
				return
			}
			if errors.Is(err, auth.ErrInvalidRole) {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
	}
	if body.Disabled != nil {
		if err := s.auth.SetDisabled(ctx, id, *body.Disabled); err != nil {
			if errors.Is(err, auth.ErrLastAdmin) {
				http.Error(w, err.Error(), http.StatusConflict)
				return
			}
			if errors.Is(err, auth.ErrNotFound) {
				http.Error(w, "not found", http.StatusNotFound)
				return
			}
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
	}
	if body.Password != nil {
		if err := s.auth.SetPassword(ctx, id, *body.Password); err != nil {
			if errors.Is(err, auth.ErrAPIOnlyPassword) {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			if errors.Is(err, auth.ErrNotFound) {
				http.Error(w, "not found", http.StatusNotFound)
				return
			}
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleDeleteUser(w http.ResponseWriter, r *http.Request) {
	err := s.auth.DeleteUser(r.Context(), r.PathValue("id"))
	if errors.Is(err, auth.ErrLastAdmin) {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	if errors.Is(err, auth.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleListTokens(w http.ResponseWriter, r *http.Request) {
	tokens, err := s.auth.ListAPITokens(r.Context(), r.PathValue("id"))
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if tokens == nil {
		tokens = []auth.APIToken{}
	}
	writeJSON(w, http.StatusOK, tokens)
}

func (s *Server) handleCreateToken(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if body.Name == "" {
		http.Error(w, "name required", http.StatusBadRequest)
		return
	}
	raw, id, err := s.auth.CreateAPIToken(r.Context(), r.PathValue("id"), body.Name)
	if errors.Is(err, auth.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{
		"id":    id,
		"token": raw,
	})
}

func (s *Server) handleRevokeToken(w http.ResponseWriter, r *http.Request) {
	if err := s.auth.RevokeAPIToken(r.Context(), r.PathValue("token_id")); err != nil {
		if errors.Is(err, auth.ErrNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

package server

import (
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/fnvr/fnvr/apps/api-server/internal/auth"
)

// --- login brute-force throttle ---------------------------------------

// loginThrottle rate-limits failed logins per (client-ip, username).
// After a small number of failures the key is locked out with
// exponential backoff, capped. Successful login clears the key.
type loginThrottle struct {
	mu    sync.Mutex
	fails map[string]*attemptState
}

type attemptState struct {
	n          int
	lockedTill time.Time
}

const (
	loginFreeAttempts = 5               // failures before backoff kicks in
	loginBackoffBase  = 2 * time.Second // first lockout after the free attempts
	loginBackoffMax   = 5 * time.Minute
)

var loginLimiter = &loginThrottle{fails: map[string]*attemptState{}}

// retryAfter returns >0 (seconds) when the key is currently locked out.
func (t *loginThrottle) retryAfter(key string, now time.Time) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	st := t.fails[key]
	if st == nil || now.After(st.lockedTill) {
		return 0
	}
	return int(st.lockedTill.Sub(now).Seconds()) + 1
}

func (t *loginThrottle) recordFailure(key string, now time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	st := t.fails[key]
	if st == nil {
		st = &attemptState{}
		t.fails[key] = st
	}
	st.n++
	if st.n > loginFreeAttempts {
		// 2s, 4s, 8s, ... capped.
		backoff := loginBackoffBase << (st.n - loginFreeAttempts - 1)
		if backoff > loginBackoffMax || backoff <= 0 {
			backoff = loginBackoffMax
		}
		st.lockedTill = now.Add(backoff)
	}
}

func (t *loginThrottle) clear(key string) {
	t.mu.Lock()
	delete(t.fails, key)
	t.mu.Unlock()
}

// clientIP prefers nginx's X-Real-IP (set to the real peer, not
// spoofable through the proxy) and falls back to RemoteAddr.
func clientIP(r *http.Request) string {
	if v := r.Header.Get("X-Real-IP"); v != "" {
		return v
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// --- self-service password change -------------------------------------

func setSessionCookie(w http.ResponseWriter, sess auth.Session) {
	http.SetCookie(w, &http.Cookie{
		Name:     "fnvr_session",
		Value:    sess.Token,
		Path:     "/",
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
		Expires:  sess.ExpiresAt,
	})
}

func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	sess, ok := auth.SessionFrom(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var body struct {
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	next, err := s.auth.ChangeOwnPassword(r.Context(), sess.UserID, body.CurrentPassword, body.NewPassword)
	if errors.Is(err, auth.ErrInvalidCredentials) {
		http.Error(w, "current password is incorrect", http.StatusUnauthorized)
		return
	}
	if err != nil {
		// Length/policy errors surface as 400; everything else 500.
		if strings.Contains(err.Error(), "at least") {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	setSessionCookie(w, next)
	writeJSON(w, http.StatusOK, map[string]any{
		"username":   next.Username,
		"role":       next.Role,
		"expires_at": next.ExpiresAt,
	})
}

// --- forced-change gate ------------------------------------------------

// mustChangeGate blocks a session that still carries a bootstrap/
// admin-assigned password from doing anything except reading /me,
// logging out, and changing its password. Runs after auth.Middleware,
// so the session is already in context.
func (s *Server) mustChangeGate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sess, ok := auth.SessionFrom(r.Context())
		if ok && sess.MustChange && !mustChangeExempt(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{
				"error": "password change required",
				"code":  "must_change_password",
			})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func mustChangeExempt(r *http.Request) bool {
	switch r.URL.Path {
	case "/api/v1/me", "/api/v1/auth/logout", "/api/v1/auth/change-password":
		return true
	}
	return false
}

// isAdmin reports whether the request's session has admin role.
func (s *Server) isAdmin(r *http.Request) bool {
	sess, ok := auth.SessionFrom(r.Context())
	return ok && auth.IsAdmin(sess)
}

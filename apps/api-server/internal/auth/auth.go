package auth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

type Role string

const (
	RoleSuperadmin Role = "superadmin"
	RoleAdmin      Role = "admin"
	RoleOperator   Role = "operator"
	RoleViewer     Role = "viewer"
	RoleGuest      Role = "guest"
)

var ErrInvalidCredentials = errors.New("invalid credentials")

type User struct {
	ID       string
	Username string
	Role     Role
	Disabled bool
}

type Session struct {
	Token     string
	UserID    string
	Username  string
	Role      Role
	ExpiresAt time.Time
}

// Store handles user auth + (in-memory) session tokens.
// Sessions move to Redis in M3 when we need to run >1 api-server replica.
type Store struct {
	pool *pgxpool.Pool
	ttl  time.Duration

	mu       sync.RWMutex
	sessions map[string]Session
}

func NewStore(pool *pgxpool.Pool, ttl time.Duration) *Store {
	return &Store{pool: pool, ttl: ttl, sessions: map[string]Session{}}
}

// BootstrapAdmin creates the default admin/admin user if no users exist.
// Returns true if it created one — the caller should log a warning so the
// operator knows to change the password.
func (s *Store) BootstrapAdmin(ctx context.Context) (bool, error) {
	var n int
	if err := s.pool.QueryRow(ctx, `SELECT COUNT(*) FROM users`).Scan(&n); err != nil {
		return false, err
	}
	if n > 0 {
		return false, nil
	}
	hash, err := bcrypt.GenerateFromPassword([]byte("admin"), 12)
	if err != nil {
		return false, err
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO users (username, password_hash, role) VALUES ('admin', $1, 'superadmin')`,
		string(hash))
	return err == nil, err
}

func (s *Store) Login(ctx context.Context, username, password string) (Session, error) {
	var u User
	var hash string
	err := s.pool.QueryRow(ctx,
		`SELECT id, username, role, disabled, password_hash FROM users WHERE username=$1`,
		username).Scan(&u.ID, &u.Username, &u.Role, &u.Disabled, &hash)
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, ErrInvalidCredentials
	}
	if err != nil {
		return Session{}, err
	}
	if u.Disabled {
		return Session{}, ErrInvalidCredentials
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		return Session{}, ErrInvalidCredentials
	}

	tok, err := randomToken()
	if err != nil {
		return Session{}, err
	}
	sess := Session{
		Token:     tok,
		UserID:    u.ID,
		Username:  u.Username,
		Role:      u.Role,
		ExpiresAt: time.Now().Add(s.ttl),
	}
	s.mu.Lock()
	s.sessions[tok] = sess
	s.mu.Unlock()
	return sess, nil
}

func (s *Store) Logout(token string) {
	s.mu.Lock()
	delete(s.sessions, token)
	s.mu.Unlock()
}

func (s *Store) Validate(token string) (Session, bool) {
	s.mu.RLock()
	sess, ok := s.sessions[token]
	s.mu.RUnlock()
	if !ok || time.Now().After(sess.ExpiresAt) {
		return Session{}, false
	}
	return sess, true
}

func randomToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// Middleware enforces a valid session token on protected routes.
// Accepts "Authorization: Bearer <token>" or the "fnvr_session" cookie.
type ctxKey int

const sessionCtxKey ctxKey = 1

func (s *Store) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tok := bearerToken(r)
		if tok == "" {
			if c, err := r.Cookie("fnvr_session"); err == nil {
				tok = c.Value
			}
		}
		sess, ok := s.Validate(tok)
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		r = r.WithContext(context.WithValue(r.Context(), sessionCtxKey, sess))
		next.ServeHTTP(w, r)
	})
}

func SessionFrom(ctx context.Context) (Session, bool) {
	s, ok := ctx.Value(sessionCtxKey).(Session)
	return s, ok
}

func bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if len(h) > len(prefix) && h[:len(prefix)] == prefix {
		return h[len(prefix):]
	}
	return ""
}

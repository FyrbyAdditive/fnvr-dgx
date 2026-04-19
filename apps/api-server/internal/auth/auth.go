package auth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
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

var (
	ErrInvalidCredentials = errors.New("invalid credentials")
	ErrNotFound           = errors.New("not found")
	ErrLastAdmin          = errors.New("cannot remove the last enabled admin")
	ErrInvalidRole        = errors.New("invalid role")
	ErrAPIOnlyLogin       = errors.New("api-only users cannot log in via the browser")
	ErrAPIOnlyPassword    = errors.New("api-only users have no password to set")
)

type User struct {
	ID        string    `json:"id"`
	Username  string    `json:"username"`
	Role      Role      `json:"role"`
	Disabled  bool      `json:"disabled"`
	APIOnly   bool      `json:"api_only"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type Session struct {
	Token     string
	UserID    string
	Username  string
	Role      Role
	APIOnly   bool
	ExpiresAt time.Time
}

// APIToken is the metadata shape surfaced to the UI; the raw token
// value is only returned from CreateAPIToken and never re-read.
type APIToken struct {
	ID         string     `json:"id"`
	UserID     string     `json:"user_id"`
	Name       string     `json:"name"`
	CreatedAt  time.Time  `json:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at,omitempty"`
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
		`SELECT id, username, role, disabled, api_only, password_hash FROM users WHERE username=$1`,
		username).Scan(&u.ID, &u.Username, &u.Role, &u.Disabled, &u.APIOnly, &hash)
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, ErrInvalidCredentials
	}
	if err != nil {
		return Session{}, err
	}
	if u.Disabled {
		return Session{}, ErrInvalidCredentials
	}
	if u.APIOnly {
		// api-only accounts authenticate with Bearer tokens only. The
		// password_hash column on these rows is a random nonce; we reject
		// here before the bcrypt compare to avoid signalling that the
		// account exists.
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
		APIOnly:   u.APIOnly,
		ExpiresAt: time.Now().Add(s.ttl),
	}
	s.mu.Lock()
	s.sessions[tok] = sess
	s.mu.Unlock()
	return sess, nil
}

// --- user management ---

// NormaliseRole maps the five CHECK'd roles down to the two the
// handler-side gate cares about: admin | viewer. superadmin is admin;
// operator/guest collapse to viewer.
func NormaliseRole(r Role) Role {
	switch r {
	case RoleSuperadmin, RoleAdmin:
		return RoleAdmin
	default:
		return RoleViewer
	}
}

// IsAdmin reports whether a session can perform write operations.
func IsAdmin(sess Session) bool {
	return NormaliseRole(sess.Role) == RoleAdmin
}

// CreateUser inserts a new user. For api-only users, password is
// ignored and a random nonce is stored so login always fails.
// Role is validated against the admin|viewer set; anything else is
// rejected (we don't expose operator/guest through the API).
func (s *Store) CreateUser(ctx context.Context, username, password string, role Role, apiOnly bool) (User, error) {
	role = NormaliseRole(role)
	if role != RoleAdmin && role != RoleViewer {
		return User{}, ErrInvalidRole
	}
	var hashStr string
	if apiOnly {
		nonce, err := randomToken()
		if err != nil {
			return User{}, err
		}
		h, err := bcrypt.GenerateFromPassword([]byte(nonce), 12)
		if err != nil {
			return User{}, err
		}
		hashStr = string(h)
	} else {
		if password == "" {
			return User{}, fmt.Errorf("password required for non-api-only user")
		}
		h, err := bcrypt.GenerateFromPassword([]byte(password), 12)
		if err != nil {
			return User{}, err
		}
		hashStr = string(h)
	}
	var u User
	err := s.pool.QueryRow(ctx, `
		INSERT INTO users (username, password_hash, role, api_only)
		VALUES ($1, $2, $3, $4)
		RETURNING id, username, role, disabled, api_only, created_at, updated_at`,
		username, hashStr, string(role), apiOnly).
		Scan(&u.ID, &u.Username, &u.Role, &u.Disabled, &u.APIOnly, &u.CreatedAt, &u.UpdatedAt)
	return u, err
}

func (s *Store) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, username, role, disabled, api_only, created_at, updated_at
		FROM users ORDER BY username ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []User
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.Username, &u.Role, &u.Disabled, &u.APIOnly,
			&u.CreatedAt, &u.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// DeleteUser removes a user. Refuses if removing them would leave
// zero enabled admins in the system.
func (s *Store) DeleteUser(ctx context.Context, id string) error {
	if err := s.guardLastAdmin(ctx, id, "delete"); err != nil {
		return err
	}
	tag, err := s.pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	// Drop any in-memory sessions for the deleted user.
	s.dropSessions(func(sess Session) bool { return sess.UserID == id })
	return nil
}

// SetPassword updates a non-api-only user's password.
func (s *Store) SetPassword(ctx context.Context, id, newPassword string) error {
	if newPassword == "" {
		return fmt.Errorf("password cannot be empty")
	}
	var apiOnly bool
	if err := s.pool.QueryRow(ctx,
		`SELECT api_only FROM users WHERE id=$1`, id).Scan(&apiOnly); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if apiOnly {
		return ErrAPIOnlyPassword
	}
	h, err := bcrypt.GenerateFromPassword([]byte(newPassword), 12)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx,
		`UPDATE users SET password_hash=$2, updated_at=NOW() WHERE id=$1`, id, string(h))
	// Invalidate any live sessions for that user — force re-login with
	// the new password.
	s.dropSessions(func(sess Session) bool { return sess.UserID == id })
	return err
}

func (s *Store) SetRole(ctx context.Context, id string, role Role) error {
	role = NormaliseRole(role)
	if role != RoleAdmin && role != RoleViewer {
		return ErrInvalidRole
	}
	// Guard against demoting the last admin.
	if role == RoleViewer {
		if err := s.guardLastAdmin(ctx, id, "demote"); err != nil {
			return err
		}
	}
	tag, err := s.pool.Exec(ctx,
		`UPDATE users SET role=$2, updated_at=NOW() WHERE id=$1`, id, string(role))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	// Live sessions carry the old role; flush so the next request
	// re-authenticates with the new one.
	s.dropSessions(func(sess Session) bool { return sess.UserID == id })
	return nil
}

func (s *Store) SetDisabled(ctx context.Context, id string, disabled bool) error {
	if disabled {
		if err := s.guardLastAdmin(ctx, id, "disable"); err != nil {
			return err
		}
	}
	tag, err := s.pool.Exec(ctx,
		`UPDATE users SET disabled=$2, updated_at=NOW() WHERE id=$1`, id, disabled)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	if disabled {
		s.dropSessions(func(sess Session) bool { return sess.UserID == id })
	}
	return nil
}

// guardLastAdmin returns ErrLastAdmin if the target user is the only
// enabled admin. `action` is only used for error context (unused for
// now, reserved for logging).
func (s *Store) guardLastAdmin(ctx context.Context, id, _ string) error {
	var isAdmin bool
	var adminCount int
	err := s.pool.QueryRow(ctx, `
		SELECT
		  (role IN ('admin','superadmin') AND disabled = FALSE) AS is_admin,
		  (SELECT COUNT(*) FROM users
		     WHERE role IN ('admin','superadmin') AND disabled = FALSE) AS n
		FROM users WHERE id=$1`, id).Scan(&isAdmin, &adminCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if isAdmin && adminCount <= 1 {
		return ErrLastAdmin
	}
	return nil
}

// dropSessions removes in-memory sessions matching the predicate.
func (s *Store) dropSessions(match func(Session) bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for tok, sess := range s.sessions {
		if match(sess) {
			delete(s.sessions, tok)
		}
	}
}

// --- API tokens ---

// CreateAPIToken generates a new token, stores its bcrypt hash, and
// returns the raw token string exactly once. The caller is expected
// to show it to the user immediately.
func (s *Store) CreateAPIToken(ctx context.Context, userID, name string) (rawToken string, id string, err error) {
	var apiOnly bool
	var disabled bool
	err = s.pool.QueryRow(ctx,
		`SELECT api_only, disabled FROM users WHERE id=$1`, userID).
		Scan(&apiOnly, &disabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", ErrNotFound
	}
	if err != nil {
		return "", "", err
	}
	if disabled {
		return "", "", fmt.Errorf("user is disabled")
	}
	if !apiOnly {
		return "", "", fmt.Errorf("tokens are only issuable for api-only users")
	}
	raw, err := randomToken()
	if err != nil {
		return "", "", err
	}
	h, err := bcrypt.GenerateFromPassword([]byte(raw), 12)
	if err != nil {
		return "", "", err
	}
	err = s.pool.QueryRow(ctx, `
		INSERT INTO api_tokens (user_id, name, token_hash)
		VALUES ($1, $2, $3) RETURNING id::text`,
		userID, name, string(h)).Scan(&id)
	if err != nil {
		return "", "", err
	}
	return raw, id, nil
}

func (s *Store) ListAPITokens(ctx context.Context, userID string) ([]APIToken, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, user_id::text, name, created_at, last_used_at
		FROM api_tokens WHERE user_id=$1 ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []APIToken
	for rows.Next() {
		var t APIToken
		if err := rows.Scan(&t.ID, &t.UserID, &t.Name, &t.CreatedAt, &t.LastUsedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) RevokeAPIToken(ctx context.Context, tokenID string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM api_tokens WHERE id=$1`, tokenID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	// Invalidate any cached session that was resolved from this token.
	// We don't track token→cached-session; simplest is to drop all
	// api-only sessions and let them re-resolve. Scale is tiny.
	s.dropSessions(func(sess Session) bool { return sess.APIOnly })
	return nil
}

// resolveBearer walks the api_tokens table looking for a bcrypt match
// with the given raw bearer. On match, returns a cacheable Session
// and touches last_used_at. At expected token counts (<100) a full
// scan is fine; if this ever gets busy we can add a short-prefix
// index column.
func (s *Store) resolveBearer(ctx context.Context, raw string) (Session, bool) {
	rows, err := s.pool.Query(ctx, `
		SELECT t.id::text, t.user_id::text, t.token_hash,
		       u.username, u.role, u.disabled, u.api_only
		FROM api_tokens t JOIN users u ON u.id = t.user_id`)
	if err != nil {
		return Session{}, false
	}
	defer rows.Close()
	for rows.Next() {
		var tokenID, userID, hash, username string
		var role Role
		var disabled, apiOnly bool
		if err := rows.Scan(&tokenID, &userID, &hash, &username, &role, &disabled, &apiOnly); err != nil {
			continue
		}
		if disabled {
			continue
		}
		if bcrypt.CompareHashAndPassword([]byte(hash), []byte(raw)) != nil {
			continue
		}
		// Match. Fire-and-forget the last_used_at bump so the request
		// path isn't slowed by the write.
		go func(id string) {
			_, _ = s.pool.Exec(context.Background(),
				`UPDATE api_tokens SET last_used_at = NOW() WHERE id=$1`, id)
		}(tokenID)
		return Session{
			Token:     raw,
			UserID:    userID,
			Username:  username,
			Role:      role,
			APIOnly:   apiOnly,
			ExpiresAt: time.Now().Add(5 * time.Minute), // cache lifetime
		}, true
	}
	return Session{}, false
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
		cameFromBearer := tok != ""
		if tok == "" {
			if c, err := r.Cookie("fnvr_session"); err == nil {
				tok = c.Value
			}
		}
		sess, ok := s.Validate(tok)
		if !ok && cameFromBearer {
			// Fall through to the api_tokens table — the bearer may be
			// a personal access token (not a session). Cache the hit so
			// subsequent requests skip the bcrypt + table scan.
			if resolved, rok := s.resolveBearer(r.Context(), tok); rok {
				s.mu.Lock()
				s.sessions[tok] = resolved
				s.mu.Unlock()
				sess, ok = resolved, true
			}
		}
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		r = r.WithContext(context.WithValue(r.Context(), sessionCtxKey, sess))
		next.ServeHTTP(w, r)
	})
}

// RequireAdmin returns 403 unless the session is an admin-class role
// (admin | superadmin). Authenticated-but-viewer = 403, not 401.
func RequireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sess, ok := SessionFrom(r.Context())
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if !IsAdmin(sess) {
			http.Error(w, "forbidden: admin role required", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// AdminFunc wraps a handler func with RequireAdmin — saves a lot of
// boilerplate at the route-registration site.
func AdminFunc(h http.HandlerFunc) http.Handler {
	return RequireAdmin(h)
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

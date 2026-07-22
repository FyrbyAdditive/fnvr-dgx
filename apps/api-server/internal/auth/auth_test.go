package auth

import (
	"testing"
	"time"
)

// storeForTest builds a Store without a DB pool or janitor goroutine —
// Validate and sweep only touch the in-memory session map.
func storeForTest(sessions map[string]Session) *Store {
	return &Store{sessions: sessions, done: make(chan struct{})}
}

func TestValidateEvictsExpired(t *testing.T) {
	s := storeForTest(map[string]Session{
		"dead": {Token: "dead", ExpiresAt: time.Now().Add(-time.Minute)},
	})
	if _, ok := s.Validate("dead"); ok {
		t.Fatal("expired session validated")
	}
	s.mu.RLock()
	_, still := s.sessions["dead"]
	s.mu.RUnlock()
	if still {
		t.Fatal("expired session not evicted by Validate")
	}
}

func TestSweepRemovesOnlyExpired(t *testing.T) {
	now := time.Now()
	s := storeForTest(map[string]Session{
		"dead":  {Token: "dead", ExpiresAt: now.Add(-time.Hour)},
		"alive": {Token: "alive", ExpiresAt: now.Add(time.Hour)},
	})
	s.sweep(now)
	s.mu.RLock()
	defer s.mu.RUnlock()
	if _, still := s.sessions["dead"]; still {
		t.Fatal("sweep kept an expired session")
	}
	if _, kept := s.sessions["alive"]; !kept {
		t.Fatal("sweep removed a live session")
	}
}

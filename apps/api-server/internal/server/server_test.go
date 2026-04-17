package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/fnvr/fnvr/apps/api-server/internal/config"
)

// TestHealthNoDB covers only the routing layer — no DB hit.
// Real DB-backed tests live in integration tests under tests/integration/.
func TestRoutingRegistered(t *testing.T) {
	// Construct with zero deps — we only hit /api/v1/system/info, which doesn't
	// touch the pool or any store. The exercise is that Handler() wires up.
	defer func() {
		if r := recover(); r != nil {
			// If someone removes the zero-dep paths, this alerts them loudly.
			t.Fatalf("routing panicked: %v", r)
		}
	}()
	s := New(Deps{Config: &config.Config{}})
	h := s.Handler()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/system/info", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("system info: got %d want 200, body=%s", rec.Code, rec.Body.String())
	}
}

package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/fnvr/fnvr/apps/api-server/internal/classes"
	"github.com/fnvr/fnvr/apps/api-server/internal/config"
	"github.com/fnvr/fnvr/apps/api-server/internal/detections"
	"github.com/fnvr/fnvr/apps/api-server/internal/flags"
	"github.com/fnvr/fnvr/apps/api-server/internal/notifications"
	"github.com/fnvr/fnvr/apps/api-server/internal/persons"
	"github.com/fnvr/fnvr/apps/api-server/internal/rules"
	"github.com/fnvr/fnvr/apps/api-server/internal/segments"
	"github.com/fnvr/fnvr/apps/api-server/internal/settings"
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

// TestRoutingRegisteredFullDeps constructs with all the stores that
// register overlapping /api/v1/detections* patterns (segments: exact +
// /summary; flags via persons: the /detections/ prefix). A duplicate
// pattern — e.g. someone registering the summary route as a prefix —
// panics inside Handler(), which this catches at registration time
// without needing a DB.
func TestRoutingRegisteredFullDeps(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("routing with full deps panicked: %v", r)
		}
	}()
	s := New(Deps{
		Config:        &config.Config{},
		Rules:         &rules.Store{},
		Segments:      &segments.Store{},
		Detections:    &detections.Store{},
		Persons:       &persons.Store{},
		Flags:         &flags.Store{},
		Settings:      &settings.Store{},
		Classes:       &classes.Store{},
		Notifications: &notifications.Store{},
	})
	_ = s.Handler()
}

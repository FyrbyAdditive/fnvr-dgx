package camera

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
)

// StateTracker subscribes to fnvr.events.system.camera and keeps the latest
// known state per camera (starting | running | failed). States older than
// 10 minutes with no update are treated as unknown.
type StateTracker struct {
	nc *nats.Conn

	mu      sync.RWMutex
	entries map[string]stateEntry
}

type stateEntry struct {
	State    string
	Stamped  time.Time
}

func NewStateTracker(natsURL string) (*StateTracker, error) {
	nc, err := nats.Connect(natsURL,
		nats.Name("fnvr-api-camstate"),
		nats.MaxReconnects(-1),
		nats.ReconnectWait(2*time.Second),
	)
	if err != nil {
		return nil, err
	}
	return &StateTracker{nc: nc, entries: map[string]stateEntry{}}, nil
}

func (t *StateTracker) Start(ctx context.Context) error {
	_, err := t.nc.Subscribe("fnvr.events.system.camera", func(m *nats.Msg) {
		var msg struct {
			CameraID string `json:"camera_id"`
			State    string `json:"state"`
		}
		if err := json.Unmarshal(m.Data, &msg); err != nil {
			slog.Warn("camera-state: bad payload", "err", err)
			return
		}
		if msg.CameraID == "" || msg.State == "" {
			return
		}
		t.mu.Lock()
		t.entries[msg.CameraID] = stateEntry{State: msg.State, Stamped: time.Now()}
		t.mu.Unlock()
	})
	if err != nil {
		return err
	}
	go func() {
		<-ctx.Done()
		_ = t.nc.Drain()
	}()
	return nil
}

// State returns the last known state and true, or "", false if unknown or
// stale. "running" entries stay fresh for 10 minutes; anything else for
// 2 minutes (failed/starting both self-expire so a crashed worker doesn't
// advertise a stale "starting" forever).
func (t *StateTracker) State(cameraID string) (string, bool) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	e, ok := t.entries[cameraID]
	if !ok {
		return "", false
	}
	maxAge := 2 * time.Minute
	if e.State == "running" {
		maxAge = 10 * time.Minute
	}
	if time.Since(e.Stamped) > maxAge {
		return "", false
	}
	return e.State, true
}

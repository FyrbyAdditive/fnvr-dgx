package camera

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

// StateTracker keeps the latest known pipeline state per camera:
// "starting" | "running" | "failed". Older-than-10-minute states are
// returned as unknown so a crashed worker doesn't advertise "running"
// forever.
//
// Backed by a JetStream "last-value" stream (MaxMsgsPerSubject=1): when a
// new api-server starts up, replaying the stream gives us the current
// state per camera even if the publisher (pipeline worker) hasn't said
// anything in a while. Previously this was a plain NATS subscribe, which
// meant an api-server restart left all cameras stuck at "unknown" until
// workers happened to emit a fresh state transition — which they only
// do on (re)start.
type StateTracker struct {
	nc *nats.Conn
	js jetstream.JetStream

	mu      sync.RWMutex
	entries map[string]stateEntry
}

type stateEntry struct {
	State   string
	Stamped time.Time
}

const (
	// streamName is stable; safe to change only with a corresponding drop.
	streamName = "FNVR_CAMERA_STATE"
	// subjectPrefix — the wildcard subject the stream owns. Publishers use
	// fnvr.state.camera.<camera_id>.
	subjectFilter = "fnvr.state.camera.*"
)

func NewStateTracker(natsURL string) (*StateTracker, error) {
	nc, err := nats.Connect(natsURL,
		nats.Name("fnvr-api-camstate"),
		nats.MaxReconnects(-1),
		nats.ReconnectWait(2*time.Second),
	)
	if err != nil {
		return nil, err
	}
	js, err := jetstream.New(nc)
	if err != nil {
		nc.Close()
		return nil, fmt.Errorf("jetstream: %w", err)
	}
	return &StateTracker{nc: nc, js: js, entries: map[string]stateEntry{}}, nil
}

func (t *StateTracker) Start(ctx context.Context) error {
	// Declare the stream idempotently. MaxMsgsPerSubject=1 makes this a
	// last-value store — only the newest publish per camera is retained,
	// the rest are auto-discarded. Storage=memory because this is live
	// state; we don't care about persisting it across a NATS restart.
	cfg := jetstream.StreamConfig{
		Name:              streamName,
		Subjects:          []string{subjectFilter},
		Retention:         jetstream.LimitsPolicy,
		Discard:           jetstream.DiscardOld,
		MaxMsgsPerSubject: 1,
		Storage:           jetstream.MemoryStorage,
	}
	if _, err := t.js.CreateOrUpdateStream(ctx, cfg); err != nil {
		return fmt.Errorf("create stream: %w", err)
	}

	// Ephemeral consumer with DeliverAllPolicy. Because the stream has
	// MaxMsgsPerSubject=1, "all" is exactly the latest message per
	// camera — which is what we want on startup. After that, new
	// publishes stream in live.
	cons, err := t.js.CreateOrUpdateConsumer(ctx, streamName, jetstream.ConsumerConfig{
		DeliverPolicy: jetstream.DeliverAllPolicy,
		AckPolicy:     jetstream.AckNonePolicy,
		FilterSubject: subjectFilter,
	})
	if err != nil {
		return fmt.Errorf("create consumer: %w", err)
	}

	_, err = cons.Consume(func(m jetstream.Msg) {
		var msg struct {
			CameraID string `json:"camera_id"`
			State    string `json:"state"`
		}
		if err := json.Unmarshal(m.Data(), &msg); err != nil {
			slog.Warn("camera-state: bad payload", "err", err)
			return
		}
		if msg.CameraID == "" || msg.State == "" {
			return
		}
		// Prefer the server-stamped time when available so replays on
		// startup don't look newer than they actually are; fall back to
		// now when metadata is missing (shouldn't happen for JS msgs).
		stamped := time.Now()
		if meta, err := m.Metadata(); err == nil && !meta.Timestamp.IsZero() {
			stamped = meta.Timestamp
		}
		t.mu.Lock()
		t.entries[msg.CameraID] = stateEntry{State: msg.State, Stamped: stamped}
		t.mu.Unlock()
	})
	if err != nil {
		return fmt.Errorf("consume: %w", err)
	}

	go func() {
		<-ctx.Done()
		_ = t.nc.Drain()
	}()
	return nil
}

// State returns the last known state and true, or "", false if unknown
// or stale. Freshness window varies by state:
//   - "running":   10 min (long — the supervisor re-publishes "running"
//                  on every reconnect, so genuinely stuck workers time
//                  out eventually).
//   - "starting":  15 min (long — first-use TRT engine compiles can
//                  take 10+ min on yolo26x; we don't want the UI to
//                  flash "pipeline offline" mid-build).
//   - other:       2 min  (failed / unexpected states self-expire).
func (t *StateTracker) State(cameraID string) (string, bool) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	e, ok := t.entries[cameraID]
	if !ok {
		return "", false
	}
	maxAge := 2 * time.Minute
	switch e.State {
	case "running":
		maxAge = 10 * time.Minute
	case "starting":
		maxAge = 15 * time.Minute
	}
	if time.Since(e.Stamped) > maxAge {
		return "", false
	}
	return e.State, true
}

// Unused import guard — we want to surface jetstream.ErrNoStreamResponse
// style errors clearly if the broker is unreachable, but errors.Is isn't
// used yet. Left referenced so linters don't strip the import.
var _ = errors.Is

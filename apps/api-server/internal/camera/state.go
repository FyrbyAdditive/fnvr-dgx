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
// Transport: live heartbeats arrive via a plain core-NATS subscription
// on `fnvr.state.camera.*`. On Start(), we do a one-shot walk of the
// JetStream last-value stream (FNVR_CAMERA_STATE) to prime the tracker
// with whatever the most recent message per camera was — this covers
// the cold-start case where api-server restarts and no worker has
// re-heartbeated yet (heartbeats are every 30 s).
//
// We used to hold an ephemeral JetStream consumer here; that produced
// ~6-hour false-offline states twice (2026-04-20, 2026-04-23) when the
// consumer's internal fetch loop died silently and we never learned
// about it (the returned ConsumeContext was discarded, so the error
// callback was unregistered). Core NATS's nats.Subscription handles
// reconnect/resubscribe internally and is the same transport we rely
// on elsewhere in this codebase without incident.
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
	// subjectFilter — the wildcard subject the stream owns. Publishers use
	// fnvr.state.camera.<camera_id>.
	subjectFilter = "fnvr.state.camera.*"
	// subjectPrefix — used to build per-camera subjects for replay.
	subjectPrefix = "fnvr.state.camera."
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

// Start subscribes to live heartbeats and primes the tracker from the
// JetStream last-value stream for every camera id in `ids`. An empty
// `ids` slice is valid — the first live heartbeat per camera will
// populate the tracker.
func (t *StateTracker) Start(ctx context.Context, ids []string) error {
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

	// Live: core-NATS sub. Subscribes to the wildcard; each message's
	// subject is fnvr.state.camera.<id> but the body already contains
	// the camera_id, so we don't need to parse the subject ourselves.
	sub, err := t.nc.Subscribe(subjectFilter, func(m *nats.Msg) {
		t.ingest(m.Data, time.Now())
	})
	if err != nil {
		return fmt.Errorf("subscribe: %w", err)
	}

	// Startup replay from the last-value stream. Subscribe-first-then-
	// replay order means a live message that lands mid-replay wins via
	// the stamp comparison inside ingest() — we never clobber a fresh
	// live state with a stale replayed one.
	if len(ids) > 0 {
		stream, err := t.js.Stream(ctx, streamName)
		if err != nil {
			sub.Unsubscribe()
			return fmt.Errorf("stream handle: %w", err)
		}
		for _, id := range ids {
			if id == "" {
				continue
			}
			raw, err := stream.GetLastMsgForSubject(ctx, subjectPrefix+id)
			if err != nil {
				if errors.Is(err, jetstream.ErrMsgNotFound) {
					continue
				}
				slog.Warn("camera-state: replay failed", "camera_id", id, "err", err)
				continue
			}
			stamp := raw.Time
			if stamp.IsZero() {
				stamp = time.Now()
			}
			t.ingest(raw.Data, stamp)
		}
	}

	go func() {
		<-ctx.Done()
		_ = sub.Unsubscribe()
		_ = t.nc.Drain()
	}()
	return nil
}

// ingest parses a state payload and stores it if newer than what we
// already have. Shared between the live core-NATS sub and the startup
// JetStream replay.
func (t *StateTracker) ingest(data []byte, stamp time.Time) {
	var msg struct {
		CameraID string `json:"camera_id"`
		State    string `json:"state"`
	}
	if err := json.Unmarshal(data, &msg); err != nil {
		slog.Warn("camera-state: bad payload", "err", err)
		return
	}
	if msg.CameraID == "" || msg.State == "" {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if prev, ok := t.entries[msg.CameraID]; ok && stamp.Before(prev.Stamped) {
		return
	}
	t.entries[msg.CameraID] = stateEntry{State: msg.State, Stamped: stamp}
}

// State returns the last known state and true, or "", false if unknown
// or stale. Freshness window varies by state:
//   - "running":   10 min (long — the supervisor re-publishes "running"
//     on every reconnect, so genuinely stuck workers time
//     out eventually).
//   - "starting":  15 min (long — first-use TRT engine compiles can
//     take 10+ min on yolo26x; we don't want the UI to
//     flash "pipeline offline" mid-build).
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

// StateDetail returns the raw last-known state plus the stamped time,
// even if the freshness window has expired. Callers use this to
// distinguish "never heard from this camera" (zero time) from
// "previously running, heartbeat now stale" (a non-zero time in the
// past) so the UI can surface the age explicitly instead of just
// saying "unknown".
func (t *StateTracker) StateDetail(cameraID string) (state string, stamped time.Time, known bool) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	e, ok := t.entries[cameraID]
	if !ok {
		return "", time.Time{}, false
	}
	return e.State, e.Stamped, true
}

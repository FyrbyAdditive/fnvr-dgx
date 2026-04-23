package pipeline

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

// StateTracker mirrors the camera state tracker but for the pipeline
// container as a whole. The container publishes one of:
//
//	{"state":"calibrating",     "variant":"yolo26x", "precision":"int8", "message":"..."}
//	{"state":"compiling_engine","variant":"yolo26x", "precision":"fp16", "message":"..."}
//	{"state":"ready"}
//	{"state":"failed",          "message":"..."}
//
// to the subject fnvr.state.pipeline. Transport matches
// camera.StateTracker: live messages via core-NATS subscription, with a
// one-shot replay from the JetStream last-value stream on startup so a
// fresh api-server sees the current state immediately rather than
// waiting for the next publish.
type StateTracker struct {
	nc *nats.Conn
	js jetstream.JetStream

	mu    sync.RWMutex
	cur   State
	known bool
}

type State struct {
	State     string    `json:"state"`
	Variant   string    `json:"variant,omitempty"`
	Precision string    `json:"precision,omitempty"`
	Message   string    `json:"message,omitempty"`
	Stamped   time.Time `json:"stamped,omitempty"`
}

const (
	streamName = "FNVR_PIPELINE_STATE"
	subject    = "fnvr.state.pipeline"
)

func NewStateTracker(natsURL string) (*StateTracker, error) {
	nc, err := nats.Connect(natsURL,
		nats.Name("fnvr-api-pipelinestate"),
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
	return &StateTracker{nc: nc, js: js}, nil
}

func (t *StateTracker) Start(ctx context.Context) error {
	cfg := jetstream.StreamConfig{
		Name:              streamName,
		Subjects:          []string{subject},
		Retention:         jetstream.LimitsPolicy,
		Discard:           jetstream.DiscardOld,
		MaxMsgsPerSubject: 1,
		Storage:           jetstream.MemoryStorage,
	}
	if _, err := t.js.CreateOrUpdateStream(ctx, cfg); err != nil {
		return fmt.Errorf("create stream: %w", err)
	}

	sub, err := t.nc.Subscribe(subject, func(m *nats.Msg) {
		t.ingest(m.Data, time.Now())
	})
	if err != nil {
		return fmt.Errorf("subscribe: %w", err)
	}

	// One-shot replay: single subject, so one GetLastMsgForSubject call.
	stream, err := t.js.Stream(ctx, streamName)
	if err != nil {
		sub.Unsubscribe()
		return fmt.Errorf("stream handle: %w", err)
	}
	raw, err := stream.GetLastMsgForSubject(ctx, subject)
	switch {
	case err == nil:
		stamp := raw.Time
		if stamp.IsZero() {
			stamp = time.Now()
		}
		t.ingest(raw.Data, stamp)
	case errors.Is(err, jetstream.ErrMsgNotFound):
		// pipeline has never published since the stream was created — fine
	default:
		slog.Warn("pipeline-state: replay failed", "err", err)
	}

	go func() {
		<-ctx.Done()
		_ = sub.Unsubscribe()
		_ = t.nc.Drain()
	}()
	return nil
}

// ingest parses a pipeline state payload and stores it if newer than
// what we already have. Shared between the live core-NATS sub and the
// startup JetStream replay.
func (t *StateTracker) ingest(data []byte, stamp time.Time) {
	var s State
	if err := json.Unmarshal(data, &s); err != nil {
		slog.Warn("pipeline-state: bad payload", "err", err)
		return
	}
	s.Stamped = stamp
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.known && stamp.Before(t.cur.Stamped) {
		return
	}
	t.cur = s
	t.known = true
}

// Current returns the last-known pipeline state. If the tracker has
// never seen a message (pipeline container never came up since NATS
// started), returns State{State:"unknown"} with known=false.
func (t *StateTracker) Current() (State, bool) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	if !t.known {
		return State{State: "unknown"}, false
	}
	return t.cur, true
}

// Publish sends a raw NATS message on any subject using the tracker's
// underlying connection. Handy for the "restart pipeline" signal so the
// server package doesn't need its own NATS conn.
func (t *StateTracker) Publish(subject string, data []byte) error {
	return t.nc.Publish(subject, data)
}

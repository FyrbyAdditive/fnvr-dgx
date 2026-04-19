package pipeline

import (
	"context"
	"encoding/json"
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
// to the subject fnvr.state.pipeline. Stream is JetStream with
// MaxMsgsPerSubject=1 (last-value), so a fresh api-server immediately
// sees the current state on subscribe rather than getting stuck until
// the pipeline happens to re-announce.
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
	cons, err := t.js.CreateOrUpdateConsumer(ctx, streamName, jetstream.ConsumerConfig{
		DeliverPolicy: jetstream.DeliverAllPolicy,
		AckPolicy:     jetstream.AckNonePolicy,
		FilterSubject: subject,
	})
	if err != nil {
		return fmt.Errorf("create consumer: %w", err)
	}
	_, err = cons.Consume(func(m jetstream.Msg) {
		var s State
		if err := json.Unmarshal(m.Data(), &s); err != nil {
			slog.Warn("pipeline-state: bad payload", "err", err)
			return
		}
		if meta, err := m.Metadata(); err == nil && !meta.Timestamp.IsZero() {
			s.Stamped = meta.Timestamp
		} else {
			s.Stamped = time.Now()
		}
		t.mu.Lock()
		t.cur = s
		t.known = true
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

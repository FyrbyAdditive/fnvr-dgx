// Package events subscribes to detection events from NATS and fans them out
// to connected web clients via Server-Sent Events.
package events

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
)

// Detection mirrors the shape of fnvr.events.v1.Detection on the wire.
// JSON for now — we'll switch to protobuf-over-NATS once the codegen lands.
type Detection struct {
	ID         string             `json:"id"`
	CameraID   string             `json:"camera_id"`
	TS         time.Time          `json:"ts"`
	ClassName  string             `json:"class_name"`
	// Kind is "object" | "anpr" | "face". Empty on the wire is legacy
	// pre-ANPR pipelines; consumers treat as "object".
	Kind       string             `json:"kind,omitempty"`
	Confidence float32            `json:"confidence"`
	X, Y, W, H float32            `json:"-"`
	BBox       map[string]float32 `json:"bbox"`
	TrackID    string             `json:"track_id,omitempty"`
	Attributes map[string]string  `json:"attributes,omitempty"`
}

type Bus struct {
	nc *nats.Conn

	mu          sync.RWMutex
	subscribers map[chan Detection]struct{}
}

func NewBus(url string) (*Bus, error) {
	nc, err := nats.Connect(url,
		nats.Name("fnvr-api"),
		nats.MaxReconnects(-1),
		nats.ReconnectWait(2*time.Second),
	)
	if err != nil {
		return nil, fmt.Errorf("nats connect: %w", err)
	}
	return &Bus{nc: nc, subscribers: map[chan Detection]struct{}{}}, nil
}

func (b *Bus) Start(ctx context.Context) error {
	_, err := b.nc.Subscribe("fnvr.events.detection.>", func(msg *nats.Msg) {
		var d Detection
		if err := json.Unmarshal(msg.Data, &d); err != nil {
			slog.Warn("events: bad detection payload", "err", err)
			return
		}
		b.fanout(d)
	})
	if err != nil {
		return err
	}
	slog.Info("events: subscribed to fnvr.events.detection.>")
	go func() {
		<-ctx.Done()
		_ = b.nc.Drain()
	}()
	return nil
}

func (b *Bus) fanout(d Detection) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for ch := range b.subscribers {
		select {
		case ch <- d:
		default:
			// Drop rather than block — slow client problem, not ours.
		}
	}
}

// Subscribe returns a channel that receives all detections plus a cleanup fn.
func (b *Bus) Subscribe() (<-chan Detection, func()) {
	ch := make(chan Detection, 64)
	b.mu.Lock()
	b.subscribers[ch] = struct{}{}
	b.mu.Unlock()
	return ch, func() {
		b.mu.Lock()
		delete(b.subscribers, ch)
		b.mu.Unlock()
		close(ch)
	}
}

// SSEHandler streams detections to a browser as Server-Sent Events.
// The web UI consumes this for live overlay + event feed.
func (b *Bus) SSEHandler(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	ch, cleanup := b.Subscribe()
	defer cleanup()

	ctx := r.Context()
	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ping.C:
			fmt.Fprintf(w, ": ping\n\n")
			flusher.Flush()
		case d, open := <-ch:
			if !open {
				return
			}
			buf, _ := json.Marshal(d)
			fmt.Fprintf(w, "event: detection\ndata: %s\n\n", buf)
			flusher.Flush()
		}
	}
}

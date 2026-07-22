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
//
// Source subject: `fnvr.events.detection_accepted.<camera_id>`,
// republished by event-processor after it has passed suppression,
// zone/class mutes, face match enrichment, and the PG INSERT. We
// used to consume `fnvr.events.detection.*` directly from the
// pipeline, but that bypassed suppression decisions — flagged false
// positives still appeared on the Live view.
type Detection struct {
	// PgID is the row id in the `detections` table, 0 if event-
	// processor hasn't assigned one (shouldn't happen on the
	// accepted subject; kept 0-tolerant for defensiveness).
	PgID int64 `json:"pg_id"`
	// ID preserves the pipeline's event_id (short hex) as `id` on
	// the wire for backwards compat with clients that pre-date the
	// accepted-subject switch. New clients should prefer PgID.
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

	// Subscribers receive fully-built SSE frames: the frame is
	// serialised once per detection, not once per connected client.
	mu          sync.RWMutex
	subscribers map[chan []byte]struct{}
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
	return &Bus{nc: nc, subscribers: map[chan []byte]struct{}{}}, nil
}

func (b *Bus) Start(ctx context.Context) error {
	// Consume event-processor's republished accepted detections, not
	// the raw pipeline subject. Accepted = passed object-flag
	// suppression + zone/class mutes + face-match enrichment + PG
	// INSERT. Flagged false positives never reach the SSE stream.
	_, err := b.nc.Subscribe("fnvr.events.detection_accepted.>", func(msg *nats.Msg) {
		var d Detection
		if err := json.Unmarshal(msg.Data, &d); err != nil {
			slog.Warn("events: bad detection payload", "err", err)
			return
		}
		// Re-marshal through the struct (rather than passing msg.Data
		// through) so the wire shape stays exactly what clients have
		// always received; but do it once here, not per subscriber.
		buf, err := json.Marshal(d)
		if err != nil {
			return
		}
		frame := make([]byte, 0, len(buf)+len(sseFramePrefix)+2)
		frame = append(frame, sseFramePrefix...)
		frame = append(frame, buf...)
		frame = append(frame, '\n', '\n')
		b.fanout(frame)
	})
	if err != nil {
		return err
	}
	slog.Info("events: subscribed to fnvr.events.detection_accepted.>")
	go func() {
		<-ctx.Done()
		_ = b.nc.Drain()
	}()
	return nil
}

const sseFramePrefix = "event: detection\ndata: "

func (b *Bus) fanout(frame []byte) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for ch := range b.subscribers {
		select {
		case ch <- frame:
		default:
			// Drop rather than block — slow client problem, not ours.
		}
	}
}

// Subscribe returns a channel of ready-to-write SSE frames plus a
// cleanup fn.
func (b *Bus) Subscribe() (<-chan []byte, func()) {
	ch := make(chan []byte, 64)
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
		case frame, open := <-ch:
			if !open {
				return
			}
			_, _ = w.Write(frame)
			flusher.Flush()
		}
	}
}

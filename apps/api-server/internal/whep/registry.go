// Package whep tracks which internal port hosts the WHEP server for each
// camera. Workers publish {camera_id, port} to the "fnvr.whep.registry"
// NATS subject on startup; api-server subscribes and proxies browser WHEP
// requests to the right internal address.
package whep

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
)

type Entry struct {
	CameraID string `json:"camera_id"`
	Port     int    `json:"port"`
	Stamped  time.Time
}

type Registry struct {
	nc *nats.Conn

	mu      sync.RWMutex
	entries map[string]Entry // camera_id → entry
}

func NewRegistry(url string) (*Registry, error) {
	nc, err := nats.Connect(url,
		nats.Name("fnvr-api-whep"),
		nats.MaxReconnects(-1),
		nats.ReconnectWait(2*time.Second),
	)
	if err != nil {
		return nil, err
	}
	return &Registry{nc: nc, entries: map[string]Entry{}}, nil
}

func (r *Registry) Start(ctx context.Context) error {
	_, err := r.nc.Subscribe("fnvr.whep.registry", func(m *nats.Msg) {
		var e Entry
		if err := json.Unmarshal(m.Data, &e); err != nil {
			slog.Warn("whep: bad registry payload", "err", err)
			return
		}
		e.Stamped = time.Now()
		r.mu.Lock()
		r.entries[e.CameraID] = e
		r.mu.Unlock()
		slog.Info("whep: registered", "camera", e.CameraID, "port", e.Port)
	})
	if err != nil {
		return err
	}
	go func() {
		<-ctx.Done()
		_ = r.nc.Drain()
	}()
	return nil
}

// Lookup returns the latest port published for a camera. Entries older
// than 10 minutes are treated as stale (worker likely restarted without
// republishing yet).
func (r *Registry) Lookup(cameraID string) (Entry, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	e, ok := r.entries[cameraID]
	if !ok {
		return Entry{}, false
	}
	if time.Since(e.Stamped) > 10*time.Minute {
		return Entry{}, false
	}
	return e, true
}

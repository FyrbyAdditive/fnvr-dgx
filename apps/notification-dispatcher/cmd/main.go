package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/fnvr/fnvr/apps/notification-dispatcher/internal/channels"
	"github.com/fnvr/fnvr/apps/notification-dispatcher/internal/habridge"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	cfg := channels.Config{
		NATSURL:     envOr("FNVR_NATS_URL", "nats://nats:4222"),
		DatabaseURL: envOr("FNVR_DATABASE_URL", "postgres://fnvr:fnvr@postgres:5432/fnvr?sslmode=disable"),
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Same retry shape as event-processor: migrations are owned by api-server
	// so we may race it on first boot.
	backoff := time.Second
	for ctx.Err() == nil {
		d, err := channels.New(ctx, cfg)
		if err != nil {
			slog.Warn("dispatcher init — retrying", "err", err, "sleep", backoff)
			sleepOrDone(ctx, backoff)
			backoff = minDur(backoff*2, 30*time.Second)
			continue
		}
		slog.Info("notification-dispatcher running")

		// Home Assistant bridge watcher: polls settings.ha.config every
		// 30s, Start/Stops the bridge on change. Shares the Dispatcher's
		// MQTT hub so enabling both an mqtt channel and HA on the same
		// broker reuses one TCP session.
		bridge := habridge.New(d.Pool(), d.NATS(), d.Hub())
		go watchHAConfig(ctx, d, bridge)

		runErr := d.Run(ctx)
		bridge.Stop()
		d.Close()
		if ctx.Err() != nil {
			break
		}
		slog.Warn("dispatcher exited — retrying", "err", runErr, "sleep", backoff)
		sleepOrDone(ctx, backoff)
		backoff = minDur(backoff*2, 30*time.Second)
	}
}

// watchHAConfig periodically reloads the ha.config row and (re)starts
// the bridge if it changed. 30s cadence matches event-processor's
// reload loop — consistent "config edits take effect within 30s".
func watchHAConfig(ctx context.Context, d *channels.Dispatcher, bridge *habridge.Bridge) {
	var last habridge.Config
	apply := func() {
		cur, ok := readHAConfig(ctx, d)
		if !ok {
			return
		}
		if cur == last {
			return
		}
		last = cur
		if err := bridge.Start(ctx, cur); err != nil {
			slog.Warn("ha bridge: start failed", "err", err)
		}
	}
	apply()
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			apply()
		}
	}
}

func readHAConfig(ctx context.Context, d *channels.Dispatcher) (habridge.Config, bool) {
	var raw []byte
	err := d.Pool().QueryRow(ctx,
		`SELECT value FROM settings WHERE key = 'ha.config'`).Scan(&raw)
	if err != nil {
		return habridge.Config{}, false
	}
	var parsed struct {
		Enabled         bool   `json:"enabled"`
		BrokerURL       string `json:"broker_url"`
		Username        string `json:"username"`
		Password        string `json:"password"`
		DiscoveryPrefix string `json:"discovery_prefix"`
		TopicPrefix     string `json:"topic_prefix"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return habridge.Config{}, false
	}
	return habridge.Config{
		Enabled:         parsed.Enabled,
		BrokerURL:       parsed.BrokerURL,
		Username:        parsed.Username,
		Password:        parsed.Password,
		DiscoveryPrefix: parsed.DiscoveryPrefix,
		TopicPrefix:     parsed.TopicPrefix,
	}, true
}

func sleepOrDone(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

func minDur(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

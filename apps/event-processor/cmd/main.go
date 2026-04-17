package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/fnvr/fnvr/apps/event-processor/internal/rules"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	cfg := rules.Config{
		NATSURL:     envOr("FNVR_NATS_URL", "nats://nats:4222"),
		DatabaseURL: envOr("FNVR_DATABASE_URL", "postgres://fnvr:fnvr@postgres:5432/fnvr?sslmode=disable"),
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Loop with backoff — the schema is applied by api-server on its own
	// start, so we may race it on first boot. Retrying beats fataling.
	backoff := time.Second
	for ctx.Err() == nil {
		engine, err := rules.New(ctx, cfg)
		if err != nil {
			slog.Warn("engine init — retrying", "err", err, "sleep", backoff)
			sleepOrDone(ctx, backoff)
			backoff = minDur(backoff*2, 30*time.Second)
			continue
		}
		slog.Info("event-processor running")
		runErr := engine.Run(ctx)
		engine.Close()
		if ctx.Err() != nil {
			break
		}
		slog.Warn("engine exited — retrying", "err", runErr, "sleep", backoff)
		sleepOrDone(ctx, backoff)
		backoff = minDur(backoff*2, 30*time.Second)
	}
	time.Sleep(500 * time.Millisecond)
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

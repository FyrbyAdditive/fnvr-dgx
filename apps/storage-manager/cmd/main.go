package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/fnvr/fnvr/apps/storage-manager/internal/lifecycle"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	cfg := lifecycle.Config{
		DatabaseURL:   envOr("FNVR_DATABASE_URL", "postgres://fnvr:fnvr@postgres:5432/fnvr?sslmode=disable"),
		RecordingsDir: envOr("FNVR_RECORDINGS_DIR", "/var/lib/fnvr/recordings"),
		ScanInterval:  30 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	mgr, err := lifecycle.New(ctx, cfg)
	if err != nil {
		slog.Error("init", "err", err); os.Exit(1)
	}
	defer mgr.Close()

	slog.Info("storage-manager running", "dir", cfg.RecordingsDir)
	if err := mgr.Run(ctx); err != nil {
		slog.Error("run", "err", err); os.Exit(1)
	}
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" { return v }
	return def
}

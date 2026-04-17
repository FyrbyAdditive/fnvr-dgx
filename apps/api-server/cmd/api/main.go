package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/fnvr/fnvr/apps/api-server/internal/auth"
	"github.com/fnvr/fnvr/apps/api-server/internal/camera"
	"github.com/fnvr/fnvr/apps/api-server/internal/config"
	"github.com/fnvr/fnvr/apps/api-server/internal/db"
	"github.com/fnvr/fnvr/apps/api-server/internal/events"
	"github.com/fnvr/fnvr/apps/api-server/internal/pipeline"
	"github.com/fnvr/fnvr/apps/api-server/internal/rules"
	"github.com/fnvr/fnvr/apps/api-server/internal/server"
	"github.com/fnvr/fnvr/apps/api-server/internal/snapshot"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))

	cmd := "serve"
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	switch cmd {
	case "serve":
		exit(runServe())
	case "migrate":
		exit(runMigrate())
	case "seed":
		exit(runSeed())
	case "version":
		fmt.Println("fnvr-api dev")
	default:
		fmt.Fprintf(os.Stderr, "usage: fnvr-api [serve|migrate|seed|version]\n")
		os.Exit(2)
	}
}

func exit(err error) {
	if err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func runMigrate() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	slog.Info("applying migrations")
	return db.Migrate(context.Background(), cfg.DatabaseURL)
}

func runSeed() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx := context.Background()
	pool, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	a := auth.NewStore(pool, 24*time.Hour)
	created, err := a.BootstrapAdmin(ctx)
	if err != nil {
		return err
	}
	if created {
		slog.Warn("bootstrapped default admin user — change the password immediately", "user", "admin")
	} else {
		slog.Info("users already exist — nothing to seed")
	}
	return nil
}

func runServe() error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Migrations are idempotent — run on every start so compose-up "just works".
	if err := db.Migrate(ctx, cfg.DatabaseURL); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}

	pool, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("db open: %w", err)
	}
	defer pool.Close()

	authStore := auth.NewStore(pool, 24*time.Hour)
	if created, err := authStore.BootstrapAdmin(ctx); err != nil {
		return fmt.Errorf("bootstrap admin: %w", err)
	} else if created {
		slog.Warn("bootstrapped default admin user admin/admin — change it immediately")
	}

	bus, err := events.NewBus(cfg.NATSURL)
	if err != nil {
		return fmt.Errorf("events bus: %w", err)
	}
	if err := bus.Start(ctx); err != nil {
		return fmt.Errorf("events start: %w", err)
	}

	srv := server.New(server.Deps{
		Config:    cfg,
		Pool:      pool,
		Auth:      authStore,
		Cameras:   camera.NewStore(pool),
		Pipeline:  pipeline.LoggingClient{}, // swap for the generated gRPC client when ready
		Events:    bus,
		Rules:     rules.NewStore(pool),
		Snapshots: snapshot.New(cfg.DataDir + "/recordings"),
	})

	httpSrv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		slog.Info("api-server listening", "addr", cfg.HTTPAddr)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case <-ctx.Done():
		slog.Info("shutdown signal received")
	case err := <-errCh:
		return err
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return httpSrv.Shutdown(shutdownCtx)
}

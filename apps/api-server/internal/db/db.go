package db

import (
	"context"
	"embed"
	"fmt"

	_ "github.com/jackc/pgx/v5/stdlib" // register "pgx" database/sql driver for goose
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pressly/goose/v3"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Open creates a pgxpool connected to the configured URL.
func Open(ctx context.Context, url string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("parse pg config: %w", err)
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("pgxpool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return pool, nil
}

// Migrate applies all pending migrations.
// The migration files are held at tools/migrate/migrations/*.sql in the repo;
// they're copied into this package's embed FS at build time via go:generate,
// or referenced from the build context in the Dockerfile.
func Migrate(ctx context.Context, url string) error {
	goose.SetBaseFS(migrationsFS)
	if err := goose.SetDialect("postgres"); err != nil {
		return err
	}
	sqldb, err := goose.OpenDBWithDriver("pgx", url)
	if err != nil {
		return err
	}
	defer sqldb.Close()
	return goose.UpContext(ctx, sqldb, "migrations")
}

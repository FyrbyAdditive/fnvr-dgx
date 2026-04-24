package config

import (
	"os"
)

type Config struct {
	HTTPAddr    string
	DatabaseURL string
	NATSURL     string
	RedisURL    string
	DataDir     string
	// MtxAPIURL is the base URL for MediaMTX's runtime config API. Empty
	// disables the re-muxer integration (the mtx_proxy toggle in the
	// UI still writes the flag, but nothing applies it). Typical value
	// on a docker-compose deploy: http://mediamtx:9997.
	MtxAPIURL string
}

func Load() (*Config, error) {
	return &Config{
		HTTPAddr:    envOr("FNVR_HTTP_ADDR", ":8081"),
		DatabaseURL: envOr("FNVR_DATABASE_URL", "postgres://fnvr:fnvr@postgres:5432/fnvr?sslmode=disable"),
		NATSURL:     envOr("FNVR_NATS_URL", "nats://nats:4222"),
		RedisURL:    envOr("FNVR_REDIS_URL", "redis://redis:6379/0"),
		DataDir:     envOr("FNVR_DATA_DIR", "/var/lib/fnvr"),
		MtxAPIURL:   envOr("FNVR_MTX_API_URL", ""),
	}, nil
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

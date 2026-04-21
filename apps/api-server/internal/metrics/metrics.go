// Package metrics exposes Prometheus counters + histograms for the
// api-server and a net/http middleware that records per-request
// method/route/status/duration.
//
// Route labels come from r.Pattern (Go 1.22+ servemux), which means a
// scrape of {route="/api/v1/cameras/{id}"} aggregates all camera IDs
// under one line — the usual goal for Prom scrapes. Unmatched requests
// (no pattern) are bucketed under "-".
package metrics

import (
	"bufio"
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	httpRequests = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "fnvr_http_requests_total",
			Help: "Total number of HTTP requests handled by api-server.",
		},
		[]string{"method", "route", "status"},
	)
	httpDuration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "fnvr_http_request_duration_seconds",
			Help:    "HTTP request latency from handler entry to response write.",
			Buckets: prometheus.DefBuckets,
		},
		[]string{"method", "route"},
	)
	// DBQueries is named on purpose: each caller picks a short logical
	// name ("detections.recent", "faces.recent") and a result
	// ("ok"|"err"). Keeps cardinality bounded regardless of input size.
	DBQueries = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "fnvr_db_queries_total",
			Help: "Named Postgres queries issued by api-server.",
		},
		[]string{"name", "result"},
	)
)

func init() {
	prometheus.MustRegister(httpRequests, httpDuration, DBQueries)
}

// Handler returns the /metrics endpoint.
func Handler() http.Handler { return promhttp.Handler() }

// Middleware observes every request that the wrapped handler sees. The
// route label is r.Pattern (filled in by Go's servemux once a route
// matches) — falls back to "-" for 404s so they don't blow up
// cardinality with raw paths.
func Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rw := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rw, r)
		route := r.Pattern
		if route == "" {
			route = "-"
		}
		httpRequests.WithLabelValues(r.Method, route, strconv.Itoa(rw.status)).Inc()
		httpDuration.WithLabelValues(r.Method, route).Observe(time.Since(start).Seconds())
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// Flush delegates to the underlying writer so SSE handlers (which
// type-assert http.Flusher) keep working through this middleware.
// Without this the live-detection stream — and anything else that
// streams — dies at "streaming unsupported".
func (s *statusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Hijack delegates so WebSocket / WHEP upgrade paths keep working.
func (s *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if h, ok := s.ResponseWriter.(http.Hijacker); ok {
		return h.Hijack()
	}
	return nil, nil, http.ErrNotSupported
}

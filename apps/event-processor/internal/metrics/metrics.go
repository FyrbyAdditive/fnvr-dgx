// Package metrics exposes Prometheus counters + histograms for the
// event-processor. Served on a separate internal HTTP listener (default
// :9091) so the main NATS subscriber isn't mingling protocol
// surfaces.
package metrics

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	DetectionsProcessed = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "fnvr_detections_processed_total",
			Help: "Detections consumed from NATS and evaluated by the rules engine.",
		},
		[]string{"camera_id", "kind"},
	)
	RulesEvaluated = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "fnvr_rules_evaluated_total",
			Help: "Rule evaluations. result=fire|skip|muted|noop.",
		},
		[]string{"result"},
	)
	IncidentsFired = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "fnvr_incidents_fired_total",
			Help: "Incidents written to Postgres + published on NATS.",
		},
		[]string{"severity", "rule_kind"},
	)
	ReloadDuration = prometheus.NewHistogram(
		prometheus.HistogramOpts{
			Name:    "fnvr_reload_duration_seconds",
			Help:    "Engine.reload() wall time (every 30s cycle).",
			Buckets: []float64{.01, .025, .05, .1, .25, .5, 1, 2, 5},
		},
	)
	EnrolledEmbeddings = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "fnvr_enrolled_embeddings",
			Help: "Enrolled face embeddings loaded at last reload.",
		},
	)
	FaceNegatives = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "fnvr_face_negatives",
			Help: "Dismissed-embedding negatives loaded at last reload.",
		},
	)
	RulesLoaded = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "fnvr_rules_loaded",
			Help: "Enabled rules loaded at last reload.",
		},
	)
	ObjectFlagsLoaded = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "fnvr_object_flags_loaded",
			Help: "Active object-flag suppression library size at last reload.",
		},
	)
	DetectionsSuppressed = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "fnvr_detections_suppressed_total",
			Help: "Detections dropped by the object-flag suppression library (pHash match).",
		},
		[]string{"camera_id", "class"},
	)
)

func init() {
	prometheus.MustRegister(
		DetectionsProcessed,
		RulesEvaluated,
		IncidentsFired,
		ReloadDuration,
		EnrolledEmbeddings,
		FaceNegatives,
		RulesLoaded,
		ObjectFlagsLoaded,
		DetectionsSuppressed,
	)
}

// Serve runs a tiny HTTP server that exposes /metrics at addr. Returns
// when ctx is cancelled. Failures are logged and swallowed — a broken
// scrape endpoint must never take the rules engine down with it.
func Serve(ctx context.Context, addr string) {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok\n"))
	})
	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		slog.Info("metrics listener", "addr", addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Warn("metrics listener exited", "err", err)
		}
	}()
	<-ctx.Done()
	shutCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutCtx)
}

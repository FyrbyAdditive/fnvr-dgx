package server

import (
	"net/http"

	"github.com/fnvr/fnvr/apps/api-server/internal/pipemetrics"
)

// PipelineMetricsSource is what the metrics endpoint needs from the
// pipemetrics exporter — an interface so tests can stub it without a
// NATS connection (mirrors the nil-guard pattern of pipelineStat).
type PipelineMetricsSource interface {
	Snapshot() map[string]pipemetrics.MemberMetrics
}

// handlePipelineMetrics: GET /api/v1/system/pipeline/metrics — real
// per-camera input/inference/push fps as reported by the workers every
// 15s (rows older than ~90s are pruned). The Live stats overlay
// prefers these over its SSE-derived heuristic.
func (s *Server) handlePipelineMetrics(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"cameras": s.pipeMetrics.Snapshot()})
}

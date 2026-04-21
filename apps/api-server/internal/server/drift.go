package server

import (
	"encoding/json"
	"net/http"
	"time"
)

// DriftStatus is the viewer-safe snapshot of the ml-worker drift check.
// All fields are nullable: before drift runs for the first time
// baseline + last_* are all absent; between the first run and the
// second there's a baseline but no delta yet.
type DriftStatus struct {
	Baseline    *float64   `json:"baseline"`
	LastCheckAt *time.Time `json:"last_check_at"`
	LastCurrent *float64   `json:"last_current"`
	LastDelta   *float64   `json:"last_delta"`
	LastStatus  string     `json:"last_status"`
	Threshold   float64    `json:"threshold"`
}

// handleDriftStatus returns the latest drift-check state by reading
// two settings rows written by ml-worker. No computation here — the
// worker is the single source of truth for this data.
func (s *Server) handleDriftStatus(w http.ResponseWriter, r *http.Request) {
	out := DriftStatus{Threshold: 0.05}

	if s.settings != nil {
		if raw, err := s.settings.Get(r.Context(), "ml.drift.baseline_self_match"); err == nil {
			// Distinguish a real number from JSON null (migration 0021
			// seeds the row as `null` so the column exists before
			// drift.py has ever run). Unmarshalling `null` into a
			// pointer gives nil, which is what we want.
			var v *float64
			if err := json.Unmarshal(raw, &v); err == nil {
				out.Baseline = v
			}
		}
		if raw, err := s.settings.Get(r.Context(), "ml.drift.last_run_state"); err == nil {
			// The worker writes a JSON object; we pluck the few fields
			// the UI needs. Unknown keys are ignored so drift.py can
			// evolve the shape without coupling to the server.
			var probe struct {
				At               *time.Time `json:"at"`
				CurrentSelfMatch *float64   `json:"current_self_match"`
				Delta            *float64   `json:"delta"`
				Status           string     `json:"status"`
			}
			if err := json.Unmarshal(raw, &probe); err == nil {
				out.LastCheckAt = probe.At
				out.LastCurrent = probe.CurrentSelfMatch
				out.LastDelta = probe.Delta
				out.LastStatus = probe.Status
			}
		}
	}

	writeJSON(w, http.StatusOK, out)
}

package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/fnvr/fnvr/apps/api-server/internal/calibration"
	"github.com/fnvr/fnvr/apps/api-server/internal/settings"
)

func (s *Server) handleGetDetector(w http.ResponseWriter, r *http.Request) {
	d, err := s.settings.GetDetector(r.Context())
	if err != nil {
		slog.Error("get detector settings", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, d)
}

// mergeDetector decodes a partial JSON body over the current settings,
// so fields the client omits keep their stored values. Without this,
// a client built before a field existed (or one sending a subset)
// silently resets everything it doesn't know about — that once reverted
// the fleet's inference_backend=triton to nvinfer on a UI ANPR toggle.
func mergeDetector(cur settings.Detector, body io.Reader) (settings.Detector, error) {
	d := cur
	if err := json.NewDecoder(body).Decode(&d); err != nil {
		return cur, err
	}
	return d, nil
}

func (s *Server) handleUpdateDetector(w http.ResponseWriter, r *http.Request) {
	cur, err := s.settings.GetDetector(r.Context())
	if err != nil {
		slog.Error("get detector settings", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	d, err := mergeDetector(cur, r.Body)
	if err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if err := s.settings.SetDetector(r.Context(), d); err != nil {
		// Validation errors (bad variant / precision / backend×family)
		// come through here — surface as 400 so the UI can show them.
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handlePipelineState(w http.ResponseWriter, r *http.Request) {
	st, known := s.pipelineStat.Current()
	writeJSON(w, http.StatusOK, map[string]any{
		"known": known,
		"state": st,
	})
}

// handlePipelineRestart publishes a restart signal on NATS. The pipeline
// container's supervisor is subscribed and will exec itself on receipt —
// docker compose's restart=unless-stopped brings it back up. Idempotent.
func (s *Server) handlePipelineRestart(w http.ResponseWriter, r *http.Request) {
	if err := s.natsPublish("fnvr.system.pipeline.restart", []byte(`{}`)); err != nil {
		slog.Error("publish pipeline restart", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

// calibrationJobRunning gates concurrent prepare-calibration jobs so
// two clicks don't clobber each other's tmp dir. Atomic bool keeps
// the handler lock-free.
var calibrationJobRunning atomic.Bool

// handlePrepareCalibration spawns a goroutine that samples frames
// from recent recordings into /var/lib/fnvr/models/yolo26/calib_images/,
// reporting progress via the `calibration.image_count` setting. Returns
// 202 Accepted immediately; the UI polls the /calibration endpoint.
func (s *Server) handlePrepareCalibration(w http.ResponseWriter, r *http.Request) {
	if !calibrationJobRunning.CompareAndSwap(false, true) {
		http.Error(w, "calibration job already running", http.StatusConflict)
		return
	}
	// Clear last_error so the UI doesn't show a stale error while a
	// fresh job runs; image_count resets to 0 as well so the progress
	// bar starts empty.
	if err := s.settings.SetCalibrationStatus(r.Context(), settings.CalibrationStatus{}); err != nil {
		slog.Warn("reset calibration status", "err", err)
	}
	go func() {
		defer calibrationJobRunning.Store(false)
		// Use a background context so the HTTP-request cancellation
		// doesn't kill the job. Bound it at 10 minutes so a pathologic
		// ffmpeg run can't wedge forever.
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		res, err := calibration.SampleFromRecordings(ctx, calibration.Config{
			Progress: func(written int) {
				_ = s.settings.SetCalibrationImageCount(context.Background(), written)
			},
		})
		// Read current status first so the calibration-run timestamp
		// + error write doesn't clobber the engine_size / sha256 left
		// by a prior successful trtexec run.
		cur, _ := s.settings.GetCalibrationStatus(context.Background())
		cur.ImageCount = res.Written
		if err != nil {
			slog.Error("calibration sampler", "err", err, "written", res.Written)
			cur.LastError = err.Error()
		} else {
			slog.Info("calibration sampler done", "written", res.Written, "took", res.Took)
			cur.LastError = ""
		}
		// Always stamp last_run so the UI knows the job finished,
		// even on partial runs (e.g. 477/500 — counts as done).
		now := time.Now().UTC()
		cur.LastRun = &now
		_ = s.settings.SetCalibrationStatus(context.Background(), cur)
	}()
	w.WriteHeader(http.StatusAccepted)
}

// handleGetCalibrationStatus returns the current calibration state
// for the Settings UI. Protected read — viewers can see but can't
// trigger jobs.
func (s *Server) handleGetCalibrationStatus(w http.ResponseWriter, r *http.Request) {
	c, err := s.settings.GetCalibrationStatus(r.Context())
	if err != nil {
		slog.Error("get calibration status", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

// handleInternalCalibrationReport is posted to by the pipeline
// entrypoint after a trtexec calibration run. No auth — internal
// container-to-container on the docker bridge. Writes last_run +
// last_error + engine_size + table_sha256 so the Settings UI can
// show success or surface the failure reason.
func (s *Server) handleInternalCalibrationReport(w http.ResponseWriter, r *http.Request) {
	var body struct {
		OK          bool   `json:"ok"`
		Err         string `json:"err,omitempty"`
		EngineSize  int64  `json:"engine_size,omitempty"`
		TableSHA256 string `json:"table_sha256,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	cur, err := s.settings.GetCalibrationStatus(r.Context())
	if err != nil {
		slog.Warn("calibration report: load current", "err", err)
	}
	now := time.Now().UTC()
	cur.LastRun = &now
	if body.OK {
		cur.LastError = ""
		cur.EngineSize = body.EngineSize
		cur.TableSHA256 = body.TableSHA256
	} else {
		cur.LastError = body.Err
	}
	if err := s.settings.SetCalibrationStatus(r.Context(), cur); err != nil {
		slog.Error("calibration report save", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

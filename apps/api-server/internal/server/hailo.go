package server

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"

	"github.com/fnvr/fnvr/apps/api-server/internal/camera"
)

// handleHailoStatus reports whether the Hailo-8 PCIe accelerator is
// reachable from inside this container — i.e. whether the host's
// /dev/hailo0 device node is bind-mounted in. The UI uses this to
// grey out the "Hailo-8 (PCIe)" detector-backend option when the
// device isn't available.
//
// Authenticated but not admin: viewers should know whether a feature
// is offered so they understand why a camera's backend might be
// set to "hailo" and what that means.
func (s *Server) handleHailoStatus(w http.ResponseWriter, r *http.Request) {
	present := false
	if info, err := os.Stat("/dev/hailo0"); err == nil {
		// Must be a char device — a regular file at that path would
		// be leftover from some bizarre mount attempt, still treat
		// it as "not present".
		present = info.Mode()&os.ModeCharDevice != 0
	}
	writeJSON(w, http.StatusOK, map[string]bool{"present": present})
}

// handleUpdateCameraDetectorBackend flips one camera between TRT (GPU)
// and Hailo (PCIe) for its primary-detection leg. The supervisor's
// 5 s reconcile tick picks up the change and respawns just that
// worker. Tracker + ANPR + face SGIEs stay on GPU regardless.
func (s *Server) handleUpdateCameraDetectorBackend(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Backend string `json:"backend"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	id := r.PathValue("id")
	if err := s.cameras.SetDetectorBackend(r.Context(), id, body.Backend); err != nil {
		if errors.Is(err, camera.ErrNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		// Validator message is user-actionable ("invalid detector_backend ...").
		if _, isValidationErr := err.(interface{ Error() string }); isValidationErr {
			// Catch: the DB-level CHECK also rejects bogus values with
			// "violates check constraint" — surface as 400 either way.
			slog.Warn("set detector_backend rejected", "err", err, "camera", id)
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		slog.Error("set detector_backend", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

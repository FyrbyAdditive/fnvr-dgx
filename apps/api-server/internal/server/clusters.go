package server

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/fnvr/fnvr/apps/api-server/internal/persons"
	"github.com/fnvr/fnvr/apps/api-server/internal/settings"
)

// clusterRunRunning gates concurrent on-demand cluster runs so two
// admin clicks don't both start batch jobs against the ml-worker.
var clusterRunRunning atomic.Bool

// clusterResponse is the UI's view of a face_clusters row with the
// bits needed to render a review tile.
type clusterResponse struct {
	ID                        string     `json:"id"`
	MemberCount               int        `json:"member_count"`
	RepresentativeDetectionID *int64     `json:"representative_detection_id,omitempty"`
	RepresentativeThumbnail   string     `json:"representative_thumbnail_url,omitempty"`
	Algorithm                 string     `json:"algorithm"`
	CreatedAt                 time.Time  `json:"created_at"`
	UpdatedAt                 time.Time  `json:"updated_at"`
	EnrolledPersonID          *string    `json:"enrolled_person_id,omitempty"`
	FirstSeen                 *time.Time `json:"first_seen,omitempty"`
	LastSeen                  *time.Time `json:"last_seen,omitempty"`
}

func (s *Server) handleListClusters(w http.ResponseWriter, r *http.Request) {
	unenrolled := r.URL.Query().Get("unenrolled") == "true"
	cs, err := s.persons.ListClusters(r.Context(), unenrolled)
	if err != nil {
		slog.Error("list clusters", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	out := make([]clusterResponse, 0, len(cs))
	for _, c := range cs {
		resp := clusterResponse{
			ID:                        c.ID,
			MemberCount:               c.MemberCount,
			RepresentativeDetectionID: c.RepresentativeDetectionID,
			Algorithm:                 c.Algorithm,
			CreatedAt:                 c.CreatedAt,
			UpdatedAt:                 c.UpdatedAt,
			EnrolledPersonID:          c.EnrolledPersonID,
			FirstSeen:                 c.FirstSeen,
			LastSeen:                  c.LastSeen,
		}
		if c.RepresentativeDetectionID != nil && *c.RepresentativeDetectionID > 0 {
			resp.RepresentativeThumbnail = "/api/v1/faces/thumbnail/" +
				strconv.FormatInt(*c.RepresentativeDetectionID, 10) + ".jpg"
		}
		out = append(out, resp)
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleListClusterMembers(w http.ResponseWriter, r *http.Request) {
	ms, err := s.persons.ListClusterMembers(r.Context(), r.PathValue("id"))
	if err != nil {
		slog.Error("list cluster members", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	// Shape each member with a thumbnail URL so the UI can render
	// without a separate fetch per row.
	out := make([]map[string]any, 0, len(ms))
	for _, m := range ms {
		out = append(out, map[string]any{
			"cluster_id":             m.ClusterID,
			"detection_id":           m.DetectionID,
			"similarity_to_centroid": m.SimilarityToCentroid,
			"added_at":               m.AddedAt,
			"thumbnail_url": "/api/v1/faces/thumbnail/" +
				strconv.FormatInt(m.DetectionID, 10) + ".jpg",
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// handleClusterRunNow asks the ml-worker to do a fresh batch
// HDBSCAN pass over the last week of unmatched face detections.
// Runs in a goroutine; status lands in settings.ml.cluster.*.
// Returns 202 Accepted immediately so the UI can poll the status
// endpoint without holding a request open for minutes.
func (s *Server) handleClusterRunNow(w http.ResponseWriter, r *http.Request) {
	if s.mlWorker == nil {
		http.Error(w, "ml-worker not configured", http.StatusServiceUnavailable)
		return
	}
	if !clusterRunRunning.CompareAndSwap(false, true) {
		http.Error(w, "cluster run already in progress", http.StatusConflict)
		return
	}
	// Reset last_error / last_run_state so the UI shows progress
	// starting from a clean slate.
	_ = s.settings.Set(r.Context(), "ml.cluster.last_run_error", []byte("null"))
	_ = s.settings.Set(r.Context(), "ml.cluster.last_run_state", mustJSON(map[string]any{
		"state": "running",
		"at":    time.Now().UTC().Format(time.RFC3339Nano),
	}))

	go func() {
		defer clusterRunRunning.Store(false)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		report, err := s.mlWorker.BatchCluster(ctx)
		if err != nil {
			slog.Error("cluster run-now", "err", err)
			_ = s.settings.Set(context.Background(), "ml.cluster.last_run_state",
				mustJSON(map[string]any{
					"state": "error",
					"at":    time.Now().UTC().Format(time.RFC3339Nano),
				}))
			_ = s.settings.Set(context.Background(), "ml.cluster.last_run_error",
				mustJSON(err.Error()))
			return
		}
		// Fold the worker's report straight into the settings row
		// so the UI sees {state, candidates_scanned, clusters_written, ...}.
		payload := map[string]any{
			"state": "ok",
			"at":    time.Now().UTC().Format(time.RFC3339Nano),
		}
		for k, v := range report {
			payload[k] = v
		}
		_ = s.settings.Set(context.Background(),
			"ml.cluster.last_run_state", mustJSON(payload))
	}()
	w.WriteHeader(http.StatusAccepted)
}

// handleGetClusterStatus returns the current value of
// ml.cluster.last_run_state — the UI polls this to show progress.
// Viewers are allowed to read it (gated via the protected mux).
func (s *Server) handleGetClusterStatus(w http.ResponseWriter, r *http.Request) {
	var state json.RawMessage
	raw, err := s.settings.Get(r.Context(), "ml.cluster.last_run_state")
	if err != nil && !errors.Is(err, settings.ErrNotFound) {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if raw != nil {
		state = raw
	} else {
		state = []byte("null")
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"last_run_state": state,
	})
}

// handleEnrolCluster copies every cluster member's embedding into
// face_embeddings for the chosen person. Body: `{person_id}` OR
// `{new_label}`. Marks the cluster enrolled so it drops out of the
// review grid on the next fetch.
func (s *Server) handleEnrolCluster(w http.ResponseWriter, r *http.Request) {
	clusterID := r.PathValue("id")
	var body struct {
		PersonID string `json:"person_id"`
		NewLabel string `json:"new_label"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if body.PersonID == "" && body.NewLabel == "" {
		http.Error(w, "person_id or new_label required", http.StatusBadRequest)
		return
	}
	personID := body.PersonID
	if personID == "" {
		created, err := s.persons.Create(r.Context(), persons.Person{
			Label:   body.NewLabel,
			Enabled: true,
		})
		if errors.Is(err, persons.ErrLabelTaken) {
			http.Error(w, "label already in use", http.StatusConflict)
			return
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		personID = created.ID
	}
	n, skipped, lowq, err := s.persons.AssignClusterToPerson(r.Context(), clusterID, personID)
	if err != nil {
		slog.Error("enrol cluster", "err", err, "cluster_id", clusterID)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"added":                   n,
		"skipped_near_duplicates": skipped,
		"skipped_low_quality":     lowq,
		"person_id":               personID,
		"retro_matched":           s.runRetroMatch(r.Context()),
	})
}

// handleDeleteCluster drops the cluster (cascade deletes members).
// Doesn't touch face_embeddings — if the cluster was already
// enrolled its embeddings live on under the person's row.
func (s *Server) handleDeleteCluster(w http.ResponseWriter, r *http.Request) {
	if err := s.persons.DeleteCluster(r.Context(), r.PathValue("id")); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleDismissClusterAsNotAFace is the "dismiss + train" variant:
// every member embedding lands in face_dismissals with
// reason='not_a_face' before the cluster goes away, so HDBSCAN's
// next pass finds the same false-positive group already penalised
// at match time.
func (s *Server) handleDismissClusterAsNotAFace(w http.ResponseWriter, r *http.Request) {
	n, err := s.persons.DismissClusterAsNotAFace(r.Context(), r.PathValue("id"))
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"dismissed": n})
}

// mustJSON is a tiny helper used by the cluster-status writer;
// the values are always serialisable (map[string]any with
// strings/ints), so the error path is unreachable in practice.
func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

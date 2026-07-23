package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/fnvr/fnvr/apps/api-server/internal/auth"
	"github.com/fnvr/fnvr/apps/api-server/internal/camera"
	"github.com/fnvr/fnvr/apps/api-server/internal/classes"
	"github.com/fnvr/fnvr/apps/api-server/internal/config"
	"github.com/fnvr/fnvr/apps/api-server/internal/detections"
	"github.com/fnvr/fnvr/apps/api-server/internal/events"
	"github.com/fnvr/fnvr/apps/api-server/internal/flags"
	"github.com/fnvr/fnvr/apps/api-server/internal/metrics"
	"github.com/fnvr/fnvr/apps/api-server/internal/mlworker"
	"github.com/fnvr/fnvr/apps/api-server/internal/mtxproxy"
	"github.com/fnvr/fnvr/apps/api-server/internal/notifications"
	"github.com/fnvr/fnvr/apps/api-server/internal/persons"
	"github.com/fnvr/fnvr/apps/api-server/internal/pipeline"
	"github.com/fnvr/fnvr/apps/api-server/internal/plates"
	"github.com/fnvr/fnvr/apps/api-server/internal/rules"
	"github.com/fnvr/fnvr/apps/api-server/internal/segments"
	"github.com/fnvr/fnvr/apps/api-server/internal/settings"
	"github.com/fnvr/fnvr/apps/api-server/internal/snapshot"
	"github.com/fnvr/fnvr/apps/api-server/internal/system"
)

type Server struct {
	cfg      *config.Config
	pool     *pgxpool.Pool
	auth     *auth.Store
	cameras  *camera.Store
	pipeline pipeline.Client
	events   *events.Bus
	rules     *rules.Store
	snaps     *snapshot.Service
	segments  *segments.Store
	camStates    *camera.StateTracker
	notifs       *notifications.Store
	settings     *settings.Store
	pipelineStat *pipeline.StateTracker
	pipeMetrics  PipelineMetricsSource
	natsPublish  func(subject string, data []byte) error
	// mtxReconcile is called after any mutation that could change the
	// desired MediaMTX proxy-path set (mtx_proxy toggle, url change on a
	// proxied camera, etc.). nil on deployments where MediaMTX isn't in
	// the stack — handlers skip the hook.
	mtxReconcile func(ctx context.Context)
	detections   *detections.Store
	plates       *plates.Store
	persons      *persons.Store
	flags        *flags.Store
	classes      *classes.Store
	mlWorker     *mlworker.Client
}

type Deps struct {
	Config        *config.Config
	Pool          *pgxpool.Pool
	Auth          *auth.Store
	Cameras       *camera.Store
	Pipeline      pipeline.Client
	Events        *events.Bus
	Rules         *rules.Store
	Snapshots     *snapshot.Service
	Segments      *segments.Store
	CamStates     *camera.StateTracker
	Notifications *notifications.Store
	Settings      *settings.Store
	PipelineStat  *pipeline.StateTracker
	PipeMetrics   PipelineMetricsSource
	NatsPublish   func(subject string, data []byte) error
	MtxReconcile  func(ctx context.Context)
	Detections    *detections.Store
	Plates        *plates.Store
	Persons       *persons.Store
	Flags         *flags.Store
	Classes       *classes.Store
	MLWorker      *mlworker.Client
}

func New(d Deps) *Server {
	return &Server{
		cfg:       d.Config,
		pool:      d.Pool,
		auth:      d.Auth,
		cameras:   d.Cameras,
		pipeline:  d.Pipeline,
		events:    d.Events,
		rules:     d.Rules,
		snaps:     d.Snapshots,
		segments:  d.Segments,
		camStates:    d.CamStates,
		notifs:       d.Notifications,
		settings:     d.Settings,
		pipelineStat: d.PipelineStat,
		pipeMetrics:  d.PipeMetrics,
		natsPublish:  d.NatsPublish,
		mtxReconcile: d.MtxReconcile,
		detections:   d.Detections,
		plates:       d.Plates,
		persons:      d.Persons,
		flags:        d.Flags,
		classes:      d.Classes,
		mlWorker:     d.MLWorker,
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// Public routes.
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.HandleFunc("GET /api/v1/system/info", s.handleSystemInfo)
	// Prometheus scrape endpoint — unauthenticated so scrapers don't
	// need cookies. Scoped to the internal bridge by compose; gate on
	// bind address for a future hosted deploy.
	mux.Handle("GET /metrics", metrics.Handler())
	// Internal, unauthenticated endpoints for the pipeline container's
	// entrypoint. Read-only; safe because the docker bridge isolates
	// them. In a multi-tenant hosted deploy these would need IP gating.
	if s.settings != nil {
		mux.HandleFunc("GET /api/v1/internal/detector", s.handleGetDetector)
		// Pipeline entrypoint POSTs {ok, engine_size, table_sha256,
		// err} here after each trtexec calibration attempt.
		mux.HandleFunc("POST /api/v1/internal/detector/calibration_report", s.handleInternalCalibrationReport)
	}
	if s.cameras != nil {
		mux.HandleFunc("GET /api/v1/internal/cameras", s.handleInternalListCameras)
	}
	if s.classes != nil {
		// Pipeline entrypoint reads this to render num-detected-classes
		// in the nvinfer config when running a custom (fnvr-vN) model.
		// Auth-free because the docker bridge isolates it.
		mux.HandleFunc("GET /api/v1/internal/classes", s.handleListClasses)
	}
	if s.auth != nil {
		mux.HandleFunc("POST /api/v1/auth/login", s.handleLogin)
	}

	// Protected routes. We only wire these when the auth store is present so
	// tests can spin up a minimal server with a nil pool.
	if s.auth != nil {
		protected := http.NewServeMux()
		protected.HandleFunc("POST /api/v1/auth/logout", s.handleLogout)
		protected.HandleFunc("GET /api/v1/me", s.handleMe)

		protected.HandleFunc("GET /api/v1/system/local-devices", s.handleLocalDevices)
		protected.HandleFunc("GET /api/v1/system/storage", s.handleSystemStorage)

		// Reads — allowed for any authenticated user (admin or viewer).
		// Writes — wrapped in auth.AdminFunc so viewers get 403.
		protected.HandleFunc("GET /api/v1/cameras", s.handleListCameras)
		protected.Handle("POST /api/v1/cameras", auth.AdminFunc(s.handleCreateCamera))
		protected.HandleFunc("GET /api/v1/cameras/{id}", s.handleGetCamera)
		protected.Handle("DELETE /api/v1/cameras/{id}", auth.AdminFunc(s.handleDeleteCamera))
		protected.Handle("PATCH /api/v1/cameras/{id}", auth.AdminFunc(s.handleUpdateCameraBasics))
		protected.Handle("PATCH /api/v1/cameras/{id}/detectors", auth.AdminFunc(s.handleUpdateCameraDetectors))
		protected.Handle("PATCH /api/v1/cameras/{id}/classes", auth.AdminFunc(s.handleUpdateCameraClasses))
		protected.Handle("PATCH /api/v1/cameras/{id}/storage", auth.AdminFunc(s.handleUpdateCameraStorage))
		protected.Handle("POST /api/v1/cameras/{id}/enable", auth.AdminFunc(s.handleEnableCamera))
		protected.Handle("POST /api/v1/cameras/{id}/disable", auth.AdminFunc(s.handleDisableCamera))
		protected.Handle("PATCH /api/v1/cameras/{id}/rotation", auth.AdminFunc(s.handleUpdateCameraRotation))
		protected.Handle("PATCH /api/v1/cameras/{id}/mtx_proxy", auth.AdminFunc(s.handleUpdateCameraMtxProxy))
		protected.Handle("PATCH /api/v1/cameras/{id}/mtx_tls_ignore", auth.AdminFunc(s.handleUpdateCameraMtxTLSIgnore))
		if s.snaps != nil {
			protected.HandleFunc("GET /api/v1/cameras/{id}/snapshot.jpg", s.handleSnapshot)
		}
		if s.rules != nil {
			protected.HandleFunc("GET /api/v1/zones", s.handleListZones)
			protected.Handle("POST /api/v1/zones", auth.AdminFunc(s.handleCreateZone))
			protected.Handle("DELETE /api/v1/zones/{id}", auth.AdminFunc(s.handleDeleteZone))
			protected.Handle("PATCH /api/v1/zones/{id}/exclusions", auth.AdminFunc(s.handleUpdateZoneExclusions))

			protected.HandleFunc("GET /api/v1/rules", s.handleListRules)
			protected.Handle("POST /api/v1/rules", auth.AdminFunc(s.handleCreateRule))
			protected.Handle("DELETE /api/v1/rules/{id}", auth.AdminFunc(s.handleDeleteRule))
			protected.Handle("PATCH /api/v1/rules/{id}", auth.AdminFunc(s.handleUpdateRule))
			protected.Handle("POST /api/v1/rules/{id}/enable", auth.AdminFunc(s.handleEnableRule))
			protected.Handle("POST /api/v1/rules/{id}/disable", auth.AdminFunc(s.handleDisableRule))

			protected.HandleFunc("GET /api/v1/incidents", s.handleListIncidents)
			protected.Handle("POST /api/v1/incidents/{id}/ack", auth.AdminFunc(s.handleAckIncident))
			protected.Handle("DELETE /api/v1/incidents/{id}", auth.AdminFunc(s.handleDeleteIncident))
		}

		if s.events != nil {
			protected.HandleFunc("GET /api/v1/events/stream", s.events.SSEHandler)
		}

		if s.segments != nil {
			protected.HandleFunc("GET /api/v1/segments", s.handleListSegments)
			protected.HandleFunc("GET /api/v1/segments/{id}/file", s.handleSegmentFile)
			protected.HandleFunc("GET /api/v1/detections", s.handleListDetections)
			protected.HandleFunc("GET /api/v1/detections/summary", s.handleDetectionSummary)
		}

		if s.plates != nil {
			// Hotlist CRUD is admin-only; the list + recent views are
			// readable by viewers so a read-only observer can still
			// search plates and see the hotlist.
			protected.HandleFunc("GET /api/v1/plate_hotlist", s.handleListHotlist)
			protected.Handle("POST /api/v1/plate_hotlist", auth.AdminFunc(s.handleCreateHotlist))
			protected.Handle("PATCH /api/v1/plate_hotlist/{id}", auth.AdminFunc(s.handleUpdateHotlist))
			protected.Handle("DELETE /api/v1/plate_hotlist/{id}", auth.AdminFunc(s.handleDeleteHotlist))
			protected.HandleFunc("GET /api/v1/plates/recent", s.handleRecentPlates)
		}

		if s.persons != nil {
			// Reads viewable by any authenticated user; writes admin-only.
			protected.HandleFunc("GET /api/v1/persons", s.handleListPersons)
			protected.Handle("POST /api/v1/persons", auth.AdminFunc(s.handleCreatePerson))
			protected.Handle("PATCH /api/v1/persons/{id}", auth.AdminFunc(s.handleUpdatePerson))
			protected.Handle("DELETE /api/v1/persons/{id}", auth.AdminFunc(s.handleDeletePerson))
			protected.HandleFunc("GET /api/v1/persons/{id}/matches", s.handlePersonMatches)
			protected.HandleFunc("GET /api/v1/persons/{id}/embeddings", s.handleListPersonEmbeddings)
			protected.Handle("POST /api/v1/persons/{id}/embeddings", auth.AdminFunc(s.handleAddPersonEmbedding))
			protected.Handle("POST /api/v1/persons/{id}/embeddings_bulk", auth.AdminFunc(s.handleAddPersonEmbeddingsBulk))
			protected.Handle("DELETE /api/v1/persons/{id}/embeddings/{embedding_id}", auth.AdminFunc(s.handleDeletePersonEmbedding))
			protected.Handle("POST /api/v1/persons/{id}/embeddings/delete_bulk", auth.AdminFunc(s.handleBulkDeletePersonEmbeddings))
			protected.HandleFunc("GET /api/v1/faces/recent", s.handleRecentFaces)
			protected.HandleFunc("GET /api/v1/faces/thumbnail/{detection_id}", s.handleFaceThumbnail)
			protected.Handle("POST /api/v1/faces/dismiss", auth.AdminFunc(s.handleDismissFaces))
			// Photo-upload enrolment + unknown-face clustering +
			// cluster review surface. All admin-gated except the
			// list + status reads.
			protected.Handle("POST /api/v1/persons/upload_enrol", auth.AdminFunc(s.handleUploadEnrol))
			protected.HandleFunc("GET /api/v1/clusters", s.handleListClusters)
			protected.HandleFunc("GET /api/v1/clusters/status", s.handleGetClusterStatus)
			protected.HandleFunc("GET /api/v1/clusters/{id}/members", s.handleListClusterMembers)
			protected.Handle("POST /api/v1/clusters/run_now", auth.AdminFunc(s.handleClusterRunNow))
			protected.Handle("POST /api/v1/clusters/{id}/enrol", auth.AdminFunc(s.handleEnrolCluster))
			protected.Handle("DELETE /api/v1/clusters/{id}", auth.AdminFunc(s.handleDeleteCluster))
			protected.Handle("POST /api/v1/clusters/{id}/dismiss_not_a_face", auth.AdminFunc(s.handleDismissClusterAsNotAFace))

			// Object-flag surface. Create + dismiss are admin-only
			// (they drive real-time suppression); list + stats +
			// thumbnail are viewer-safe.
			protected.Handle("POST /api/v1/detections/{id}/flag", auth.AdminFunc(s.handleFlagDetection))
			protected.Handle("POST /api/v1/flags/manual", auth.AdminFunc(s.handleManualFlag))
			protected.HandleFunc("GET /api/v1/object-flags", s.handleListFlags)
			protected.HandleFunc("GET /api/v1/object-flags/stats", s.handleFlagStats)
			protected.Handle("DELETE /api/v1/object-flags/{id}", auth.AdminFunc(s.handleDismissFlag))
			protected.HandleFunc("GET /api/v1/object-thumbnail/{id}", s.handleObjectThumbnail)
			protected.HandleFunc("GET /api/v1/ml/drift/status", s.handleDriftStatus)
		}

		// Detection class taxonomy. Reads viewable by anyone authenticated
		// (Live tab pulls the enabled list to populate relabel dropdowns);
		// writes admin-only — they reshape what the dataset.yaml + future
		// fine-tuned model will recognise.
		if s.classes != nil {
			protected.HandleFunc("GET /api/v1/admin/classes", s.handleListClasses)
			protected.Handle("POST /api/v1/admin/classes", auth.AdminFunc(s.handleCreateClass))
			protected.Handle("POST /api/v1/admin/classes/bulk_enable", auth.AdminFunc(s.handleBulkEnableClasses))
			protected.Handle("PATCH /api/v1/admin/classes/{id}", auth.AdminFunc(s.handlePatchClass))
			protected.Handle("DELETE /api/v1/admin/classes/{id}", auth.AdminFunc(s.handleDeleteClass))
		}

		if s.notifs != nil {
			protected.HandleFunc("GET /api/v1/notifications/channels", s.handleListChannels)
			protected.Handle("POST /api/v1/notifications/channels", auth.AdminFunc(s.handleCreateChannel))
			protected.Handle("DELETE /api/v1/notifications/channels/{id}", auth.AdminFunc(s.handleDeleteChannel))
			protected.Handle("POST /api/v1/notifications/channels/{id}/enable", auth.AdminFunc(s.handleEnableChannel))
			protected.Handle("POST /api/v1/notifications/channels/{id}/disable", auth.AdminFunc(s.handleDisableChannel))

			protected.HandleFunc("GET /api/v1/notifications/subscriptions", s.handleListSubscriptions)
			protected.Handle("POST /api/v1/notifications/subscriptions", auth.AdminFunc(s.handleCreateSubscription))
			protected.Handle("DELETE /api/v1/notifications/subscriptions/{id}", auth.AdminFunc(s.handleDeleteSubscription))

			protected.HandleFunc("GET /api/v1/notifications/deliveries", s.handleRecentDeliveries)
		}

		if s.settings != nil {
			protected.HandleFunc("GET /api/v1/settings/detector", s.handleGetDetector)
			protected.Handle("PUT /api/v1/settings/detector", auth.AdminFunc(s.handleUpdateDetector))
			// yolo26 INT8 calibration workflow. Read is viewer-safe; the
			// sampler trigger is admin-only.
			protected.HandleFunc("GET /api/v1/settings/detector/calibration", s.handleGetCalibrationStatus)
			protected.Handle("POST /api/v1/settings/detector/prepare_calibration", auth.AdminFunc(s.handlePrepareCalibration))
			protected.HandleFunc("GET /api/v1/settings/class_mutes", s.handleGetClassMutes)
			protected.Handle("PUT /api/v1/settings/class_mutes", auth.AdminFunc(s.handleUpdateClassMutes))
			protected.HandleFunc("GET /api/v1/settings/ha", s.handleGetHAConfig)
			protected.Handle("PUT /api/v1/settings/ha", auth.AdminFunc(s.handleUpdateHAConfig))
			protected.HandleFunc("GET /api/v1/settings/alarm", s.handleGetAlarm)
			protected.Handle("PUT /api/v1/settings/alarm", auth.AdminFunc(s.handleUpdateAlarm))
			protected.HandleFunc("GET /api/v1/settings/pipeline_startup_grace", s.handleGetPipelineStartupGrace)
			protected.Handle("PUT /api/v1/settings/pipeline_startup_grace", auth.AdminFunc(s.handleUpdatePipelineStartupGrace))
			protected.HandleFunc("GET /api/v1/settings/advanced", s.handleGetAdvancedSettings)
			protected.Handle("PUT /api/v1/settings/advanced", auth.AdminFunc(s.handleUpdateAdvancedSettings))
		}
		if s.pipelineStat != nil {
			protected.HandleFunc("GET /api/v1/system/pipeline/state", s.handlePipelineState)
		}
		if s.pipeMetrics != nil {
			protected.HandleFunc("GET /api/v1/system/pipeline/metrics", s.handlePipelineMetrics)
		}
		if s.natsPublish != nil {
			protected.Handle("POST /api/v1/system/pipeline/restart", auth.AdminFunc(s.handlePipelineRestart))
		}

		// User + API-token management — admin-only end to end.
		protected.Handle("GET /api/v1/users", auth.AdminFunc(s.handleListUsers))
		protected.Handle("POST /api/v1/users", auth.AdminFunc(s.handleCreateUser))
		protected.Handle("PATCH /api/v1/users/{id}", auth.AdminFunc(s.handleUpdateUser))
		protected.Handle("DELETE /api/v1/users/{id}", auth.AdminFunc(s.handleDeleteUser))
		protected.Handle("GET /api/v1/users/{id}/tokens", auth.AdminFunc(s.handleListTokens))
		protected.Handle("POST /api/v1/users/{id}/tokens", auth.AdminFunc(s.handleCreateToken))
		protected.Handle("DELETE /api/v1/users/{id}/tokens/{token_id}", auth.AdminFunc(s.handleRevokeToken))

		guarded := s.auth.Middleware(protected)
		mux.Handle("/api/v1/auth/logout", guarded)
		mux.Handle("/api/v1/me", guarded)
		mux.Handle("/api/v1/system/local-devices", guarded)
		mux.Handle("/api/v1/system/storage", guarded)
		mux.Handle("/api/v1/cameras", guarded)
		mux.Handle("/api/v1/cameras/", guarded)
		if s.rules != nil {
			mux.Handle("/api/v1/zones", guarded)
			mux.Handle("/api/v1/zones/", guarded)
			mux.Handle("/api/v1/rules", guarded)
			mux.Handle("/api/v1/rules/", guarded)
			mux.Handle("/api/v1/incidents", guarded)
			mux.Handle("/api/v1/incidents/", guarded)
		}
		if s.events != nil {
			mux.Handle("/api/v1/events/stream", guarded)
		}
		if s.segments != nil {
			mux.Handle("/api/v1/segments", guarded)
			mux.Handle("/api/v1/segments/", guarded)
			mux.Handle("/api/v1/detections", guarded)
			// Exact pattern only — the flags block below registers the
			// "/api/v1/detections/" prefix; duplicating it here would
			// panic at startup (and this route must stay reachable when
			// flags is nil).
			mux.Handle("/api/v1/detections/summary", guarded)
		}
		if s.plates != nil {
			mux.Handle("/api/v1/plate_hotlist", guarded)
			mux.Handle("/api/v1/plate_hotlist/", guarded)
			mux.Handle("/api/v1/plates/recent", guarded)
		}
		if s.persons != nil {
			mux.Handle("/api/v1/persons", guarded)
			mux.Handle("/api/v1/persons/", guarded)
			mux.Handle("/api/v1/faces/recent", guarded)
			mux.Handle("/api/v1/faces/thumbnail/", guarded)
			mux.Handle("/api/v1/faces/dismiss", guarded)
			mux.Handle("/api/v1/clusters", guarded)
			mux.Handle("/api/v1/clusters/", guarded)
			mux.Handle("/api/v1/ml/drift/status", guarded)
		}
		if s.flags != nil {
			mux.Handle("/api/v1/detections/", guarded)   // catches .../flag
			mux.Handle("/api/v1/flags/manual", guarded)
			mux.Handle("/api/v1/object-flags", guarded)
			mux.Handle("/api/v1/object-flags/", guarded)
			mux.Handle("/api/v1/object-thumbnail/", guarded)
		}
		if s.classes != nil {
			mux.Handle("/api/v1/admin/classes", guarded)
			mux.Handle("/api/v1/admin/classes/", guarded)
		}
		if s.notifs != nil {
			mux.Handle("/api/v1/notifications/channels", guarded)
			mux.Handle("/api/v1/notifications/channels/", guarded)
			mux.Handle("/api/v1/notifications/subscriptions", guarded)
			mux.Handle("/api/v1/notifications/subscriptions/", guarded)
			mux.Handle("/api/v1/notifications/deliveries", guarded)
		}
		if s.settings != nil {
			mux.Handle("/api/v1/settings/detector", guarded)
			mux.Handle("/api/v1/settings/detector/", guarded)
			mux.Handle("/api/v1/settings/class_mutes", guarded)
			mux.Handle("/api/v1/settings/ha", guarded)
			mux.Handle("/api/v1/settings/alarm", guarded)
			mux.Handle("/api/v1/settings/pipeline_startup_grace", guarded)
			mux.Handle("/api/v1/settings/advanced", guarded)
		}
		if s.pipelineStat != nil {
			mux.Handle("/api/v1/system/pipeline/state", guarded)
		}
		if s.pipeMetrics != nil {
			mux.Handle("/api/v1/system/pipeline/metrics", guarded)
		}
		if s.natsPublish != nil {
			mux.Handle("/api/v1/system/pipeline/restart", guarded)
		}
		mux.Handle("/api/v1/users", guarded)
		mux.Handle("/api/v1/users/", guarded)
	}

	return loggingMiddleware(corsMiddleware(metrics.Middleware(mux)))
}

// --- handlers ---

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if s.pool != nil {
		if err := s.pool.Ping(r.Context()); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "db-down"})
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleSystemInfo(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"version":   "dev",
		"milestone": "M3",
		"time":      time.Now().UTC(),
	})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	sess, err := s.auth.Login(r.Context(), req.Username, req.Password)
	if errors.Is(err, auth.ErrInvalidCredentials) {
		http.Error(w, "invalid credentials", http.StatusUnauthorized)
		return
	}
	if err != nil {
		slog.Error("login", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     "fnvr_session",
		Value:    sess.Token,
		Path:     "/",
		HttpOnly: true,
		Secure:   true, // served only behind nginx TLS
		SameSite: http.SameSiteLaxMode,
		Expires:  sess.ExpiresAt,
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"token":      sess.Token,
		"username":   sess.Username,
		"role":       sess.Role,
		"expires_at": sess.ExpiresAt,
	})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if sess, ok := auth.SessionFrom(r.Context()); ok {
		s.auth.Logout(sess.Token)
	}
	http.SetCookie(w, &http.Cookie{Name: "fnvr_session", Value: "", Path: "/", MaxAge: -1})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	sess, ok := auth.SessionFrom(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user_id":  sess.UserID,
		"username": sess.Username,
		"role":     sess.Role,
		"is_admin": auth.IsAdmin(sess),
		"api_only": sess.APIOnly,
	})
}

// handleInternalListCameras returns a minimal {id, name} list for
// internal container-to-container lookups (e.g. pipeline entrypoint
// publishing per-camera "starting" states). No auth; no extra fields.
func (s *Server) handleInternalListCameras(w http.ResponseWriter, r *http.Request) {
	cams, err := s.cameras.List(r.Context())
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	out := make([]map[string]string, 0, len(cams))
	for _, c := range cams {
		out = append(out, map[string]string{"id": c.ID, "name": c.Name})
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleListCameras(w http.ResponseWriter, r *http.Request) {
	cams, err := s.cameras.List(r.Context())
	if err != nil {
		slog.Error("list cameras", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, decorateCameras(cams, s.camStates))
}

// decorateCameras attaches the latest-known pipeline state to each camera
// ("starting" | "running" | "failed" | "unknown"). This is derived from
// NATS so it reflects current reality rather than the DB row.
//
// Also carries `last_heartbeat_at` (nil if the tracker has never heard
// from the camera) so the UI can distinguish "never reported" from
// "heartbeat went stale X minutes ago" — the latter is the diagnostic
// we kept missing.
func decorateCameras(cams []camera.Camera, states *camera.StateTracker) []map[string]any {
	out := make([]map[string]any, 0, len(cams))
	for _, c := range cams {
		state := "unknown"
		var lastHeartbeat *time.Time
		if states != nil {
			if st, ok := states.State(c.ID); ok {
				state = st
			}
			if _, stamped, known := states.StateDetail(c.ID); known {
				t := stamped
				lastHeartbeat = &t
			}
		}
		out = append(out, map[string]any{
			"id":                       c.ID,
			"name":                     c.Name,
			"url":                      c.URL,
			"substream":                c.Substream,
			"record_mode":              c.RecordMode,
			"enabled":                  c.Enabled,
			"retention_days":           c.RetentionDays,
			"quota_gb":                 c.QuotaGB,
			"group_id":                 c.GroupID,
			"enabled_detectors":        c.EnabledDetectors,
			"location_kind":            c.LocationKind,
			"mute_classes_override":    c.MuteClassesOverride,
			"unmute_classes_override":  c.UnmuteClassesOverride,
			"rotation":                 c.Rotation,
			"mtx_proxy":                c.MtxProxy,
			"mtx_tls_fingerprint":      c.MtxTLSFingerprint,
			"created_at":               c.CreatedAt,
			"updated_at":               c.UpdatedAt,
			"state":                    state,
			"last_heartbeat_at":        lastHeartbeat,
		})
	}
	return out
}

func (s *Server) handleCreateCamera(w http.ResponseWriter, r *http.Request) {
	var c camera.Camera
	if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if c.Name == "" || c.URL == "" {
		http.Error(w, "name and url required", http.StatusBadRequest)
		return
	}

	created, err := s.cameras.Create(r.Context(), c)
	if err != nil {
		slog.Error("create camera", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	// Best-effort announce to pipeline. If it fails we keep the DB row —
	// pipeline-supervisor reconciles from the DB on reconnect.
	addCtx, cancel := ctxWithTimeout(r.Context())
	defer cancel()
	if _, err := s.pipeline.AddCamera(addCtx, pipeline.AddCameraArgs{
		ID:            created.ID,
		URL:           created.URL,
		SubstreamURL:  created.Substream,
		RecordingMode: created.RecordMode,
	}); err != nil {
		slog.Warn("pipeline.AddCamera failed", "id", created.ID, "err", err)
	}
	writeJSON(w, http.StatusCreated, created)
}

func (s *Server) handleGetCamera(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	c, err := s.cameras.Get(r.Context(), id)
	if errors.Is(err, camera.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (s *Server) handleDeleteCamera(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := s.cameras.Delete(r.Context(), id); errors.Is(err, camera.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	} else if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	rmCtx, cancel := ctxWithTimeout(r.Context())
	defer cancel()
	if _, err := s.pipeline.RemoveCamera(rmCtx, id); err != nil {
		slog.Warn("pipeline.RemoveCamera failed", "id", id, "err", err)
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleUpdateCameraBasics(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name      *string `json:"name,omitempty"`
		URL       *string `json:"url,omitempty"`
		Substream *string `json:"substream,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	id := r.PathValue("id")
	err := s.cameras.UpdateBasics(r.Context(), id, body.Name, body.URL, body.Substream)
	if errors.Is(err, camera.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		// Validation errors are user-actionable, so surface the message.
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleUpdateCameraDetectors(w http.ResponseWriter, r *http.Request) {
	var body struct {
		EnabledDetectors []string `json:"enabled_detectors"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	id := r.PathValue("id")
	err := s.cameras.SetEnabledDetectors(r.Context(), id, body.EnabledDetectors)
	if errors.Is(err, camera.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		slog.Error("update camera detectors", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleUpdateCameraRotation(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Rotation int `json:"rotation"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	id := r.PathValue("id")
	err := s.cameras.SetRotation(r.Context(), id, body.Rotation)
	if errors.Is(err, camera.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		// Validator rejects anything outside {0,90,180,270}.
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleUpdateCameraMtxProxy(w http.ResponseWriter, r *http.Request) {
	var body struct {
		MtxProxy bool `json:"mtx_proxy"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	id := r.PathValue("id")
	if err := s.cameras.SetMtxProxy(r.Context(), id, body.MtxProxy); err != nil {
		if errors.Is(err, camera.ErrNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		slog.Error("set mtx_proxy", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	// Kick the MediaMTX reconciler so the change takes effect live. Best-
	// effort — a failure here doesn't fail the request; reconciler also
	// runs periodically (and on next api-server start).
	if s.mtxReconcile != nil {
		go s.mtxReconcile(context.Background())
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleUpdateCameraMtxTLSIgnore flips the "ignore TLS certificate"
// affordance for a MediaMTX-proxied camera. When ignore=true we probe
// the upstream URL over TLS, grab the cert's SHA256 fingerprint, and
// store it so MediaMTX pins trust to that specific cert (which is
// equivalent to "don't CA-validate" but safer — a MITM would have to
// present the exact same cert). When ignore=false we clear the
// fingerprint and fall back to standard TLS verification.
func (s *Server) handleUpdateCameraMtxTLSIgnore(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Ignore bool `json:"ignore"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	id := r.PathValue("id")
	cam, err := s.cameras.Get(r.Context(), id)
	if errors.Is(err, camera.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		slog.Error("get camera for tls ignore", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	fingerprint := ""
	if body.Ignore {
		fp, err := mtxproxy.ProbeFingerprint(r.Context(), cam.URL)
		if err != nil {
			http.Error(w, "probe cert: "+err.Error(), http.StatusBadGateway)
			return
		}
		fingerprint = fp
	}
	if err := s.cameras.SetMtxTLSFingerprint(r.Context(), id, fingerprint); err != nil {
		slog.Error("set mtx_tls_fingerprint", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if s.mtxReconcile != nil {
		go s.mtxReconcile(context.Background())
	}
	writeJSON(w, http.StatusOK, map[string]string{"mtx_tls_fingerprint": fingerprint})
}

func (s *Server) handleEnableCamera(w http.ResponseWriter, r *http.Request) {
	s.setCameraEnabled(w, r, true)
}
func (s *Server) handleDisableCamera(w http.ResponseWriter, r *http.Request) {
	s.setCameraEnabled(w, r, false)
}
func (s *Server) setCameraEnabled(w http.ResponseWriter, r *http.Request, enabled bool) {
	id := r.PathValue("id")
	err := s.cameras.SetEnabled(r.Context(), id, enabled)
	if errors.Is(err, camera.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		slog.Error("set camera enabled", "err", err, "camera_id", id, "enabled", enabled)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleUpdateCameraStorage(w http.ResponseWriter, r *http.Request) {
	var body struct {
		RetentionDays *int `json:"retention_days,omitempty"`
		QuotaGB       *int `json:"quota_gb,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if body.RetentionDays == nil && body.QuotaGB == nil {
		http.Error(w, "retention_days or quota_gb required", http.StatusBadRequest)
		return
	}
	id := r.PathValue("id")
	err := s.cameras.UpdateStorage(r.Context(), id, body.RetentionDays, body.QuotaGB)
	if errors.Is(err, camera.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		// Validation errors surface as 400; anything else is internal.
		if strings.HasPrefix(err.Error(), "retention_days") ||
			strings.HasPrefix(err.Error(), "quota_gb") ||
			strings.HasPrefix(err.Error(), "no fields") {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		slog.Error("update camera storage", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleSnapshot(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	jpg, err := s.snaps.Snapshot(r.Context(), id)
	if errors.Is(err, snapshot.ErrNoSegments) {
		http.Error(w, "no recording yet", http.StatusNotFound)
		return
	}
	if err != nil {
		slog.Warn("snapshot", "id", id, "err", err)
		http.Error(w, "snapshot failed", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(jpg)
}

// --- system / discovery ---

func (s *Server) handleLocalDevices(w http.ResponseWriter, _ *http.Request) {
	devs, err := system.ListLocalVideoDevices()
	if err != nil {
		slog.Warn("list local devices", "err", err)
		writeJSON(w, http.StatusOK, []any{})
		return
	}
	writeJSON(w, http.StatusOK, devs)
}

// --- rules / zones / incidents handlers ---

func (s *Server) handleListZones(w http.ResponseWriter, r *http.Request) {
	cameraID := r.URL.Query().Get("camera_id")
	zs, err := s.rules.ListZones(r.Context(), cameraID)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, zs)
}

func (s *Server) handleCreateZone(w http.ResponseWriter, r *http.Request) {
	var z rules.Zone
	if err := json.NewDecoder(r.Body).Decode(&z); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if z.CameraID == "" || z.Name == "" || len(z.Geometry) == 0 {
		http.Error(w, "camera_id, name, geometry required", http.StatusBadRequest)
		return
	}
	out, err := s.rules.CreateZone(r.Context(), z)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (s *Server) handleDeleteZone(w http.ResponseWriter, r *http.Request) {
	if err := s.rules.DeleteZone(r.Context(), r.PathValue("id")); errors.Is(err, rules.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	} else if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleUpdateZoneExclusions(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ExcludeClasses []string `json:"exclude_classes"`
		ExcludeKinds   []string `json:"exclude_kinds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	err := s.rules.UpdateZoneExclusions(r.Context(), r.PathValue("id"),
		body.ExcludeClasses, body.ExcludeKinds)
	if errors.Is(err, rules.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleListRules(w http.ResponseWriter, r *http.Request) {
	rs, err := s.rules.ListRules(r.Context())
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, rs)
}

func (s *Server) handleCreateRule(w http.ResponseWriter, r *http.Request) {
	var rr rules.Rule
	if err := json.NewDecoder(r.Body).Decode(&rr); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if rr.Name == "" || len(rr.Definition) == 0 {
		http.Error(w, "name, definition required", http.StatusBadRequest)
		return
	}
	if msg := validateRuleDefinition(rr.Definition); msg != "" {
		http.Error(w, msg, http.StatusBadRequest)
		return
	}
	out, err := s.rules.CreateRule(r.Context(), rr)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

// validateRuleDefinition rejects obviously-malformed rule JSON so the
// UI gets immediate feedback instead of the engine silently dropping
// the rule at reload time. Returns "" on OK, else a short message
// suitable for a 400 body. Slice 1 only validates sequence rules
// (new shape); existing single-camera rules pass through unchanged.
func validateRuleDefinition(raw json.RawMessage) string {
	var probe struct {
		Kind      string `json:"kind"`
		WindowSec int    `json:"window_sec"`
		Steps     []struct {
			CameraID string `json:"camera_id"`
		} `json:"steps"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return "definition must be a JSON object"
	}
	if probe.Kind != "sequence" {
		return ""
	}
	if len(probe.Steps) < 2 {
		return "sequence rule needs at least 2 steps"
	}
	if probe.WindowSec <= 0 {
		return "sequence rule needs window_sec > 0"
	}
	for i, s := range probe.Steps {
		if s.CameraID == "" {
			return fmt.Sprintf("step %d: camera_id is required", i)
		}
	}
	return ""
}

func (s *Server) handleDeleteRule(w http.ResponseWriter, r *http.Request) {
	if err := s.rules.DeleteRule(r.Context(), r.PathValue("id")); errors.Is(err, rules.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	} else if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleUpdateRule(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name       *string         `json:"name,omitempty"`
		Definition json.RawMessage `json:"definition,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if body.Name == nil && len(body.Definition) == 0 {
		http.Error(w, "name or definition required", http.StatusBadRequest)
		return
	}
	err := s.rules.UpdateRule(r.Context(), r.PathValue("id"), body.Name, body.Definition)
	if errors.Is(err, rules.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		slog.Error("update rule", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleEnableRule(w http.ResponseWriter, r *http.Request) {
	s.setRuleEnabled(w, r, true)
}
func (s *Server) handleDisableRule(w http.ResponseWriter, r *http.Request) {
	s.setRuleEnabled(w, r, false)
}
func (s *Server) setRuleEnabled(w http.ResponseWriter, r *http.Request, enabled bool) {
	if err := s.rules.SetRuleEnabled(r.Context(), r.PathValue("id"), enabled); errors.Is(err, rules.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	} else if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleListIncidents: GET /api/v1/incidents?limit=N&camera_id=X&from=RFC3339&to=RFC3339
// from/to select incidents whose span overlaps the window (Timeline day view).
func (s *Server) handleListIncidents(w http.ResponseWriter, r *http.Request) {
	args := rules.ListIncidentsArgs{
		Limit:    100,
		CameraID: r.URL.Query().Get("camera_id"),
	}
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			args.Limit = n
		}
	}
	if v := r.URL.Query().Get("from"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			http.Error(w, "bad 'from' (need RFC3339)", http.StatusBadRequest)
			return
		}
		args.From = t
	}
	if v := r.URL.Query().Get("to"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			http.Error(w, "bad 'to' (need RFC3339)", http.StatusBadRequest)
			return
		}
		args.To = t
	}
	out, err := s.rules.ListIncidents(r.Context(), args)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleAckIncident(w http.ResponseWriter, r *http.Request) {
	if err := s.rules.AcknowledgeIncident(r.Context(), r.PathValue("id")); errors.Is(err, rules.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	} else if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleDeleteIncident(w http.ResponseWriter, r *http.Request) {
	if err := s.rules.DeleteIncident(r.Context(), r.PathValue("id")); errors.Is(err, rules.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	} else if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func ctxWithTimeout(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(parent, 3*time.Second)
}

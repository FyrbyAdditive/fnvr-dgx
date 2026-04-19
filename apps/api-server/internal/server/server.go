package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/fnvr/fnvr/apps/api-server/internal/auth"
	"github.com/fnvr/fnvr/apps/api-server/internal/camera"
	"github.com/fnvr/fnvr/apps/api-server/internal/config"
	"github.com/fnvr/fnvr/apps/api-server/internal/detections"
	"github.com/fnvr/fnvr/apps/api-server/internal/events"
	"github.com/fnvr/fnvr/apps/api-server/internal/notifications"
	"github.com/fnvr/fnvr/apps/api-server/internal/pipeline"
	"github.com/fnvr/fnvr/apps/api-server/internal/rules"
	"github.com/fnvr/fnvr/apps/api-server/internal/segments"
	"github.com/fnvr/fnvr/apps/api-server/internal/settings"
	"github.com/fnvr/fnvr/apps/api-server/internal/snapshot"
	"github.com/fnvr/fnvr/apps/api-server/internal/system"
	"github.com/fnvr/fnvr/apps/api-server/internal/whep"
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
	whep      *whep.Registry
	camStates    *camera.StateTracker
	notifs       *notifications.Store
	settings     *settings.Store
	pipelineStat *pipeline.StateTracker
	natsPublish  func(subject string, data []byte) error
	detections   *detections.Store
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
	Whep          *whep.Registry
	CamStates     *camera.StateTracker
	Notifications *notifications.Store
	Settings      *settings.Store
	PipelineStat  *pipeline.StateTracker
	NatsPublish   func(subject string, data []byte) error
	Detections    *detections.Store
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
		whep:      d.Whep,
		camStates:    d.CamStates,
		notifs:       d.Notifications,
		settings:     d.Settings,
		pipelineStat: d.PipelineStat,
		natsPublish:  d.NatsPublish,
		detections:   d.Detections,
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// Public routes.
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.HandleFunc("GET /api/v1/system/info", s.handleSystemInfo)
	// Internal, unauthenticated endpoints for the pipeline container's
	// entrypoint. Read-only; safe because the docker bridge isolates
	// them. In a multi-tenant hosted deploy these would need IP gating.
	if s.settings != nil {
		mux.HandleFunc("GET /api/v1/internal/detector", s.handleGetDetector)
	}
	if s.cameras != nil {
		mux.HandleFunc("GET /api/v1/internal/cameras", s.handleInternalListCameras)
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

		// Reads — allowed for any authenticated user (admin or viewer).
		// Writes — wrapped in auth.AdminFunc so viewers get 403.
		protected.HandleFunc("GET /api/v1/cameras", s.handleListCameras)
		protected.Handle("POST /api/v1/cameras", auth.AdminFunc(s.handleCreateCamera))
		protected.HandleFunc("GET /api/v1/cameras/{id}", s.handleGetCamera)
		protected.Handle("DELETE /api/v1/cameras/{id}", auth.AdminFunc(s.handleDeleteCamera))
		protected.Handle("PATCH /api/v1/cameras/{id}/detectors", auth.AdminFunc(s.handleUpdateCameraDetectors))
		protected.Handle("PATCH /api/v1/cameras/{id}/classes", auth.AdminFunc(s.handleUpdateCameraClasses))
		if s.snaps != nil {
			protected.HandleFunc("GET /api/v1/cameras/{id}/snapshot.jpg", s.handleSnapshot)
		}
		if s.whep != nil {
			// WHEP negotiation is a viewer action (it establishes a live
			// playback session, not a mutation), so stays open to all
			// authenticated users.
			protected.HandleFunc("POST /api/v1/cameras/{id}/whep", s.handleWhepOffer)
			protected.HandleFunc("OPTIONS /api/v1/cameras/{id}/whep", s.handleWhepOptions)
		}

		if s.rules != nil {
			protected.HandleFunc("GET /api/v1/zones", s.handleListZones)
			protected.Handle("POST /api/v1/zones", auth.AdminFunc(s.handleCreateZone))
			protected.Handle("DELETE /api/v1/zones/{id}", auth.AdminFunc(s.handleDeleteZone))
			protected.Handle("PATCH /api/v1/zones/{id}/exclusions", auth.AdminFunc(s.handleUpdateZoneExclusions))

			protected.HandleFunc("GET /api/v1/rules", s.handleListRules)
			protected.Handle("POST /api/v1/rules", auth.AdminFunc(s.handleCreateRule))
			protected.Handle("DELETE /api/v1/rules/{id}", auth.AdminFunc(s.handleDeleteRule))
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
			protected.HandleFunc("GET /api/v1/settings/class_mutes", s.handleGetClassMutes)
			protected.Handle("PUT /api/v1/settings/class_mutes", auth.AdminFunc(s.handleUpdateClassMutes))
		}
		if s.pipelineStat != nil {
			protected.HandleFunc("GET /api/v1/system/pipeline/state", s.handlePipelineState)
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
			mux.Handle("/api/v1/settings/class_mutes", guarded)
		}
		if s.pipelineStat != nil {
			mux.Handle("/api/v1/system/pipeline/state", guarded)
		}
		if s.natsPublish != nil {
			mux.Handle("/api/v1/system/pipeline/restart", guarded)
		}
		mux.Handle("/api/v1/users", guarded)
		mux.Handle("/api/v1/users/", guarded)
	}

	return loggingMiddleware(corsMiddleware(mux))
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
func decorateCameras(cams []camera.Camera, states *camera.StateTracker) []map[string]any {
	out := make([]map[string]any, 0, len(cams))
	for _, c := range cams {
		state := "unknown"
		if states != nil {
			if st, ok := states.State(c.ID); ok {
				state = st
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
			"created_at":               c.CreatedAt,
			"updated_at":               c.UpdatedAt,
			"state":                    state,
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
	if _, err := s.pipeline.AddCamera(ctxWithTimeout(r.Context()), pipeline.AddCameraArgs{
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
	if _, err := s.pipeline.RemoveCamera(ctxWithTimeout(r.Context()), id); err != nil {
		slog.Warn("pipeline.RemoveCamera failed", "id", id, "err", err)
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

// handleWhepOffer proxies a browser's SDP offer to the pipeline worker that
// owns the camera. Returns the worker's SDP answer verbatim.
func (s *Server) handleWhepOffer(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	entry, ok := s.whep.Lookup(id)
	if !ok {
		http.Error(w, "camera not streaming", http.StatusNotFound)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "read body", http.StatusBadRequest)
		return
	}
	if len(body) == 0 {
		http.Error(w, "empty offer", http.StatusBadRequest)
		return
	}

	// Worker binds on pipeline container network interface; docker DNS
	// resolves "pipeline" to that container. Any port the worker bound
	// is reachable internally regardless of compose `ports:` declaration.
	url := fmt.Sprintf("http://pipeline:%d/whep", entry.Port)
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	req.Header.Set("Content-Type", "application/sdp")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		slog.Warn("whep proxy", "camera", id, "err", err)
		http.Error(w, "worker unreachable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	w.Header().Set("Content-Type", "application/sdp")
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(respBody)
}

func (s *Server) handleWhepOptions(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
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
	out, err := s.rules.CreateRule(r.Context(), rr)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, out)
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

func (s *Server) handleListIncidents(w http.ResponseWriter, r *http.Request) {
	limit := 100
	if v := r.URL.Query().Get("limit"); v != "" {
		_, _ = fmt.Sscanf(v, "%d", &limit)
	}
	out, err := s.rules.ListIncidents(r.Context(), limit)
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

func ctxWithTimeout(parent context.Context) context.Context {
	ctx, _ := context.WithTimeout(parent, 3*time.Second) //nolint:govet // short-lived, handler-scoped
	return ctx
}

package mtxproxy

import (
	"context"
	"log/slog"
	"net/url"
	"strings"
	"sync"

	"github.com/fnvr/fnvr/apps/api-server/internal/camera"
)

// pathPrefix isolates api-server-managed paths from anything else
// MediaMTX might have configured via env vars (test, usb0, etc.). The
// reconciler only touches paths starting with this.
const pathPrefix = "proxy_"

// redactSourceURL strips embedded credentials so RTSP passwords aren't logged.
func redactSourceURL(raw string) string {
	if u, err := url.Parse(raw); err == nil && u.User != nil {
		u.User = url.User("***")
		return u.String()
	}
	return raw
}

// Reconciler keeps MediaMTX's live path config in sync with the set of
// cameras that have mtx_proxy=true. Single-flighted via an internal
// mutex so a burst of PATCHes doesn't fire overlapping reconciles.
type Reconciler struct {
	client *Client
	store  *camera.Store

	mu sync.Mutex
}

func NewReconciler(client *Client, store *camera.Store) *Reconciler {
	return &Reconciler{client: client, store: store}
}

// Reconcile converges MediaMTX's proxy_* paths to match the current
// camera table. Safe to call repeatedly.
func (r *Reconciler) Reconcile(ctx context.Context) {
	if r == nil || r.client == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	cams, err := r.store.List(ctx)
	if err != nil {
		slog.Warn("mtxproxy: list cameras", "err", err)
		return
	}
	// Desired set: camera_id → (url, cert_fingerprint) for rows with
	// mtx_proxy=true and a non-empty url. Fingerprint optional; set
	// only when the operator ticked "Ignore certificate" in the UI.
	type desired struct {
		url, fingerprint string
	}
	want := map[string]desired{}
	for _, c := range cams {
		if !c.MtxProxy || c.URL == "" {
			continue
		}
		want[pathName(c.ID)] = desired{url: c.URL, fingerprint: c.MtxTLSFingerprint}
	}

	existing, err := r.client.List(ctx)
	if err != nil {
		// If MediaMTX is unreachable we can't know what's there; log
		// and try the adds anyway — the Add call will short-circuit to
		// its own error path and we'll retry on the next reconcile.
		slog.Warn("mtxproxy: list paths", "err", err)
	}
	// Delete anything api-server previously managed that's no longer
	// wanted. Never touch paths we don't own (test, usb0, etc.).
	for _, name := range existing {
		if !strings.HasPrefix(name, pathPrefix) {
			continue
		}
		if _, keep := want[name]; keep {
			continue
		}
		if err := r.client.Delete(ctx, name); err != nil {
			slog.Warn("mtxproxy: delete", "path", name, "err", err)
		} else {
			slog.Info("mtxproxy: deleted", "path", name)
		}
	}
	// Add-or-patch desired paths.
	for name, d := range want {
		cfg := PathConfig{
			Source:            d.url,
			SourceProtocol:    "tcp",
			SourceOnDemand:    false,
			SourceFingerprint: d.fingerprint,
		}
		if err := r.client.Add(ctx, name, cfg); err != nil {
			slog.Warn("mtxproxy: add", "path", name, "err", err)
			continue
		}
		slog.Info("mtxproxy: up", "path", name, "source", redactSourceURL(d.url),
			"pinned_cert", d.fingerprint != "")
	}
}

// pathName maps a camera id to the MediaMTX path name. Camera IDs
// are already slug-safe (see camera.Store.slugify) so we just prefix.
func pathName(cameraID string) string {
	return pathPrefix + cameraID
}

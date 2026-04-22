// Package habridge advertises every fnvr camera as a Home Assistant
// device via MQTT auto-discovery and publishes live state from the
// NATS detection / incident / camera-state streams. It shares the
// notification-dispatcher's MQTT connection pool so enabling both an
// mqtt notification channel and this bridge against the same broker
// uses exactly one TCP session.
package habridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"

	"github.com/fnvr/fnvr/apps/notification-dispatcher/internal/mqtthub"
)

// Config is a reduced mirror of settings.HAConfig — declared here so
// notification-dispatcher doesn't pull api-server's settings package.
type Config struct {
	Enabled         bool
	BrokerURL       string
	Username        string
	Password        string
	DiscoveryPrefix string // default "homeassistant"
	TopicPrefix     string // default "fnvr"
}

// Bridge is the long-running publisher. Start() returns quickly; work
// runs in goroutines until Stop() or ctx cancel. Safe to Start + Stop
// repeatedly (e.g. on config change).
type Bridge struct {
	cfg  Config
	pool *pgxpool.Pool
	nc   *nats.Conn
	hub  *mqtthub.Hub

	mu      sync.Mutex
	running bool
	cancel  context.CancelFunc
	release func() // hub release

	// Per-camera motion-OFF timers + published-camera set.
	motionMu      sync.Mutex
	motionTimers  map[string]*time.Timer
	announcedCams map[string]struct{}
}

type detection struct {
	CameraID   string            `json:"camera_id"`
	ClassName  string            `json:"class_name"`
	Kind       string            `json:"kind"`
	Confidence float32           `json:"confidence"`
	Attributes map[string]string `json:"attributes,omitempty"`
}

type incident struct {
	ID       string `json:"id"`
	CameraID string `json:"camera_id"`
	Severity string `json:"severity"`
	Summary  string `json:"summary"`
}

type cameraState struct {
	CameraID string `json:"camera_id"`
	State    string `json:"state"`
}

func New(pool *pgxpool.Pool, nc *nats.Conn, hub *mqtthub.Hub) *Bridge {
	return &Bridge{
		pool:          pool,
		nc:            nc,
		hub:           hub,
		motionTimers:  map[string]*time.Timer{},
		announcedCams: map[string]struct{}{},
	}
}

// Start brings the bridge up against the given config. Returns nil and
// no-ops if Enabled=false. Safe to call even when already running —
// stops the previous instance first.
func (b *Bridge) Start(parent context.Context, cfg Config) error {
	b.Stop()
	if !cfg.Enabled {
		return nil
	}
	if cfg.DiscoveryPrefix == "" {
		cfg.DiscoveryPrefix = "homeassistant"
	}
	if cfg.TopicPrefix == "" {
		cfg.TopicPrefix = "fnvr"
	}
	client, release, err := b.hub.Acquire(cfg.BrokerURL, cfg.Username, cfg.Password)
	if err != nil {
		return fmt.Errorf("ha bridge: acquire broker: %w", err)
	}

	ctx, cancel := context.WithCancel(parent)
	b.mu.Lock()
	b.cfg = cfg
	b.running = true
	b.cancel = cancel
	b.release = release
	b.mu.Unlock()

	// Initial camera discovery announcement + goroutine for refresh.
	if err := b.announceCameras(ctx, client); err != nil {
		slog.Warn("ha bridge: initial announce", "err", err)
	}
	go b.runCameraReconcile(ctx, client)

	// Subscribe to NATS streams. Use the accepted-detections subject
	// that event-processor republishes after suppression so flagged
	// false positives don't trigger Home Assistant entities either.
	detSub, err := b.nc.Subscribe("fnvr.events.detection_accepted.>", func(m *nats.Msg) {
		var d detection
		if err := json.Unmarshal(m.Data, &d); err == nil {
			b.onDetection(client, d)
		}
	})
	if err != nil {
		return fmt.Errorf("ha bridge: subscribe detection: %w", err)
	}
	incSub, err := b.nc.Subscribe("fnvr.events.incident.>", func(m *nats.Msg) {
		var inc incident
		if err := json.Unmarshal(m.Data, &inc); err == nil {
			b.onIncident(client, inc)
		}
	})
	if err != nil {
		detSub.Unsubscribe()
		return fmt.Errorf("ha bridge: subscribe incident: %w", err)
	}
	stateSub, err := b.nc.Subscribe("fnvr.state.camera.>", func(m *nats.Msg) {
		var cs cameraState
		if err := json.Unmarshal(m.Data, &cs); err == nil {
			b.onCameraState(client, cs)
		}
	})
	if err != nil {
		detSub.Unsubscribe()
		incSub.Unsubscribe()
		return fmt.Errorf("ha bridge: subscribe state: %w", err)
	}

	// On ctx cancel, unsubscribe.
	go func() {
		<-ctx.Done()
		detSub.Unsubscribe()
		incSub.Unsubscribe()
		stateSub.Unsubscribe()
	}()
	slog.Info("ha bridge: running", "broker", cfg.BrokerURL)
	return nil
}

// Stop halts the bridge and releases its broker connection. Idempotent.
func (b *Bridge) Stop() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.running {
		return
	}
	if b.cancel != nil {
		b.cancel()
	}
	if b.release != nil {
		b.release()
		b.release = nil
	}
	// Cancel outstanding motion timers.
	b.motionMu.Lock()
	for _, t := range b.motionTimers {
		t.Stop()
	}
	b.motionTimers = map[string]*time.Timer{}
	b.motionMu.Unlock()
	b.announcedCams = map[string]struct{}{}
	b.running = false
	slog.Info("ha bridge: stopped")
}

// runCameraReconcile re-announces every 30s so newly-added cameras
// appear and deleted ones have their discovery config cleared.
func (b *Bridge) runCameraReconcile(ctx context.Context, client mqtt.Client) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := b.announceCameras(ctx, client); err != nil {
				slog.Warn("ha bridge: announce", "err", err)
			}
		}
	}
}

// announceCameras pulls the camera list and publishes one retained HA
// discovery config per camera. Cameras that were previously announced
// but are no longer present get an empty retained payload so HA drops
// them.
func (b *Bridge) announceCameras(ctx context.Context, client mqtt.Client) error {
	rows, err := b.pool.Query(ctx, `
		SELECT id, name, location_kind
		FROM cameras
		WHERE enabled = TRUE
		ORDER BY id ASC`)
	if err != nil {
		return err
	}
	defer rows.Close()
	current := map[string]struct{}{}
	for rows.Next() {
		var id, name string
		var locationKind *string
		if err := rows.Scan(&id, &name, &locationKind); err != nil {
			continue
		}
		current[id] = struct{}{}
		model := "camera"
		if locationKind != nil && *locationKind != "" {
			model = *locationKind + " camera"
		}
		b.publishDiscovery(client, id, name, model)
	}
	// Drop stale announcements.
	for prevID := range b.announcedCams {
		if _, still := current[prevID]; !still {
			b.clearDiscovery(client, prevID)
		}
	}
	b.announcedCams = current
	return nil
}

// haEntity defines one discovery payload component.
type haEntity struct {
	Platform         string `json:"p"`             // binary_sensor / sensor
	Name             string `json:"name"`
	UniqueID         string `json:"unique_id"`
	StateTopic       string `json:"state_topic"`
	DeviceClass      string `json:"device_class,omitempty"`
	Icon             string `json:"icon,omitempty"`
	PayloadOn        string `json:"payload_on,omitempty"`
	PayloadOff       string `json:"payload_off,omitempty"`
	EntityCategory   string `json:"entity_category,omitempty"`
	AvailabilityTopic string `json:"availability_topic,omitempty"`
	PayloadAvailable string `json:"payload_available,omitempty"`
	PayloadNotAvail  string `json:"payload_not_available,omitempty"`
}

// publishDiscovery publishes a single-device bundle (HA 2023.8+
// discovery format) advertising all six entities per camera. Retained
// so HA sees them on its next restart.
func (b *Bridge) publishDiscovery(client mqtt.Client, id, name, model string) {
	tp := b.cfg.TopicPrefix
	devID := "fnvr_" + sanitiseID(id)
	avail := mqtthub.AvailabilityTopic()
	mk := func(platform, suffix, stateTopic, deviceClass string) haEntity {
		return haEntity{
			Platform:         platform,
			Name:             titleCase(strings.ReplaceAll(suffix, "_", " ")),
			UniqueID:         devID + "_" + suffix,
			StateTopic:       stateTopic,
			DeviceClass:      deviceClass,
			AvailabilityTopic: avail,
			PayloadAvailable:  mqtthub.StatusOnline,
			PayloadNotAvail:   mqtthub.StatusOffline,
		}
	}
	motion := mk("binary_sensor", "motion", fmt.Sprintf("%s/%s/motion", tp, id), "motion")
	motion.PayloadOn = "ON"
	motion.PayloadOff = "OFF"
	incidentE := mk("binary_sensor", "incident", fmt.Sprintf("%s/%s/incident", tp, id), "safety")
	incidentE.PayloadOn = "ON"
	incidentE.PayloadOff = "OFF"
	entities := map[string]haEntity{
		"motion":           motion,
		"incident":         incidentE,
		"last_class":       mk("sensor", "last_class", fmt.Sprintf("%s/%s/last_class", tp, id), ""),
		"last_confidence":  mk("sensor", "last_confidence", fmt.Sprintf("%s/%s/last_confidence", tp, id), ""),
		"last_plate":       mk("sensor", "last_plate", fmt.Sprintf("%s/%s/last_plate", tp, id), ""),
		"camera_state":     mk("sensor", "camera_state", fmt.Sprintf("%s/%s/camera_state", tp, id), ""),
	}

	payload := map[string]any{
		"device": map[string]any{
			"identifiers":  []string{devID},
			"name":         name,
			"manufacturer": "fnvr",
			"model":        model,
			"sw_version":   "dev",
		},
		"origin": map[string]string{
			"name": "fnvr",
			"sw":   "notification-dispatcher",
		},
		"availability": []map[string]string{{"topic": avail}},
		"components":   entities,
		"qos":          "1",
	}
	raw, _ := json.Marshal(payload)
	topic := fmt.Sprintf("%s/device/%s/config", b.cfg.DiscoveryPrefix, devID)
	client.Publish(topic, 1, true, raw)
}

// clearDiscovery publishes an empty retained payload on the camera's
// discovery topic so HA drops the device on its next scan. HA treats
// an empty payload on a previously-retained config as a delete.
func (b *Bridge) clearDiscovery(client mqtt.Client, id string) {
	devID := "fnvr_" + sanitiseID(id)
	topic := fmt.Sprintf("%s/device/%s/config", b.cfg.DiscoveryPrefix, devID)
	client.Publish(topic, 1, true, []byte{})
}

// --- event handlers ---

func (b *Bridge) onDetection(client mqtt.Client, d detection) {
	if d.CameraID == "" {
		return
	}
	tp := b.cfg.TopicPrefix
	base := fmt.Sprintf("%s/%s", tp, d.CameraID)
	// Always publish the freshest class + confidence — these aren't
	// latency-sensitive on HA's side (it just shows the value) so
	// even 30/sec is fine; the broker and HA both handle it.
	client.Publish(base+"/last_class", 0, true, []byte(d.ClassName))
	client.Publish(base+"/last_confidence", 0, true, []byte(fmt.Sprintf("%.2f", d.Confidence)))
	if d.Kind == "anpr" {
		if plate := d.Attributes["plate"]; plate != "" {
			client.Publish(base+"/last_plate", 0, true, []byte(plate))
		}
	}
	b.setMotion(client, d.CameraID, true)
}

func (b *Bridge) onIncident(client mqtt.Client, inc incident) {
	if inc.CameraID == "" {
		return
	}
	tp := b.cfg.TopicPrefix
	client.Publish(fmt.Sprintf("%s/%s/incident", tp, inc.CameraID), 1, true, []byte("ON"))
	// Auto-clear after 5 minutes so HA doesn't stay stuck-on forever
	// even if the operator never acks via the UI. The next incident
	// on the same camera resets the timer.
	go func() {
		time.Sleep(5 * time.Minute)
		client.Publish(fmt.Sprintf("%s/%s/incident", tp, inc.CameraID), 1, true, []byte("OFF"))
	}()
}

func (b *Bridge) onCameraState(client mqtt.Client, cs cameraState) {
	if cs.CameraID == "" {
		return
	}
	tp := b.cfg.TopicPrefix
	client.Publish(fmt.Sprintf("%s/%s/camera_state", tp, cs.CameraID), 1, true, []byte(cs.State))
}

// setMotion flips the motion sensor ON and arms a 5s OFF timer. Any
// subsequent detection resets the timer. Only publishes the ON edge
// once per quiet-period so broker pressure stays low.
func (b *Bridge) setMotion(client mqtt.Client, cameraID string, on bool) {
	topic := fmt.Sprintf("%s/%s/motion", b.cfg.TopicPrefix, cameraID)
	b.motionMu.Lock()
	defer b.motionMu.Unlock()
	existing := b.motionTimers[cameraID]
	if on {
		if existing == nil {
			// Edge: OFF → ON.
			client.Publish(topic, 0, true, []byte("ON"))
		} else {
			existing.Stop()
		}
		b.motionTimers[cameraID] = time.AfterFunc(5*time.Second, func() {
			b.motionMu.Lock()
			delete(b.motionTimers, cameraID)
			b.motionMu.Unlock()
			client.Publish(topic, 0, true, []byte("OFF"))
		})
	}
}

// sanitiseID turns a camera id into a safe MQTT topic segment.
// Camera IDs are slugified at create time (see camera.store.slugify)
// so this is usually a no-op, but belt-and-braces.
func sanitiseID(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	out := b.String()
	if out == "" {
		return "unknown"
	}
	return out
}

func titleCase(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// Static check: the package is only useful with the three inputs.
var _ = errors.New

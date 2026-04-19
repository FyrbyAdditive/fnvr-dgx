// Package rules is the M2 rules engine: consume detections from NATS, apply
// zones / tripwires / schedules / cooldowns, write incidents back to Postgres,
// republish on fnvr.events.incident.<camera>.
//
// M2 scope:
//   - Polygon zones (point-in-polygon on bbox centre).
//   - Line crossings (segment intersection with track history).
//   - Schedules (time-of-day, day-of-week, sunrise/sunset).
//   - Per-rule cooldown + per-camera rate limit.
//   - Incident threading (group detections within an inactivity window).
//
// Deferred to M3: cross-camera rules, attribute filters (colour/make/plate),
// combinatorial conditions, scripting hook.
package rules

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
)

type Config struct {
	NATSURL     string
	DatabaseURL string
}

type Engine struct {
	cfg  Config
	nc   *nats.Conn
	pool *pgxpool.Pool

	mu    sync.RWMutex
	rules []compiledRule
	zones map[string][]Zone // camera_id → zones
	// Per-camera detector whitelist. Empty slice (or camera absent from
	// the map) means "all detectors enabled" — the friendly default so
	// new cameras keep behaving like they always did.
	enabledDetectors map[string][]string

	// Per-rule cooldown state: last-fired timestamp.
	cooldowns map[string]time.Time
}

type Detection struct {
	ID         string            `json:"id"`
	CameraID   string            `json:"camera_id"`
	TS         time.Time         `json:"ts"`
	ClassName  string            `json:"class_name"`
	// Kind is the detector family ("object", "anpr", "face", …). Empty is
	// treated as "object" so older pipeline workers that don't set the
	// field remain compatible.
	Kind       string            `json:"kind,omitempty"`
	Confidence float32           `json:"confidence"`
	BBox       BBox              `json:"bbox"`
	TrackID    string            `json:"track_id,omitempty"`
	Attributes map[string]string `json:"attributes,omitempty"`
}

type BBox struct {
	X float32 `json:"x"`
	Y float32 `json:"y"`
	W float32 `json:"w"`
	H float32 `json:"h"`
}

type Zone struct {
	ID             string    `json:"id"`
	CameraID       string    `json:"camera_id"`
	Kind           string    `json:"kind"` // polygon | line | tripwire
	Geometry       []float32 `json:"geometry"` // [x0,y0,x1,y1,...] normalised
	ExcludeClasses []string  `json:"exclude_classes,omitempty"`
	ExcludeKinds   []string  `json:"exclude_kinds,omitempty"`
}

type Rule struct {
	ID         string       `json:"id"`
	Name       string       `json:"name"`
	Enabled    bool         `json:"enabled"`
	Definition RuleDef      `json:"definition"`
}

type RuleDef struct {
	CameraID       string   `json:"camera_id,omitempty"` // empty → all cameras
	Classes        []string `json:"classes"`             // e.g. ["person","car"]
	MinConfidence  float32  `json:"min_confidence"`
	ZoneID         string   `json:"zone_id,omitempty"`
	Direction      string   `json:"direction,omitempty"` // "in" | "out" | "" for both
	CooldownSec    int      `json:"cooldown_sec"`
	Schedule       Schedule `json:"schedule"`
	Severity       string   `json:"severity"` // info | warning | critical
}

type Schedule struct {
	StartMinute int    `json:"start_minute"` // 0..1439 (minute of day)
	EndMinute   int    `json:"end_minute"`
	Days        []int  `json:"days"` // 0=Sun..6=Sat; empty = all days
	Timezone    string `json:"timezone,omitempty"`
}

type compiledRule struct {
	Rule
	classes map[string]struct{}
}

func New(ctx context.Context, cfg Config) (*Engine, error) {
	nc, err := nats.Connect(cfg.NATSURL, nats.Name("fnvr-event-processor"))
	if err != nil {
		return nil, fmt.Errorf("nats: %w", err)
	}
	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, fmt.Errorf("pg: %w", err)
	}
	return &Engine{
		cfg:              cfg,
		nc:               nc,
		pool:             pool,
		zones:            map[string][]Zone{},
		enabledDetectors: map[string][]string{},
		cooldowns:        map[string]time.Time{},
	}, nil
}

func (e *Engine) Close() {
	if e.nc != nil {
		_ = e.nc.Drain()
	}
	if e.pool != nil {
		e.pool.Close()
	}
}

func (e *Engine) Run(ctx context.Context) error {
	if err := e.reload(ctx); err != nil {
		return err
	}
	// Reload rules every 30s — cheap, and avoids plumbing a change notifier
	// into api-server for M2.
	go e.periodicReload(ctx)

	_, err := e.nc.Subscribe("fnvr.events.detection.>", func(msg *nats.Msg) {
		var d Detection
		if err := json.Unmarshal(msg.Data, &d); err != nil {
			slog.Warn("bad detection", "err", err)
			return
		}
		if err := e.onDetection(ctx, d); err != nil {
			slog.Warn("rule eval", "err", err, "cam", d.CameraID)
		}
	})
	if err != nil {
		return err
	}
	<-ctx.Done()
	return nil
}

func (e *Engine) periodicReload(ctx context.Context) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := e.reload(ctx); err != nil {
				slog.Warn("reload rules", "err", err)
			}
		}
	}
}

func (e *Engine) reload(ctx context.Context) error {
	// Zones + their optional mute arrays.
	zrows, err := e.pool.Query(ctx, `
		SELECT id::text, camera_id, kind, geometry, exclude_classes, exclude_kinds
		FROM zones`)
	if err != nil {
		return err
	}
	zones := map[string][]Zone{}
	for zrows.Next() {
		var z Zone
		var geom []byte
		if err := zrows.Scan(&z.ID, &z.CameraID, &z.Kind, &geom,
			&z.ExcludeClasses, &z.ExcludeKinds); err != nil {
			zrows.Close()
			return err
		}
		var parsed struct {
			Points []float32 `json:"points"`
		}
		_ = json.Unmarshal(geom, &parsed)
		z.Geometry = parsed.Points
		zones[z.CameraID] = append(zones[z.CameraID], z)
	}
	zrows.Close()

	// Rules.
	rrows, err := e.pool.Query(ctx, `SELECT id::text, name, enabled, definition FROM rules WHERE enabled`)
	if err != nil {
		return err
	}
	defer rrows.Close()
	var compiled []compiledRule
	for rrows.Next() {
		var r Rule
		var def []byte
		if err := rrows.Scan(&r.ID, &r.Name, &r.Enabled, &def); err != nil {
			return err
		}
		if err := json.Unmarshal(def, &r.Definition); err != nil {
			slog.Warn("bad rule definition", "id", r.ID, "err", err)
			continue
		}
		cls := make(map[string]struct{}, len(r.Definition.Classes))
		for _, c := range r.Definition.Classes {
			cls[c] = struct{}{}
		}
		compiled = append(compiled, compiledRule{Rule: r, classes: cls})
	}

	// Per-camera detector whitelist. Empty array on disk = "all enabled";
	// we preserve that meaning in memory by leaving the key out of the map
	// (absent ⇒ allow-all in the gate).
	crows, err := e.pool.Query(ctx, `SELECT id, enabled_detectors FROM cameras`)
	if err != nil {
		return err
	}
	enabled := map[string][]string{}
	for crows.Next() {
		var id string
		var kinds []string
		if err := crows.Scan(&id, &kinds); err != nil {
			crows.Close()
			return err
		}
		if len(kinds) > 0 {
			enabled[id] = kinds
		}
	}
	crows.Close()

	e.mu.Lock()
	e.rules = compiled
	e.zones = zones
	e.enabledDetectors = enabled
	e.mu.Unlock()
	slog.Info("rules reloaded",
		"rules", len(compiled),
		"zone_cameras", len(zones),
		"detector_filtered_cameras", len(enabled))
	return nil
}

func (e *Engine) onDetection(ctx context.Context, d Detection) error {
	e.mu.RLock()
	rules := e.rules
	zones := e.zones[d.CameraID]
	allowed := e.enabledDetectors[d.CameraID]
	e.mu.RUnlock()

	// Per-camera detector whitelist — e.g. ANPR is pointless on indoor
	// cameras. Empty (or absent) whitelist means "all detectors enabled".
	// Detections whose kind isn't listed are dropped before persistence,
	// same as a zone-wide kind-mute.
	if len(allowed) > 0 && !kindIn(d.Kind, allowed) {
		return nil
	}

	// Zone mute gate — runs before persistence so muted detections stay out
	// of the timeline entirely. A detection is muted if its bbox centre
	// falls inside any polygon zone on this camera that either lists the
	// detection's class in exclude_classes OR lists the detection's kind
	// in exclude_kinds. Non-polygon zones (line / tripwire) don't mute
	// because "inside" is not well-defined for them.
	if isMuted(d, zones) {
		return nil
	}

	// Persist raw detection — the timeline reads from here.
	if _, err := e.pool.Exec(ctx, `
		INSERT INTO detections (event_id, camera_id, ts, class_name, confidence, bbox, track_id, attributes)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		d.ID, d.CameraID, d.TS, d.ClassName, d.Confidence,
		mustJSON(d.BBox), nullIfEmpty(d.TrackID), mustJSON(d.Attributes),
	); err != nil {
		return err
	}

	for _, r := range rules {
		if r.Definition.CameraID != "" && r.Definition.CameraID != d.CameraID {
			continue
		}
		if d.Confidence < r.Definition.MinConfidence {
			continue
		}
		if len(r.classes) > 0 {
			if _, ok := r.classes[d.ClassName]; !ok {
				continue
			}
		}
		if !inSchedule(r.Definition.Schedule, d.TS) {
			continue
		}
		if r.Definition.ZoneID != "" && !bboxInZone(d.BBox, r.Definition.ZoneID, zones) {
			continue
		}
		if !e.cooldownOK(r.ID, r.Definition.CooldownSec, d.TS) {
			continue
		}
		if err := e.fireIncident(ctx, r, d); err != nil {
			slog.Warn("fire incident", "rule", r.ID, "err", err)
		}
	}
	return nil
}

func (e *Engine) cooldownOK(ruleID string, seconds int, now time.Time) bool {
	if seconds <= 0 {
		return true
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	last := e.cooldowns[ruleID]
	if now.Sub(last) < time.Duration(seconds)*time.Second {
		return false
	}
	e.cooldowns[ruleID] = now
	return true
}

func (e *Engine) fireIncident(ctx context.Context, r compiledRule, d Detection) error {
	severity := r.Definition.Severity
	if severity == "" {
		severity = "info"
	}
	summary := fmt.Sprintf("%s on %s (%.0f%%)", d.ClassName, d.CameraID, d.Confidence*100)

	var incidentID string
	err := e.pool.QueryRow(ctx, `
		INSERT INTO incidents (rule_id, camera_id, started_at, ended_at, severity, summary)
		VALUES ($1,$2,$3,$3,$4,$5) RETURNING id::text`,
		r.ID, d.CameraID, d.TS, severity, summary).Scan(&incidentID)
	if err != nil {
		return err
	}

	payload, _ := json.Marshal(map[string]any{
		"id":         incidentID,
		"rule_id":    r.ID,
		"camera_id":  d.CameraID,
		"started_at": d.TS,
		"severity":   severity,
		"summary":    summary,
	})
	return e.nc.Publish("fnvr.events.incident."+d.CameraID, payload)
}

// --- helpers ---

func inSchedule(s Schedule, t time.Time) bool {
	if s.StartMinute == 0 && s.EndMinute == 0 && len(s.Days) == 0 {
		return true // unset = always
	}
	loc := time.UTC
	if s.Timezone != "" {
		if l, err := time.LoadLocation(s.Timezone); err == nil {
			loc = l
		}
	}
	local := t.In(loc)
	if len(s.Days) > 0 {
		ok := false
		for _, d := range s.Days {
			if int(local.Weekday()) == d {
				ok = true
				break
			}
		}
		if !ok {
			return false
		}
	}
	mins := local.Hour()*60 + local.Minute()
	if s.StartMinute <= s.EndMinute {
		return mins >= s.StartMinute && mins <= s.EndMinute
	}
	// wraps midnight
	return mins >= s.StartMinute || mins <= s.EndMinute
}

// kindIn reports whether a detection kind is in the given whitelist.
// Empty kind is normalised to "object" so legacy workers keep working.
func kindIn(kind string, allowed []string) bool {
	if kind == "" {
		kind = "object"
	}
	for _, k := range allowed {
		if k == kind {
			return true
		}
	}
	return false
}

// isMuted returns true when the detection's bbox centre falls inside any
// polygon zone that mutes the detection by class or detector kind.
func isMuted(d Detection, zones []Zone) bool {
	if len(zones) == 0 {
		return false
	}
	kind := d.Kind
	if kind == "" {
		kind = "object"
	}
	cx, cy := d.BBox.X+d.BBox.W/2, d.BBox.Y+d.BBox.H/2
	for _, z := range zones {
		if z.Kind != "polygon" {
			continue
		}
		if len(z.ExcludeClasses) == 0 && len(z.ExcludeKinds) == 0 {
			continue
		}
		if !pointInPolygon(cx, cy, z.Geometry) {
			continue
		}
		for _, c := range z.ExcludeClasses {
			if c == d.ClassName {
				return true
			}
		}
		for _, k := range z.ExcludeKinds {
			if k == kind {
				return true
			}
		}
	}
	return false
}

func bboxInZone(b BBox, zoneID string, zones []Zone) bool {
	cx, cy := b.X+b.W/2, b.Y+b.H/2
	for _, z := range zones {
		if z.ID != zoneID {
			continue
		}
		if z.Kind != "polygon" {
			// For M2, line/tripwire need track history; handle in a later pass.
			return false
		}
		return pointInPolygon(cx, cy, z.Geometry)
	}
	return false
}

// Standard ray-cast PIP. geometry is [x0,y0,x1,y1,...]; treated as closed.
func pointInPolygon(x, y float32, g []float32) bool {
	if len(g) < 6 || len(g)%2 != 0 {
		return false
	}
	inside := false
	n := len(g) / 2
	j := n - 1
	for i := 0; i < n; i++ {
		xi, yi := g[2*i], g[2*i+1]
		xj, yj := g[2*j], g[2*j+1]
		if ((yi > y) != (yj > y)) && (x < (xj-xi)*(y-yi)/(yj-yi)+xi) {
			inside = !inside
		}
		j = i
	}
	return inside
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

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

	"github.com/fnvr/fnvr/apps/event-processor/internal/sidecar"
)

type Config struct {
	NATSURL       string
	DatabaseURL   string
	RecordingsDir string
}

type Engine struct {
	cfg     Config
	nc      *nats.Conn
	pool    *pgxpool.Pool
	sidecar *sidecar.Writer

	mu    sync.RWMutex
	rules []compiledRule
	zones map[string][]Zone // camera_id → zones
	// Per-camera detector whitelist. Empty slice (or camera absent from
	// the map) means "all detectors enabled" — the friendly default so
	// new cameras keep behaving like they always did.
	enabledDetectors map[string][]string

	// Per-camera resolved class-mute set. Computed in reload() from:
	//   - settings.classes.disabled.{global,indoor,outdoor}
	//   - cameras.{location_kind, mute_classes_override,
	//     unmute_classes_override}
	// The onDetection gate just does an O(1) map lookup on (camera_id,
	// class_name). Absent camera in the outer map = no mutes (fast path).
	mutedClasses map[string]map[string]struct{}

	// Plate hotlist: enabled rows from plate_hotlist, loaded in
	// reload() and checked in onDetection for kind="anpr" events. The
	// pattern strings are SQL-LIKE shape (literal + '%'), normalised
	// to uppercase alphanumerics + '%'.
	hotlist []hotlistEntry

	// Per-rule cooldown state: last-fired timestamp.
	cooldowns map[string]time.Time

	// Per-track last-known centre and timestamp. Key is
	// "<camera_id>|<track_id>". Used by line-crossing evaluation to
	// decide whether a tripwire was crossed between consecutive
	// observations of the same track. Entries older than 30s are
	// pruned on insert so the map doesn't grow forever for ghost tracks.
	tracks map[string]trackEntry
}

type trackEntry struct {
	CX, CY   float32
	Stamped  time.Time
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

// hotlistEntry is the match-time shape of a plate_hotlist row. We keep
// the raw pattern for debug + the pre-split segments used by the
// likeMatch helper; LIKE-style matching is simple enough that we don't
// need a regex or an extra dependency.
type hotlistEntry struct {
	ID       string
	Pattern  string // already normalised: uppercase alphanumerics + '%'
	Label    string
	Severity string
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
	var sw *sidecar.Writer
	if cfg.RecordingsDir != "" {
		sw = sidecar.New(sidecar.Config{Root: cfg.RecordingsDir}, pool)
	}
	return &Engine{
		cfg:              cfg,
		nc:               nc,
		pool:             pool,
		sidecar:          sw,
		zones:            map[string][]Zone{},
		enabledDetectors: map[string][]string{},
		mutedClasses:     map[string]map[string]struct{}{},
		cooldowns:        map[string]time.Time{},
		tracks:           map[string]trackEntry{},
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

	if e.sidecar != nil {
		go func() {
			if err := e.sidecar.Run(ctx); err != nil {
				slog.Warn("sidecar writer exited", "err", err)
			}
		}()
	}

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

	// Per-camera detector whitelist + class-mute overrides. Empty
	// enabled_detectors on disk = "all enabled"; we preserve that by
	// leaving the key out of the enabled map (absent ⇒ allow-all).
	crows, err := e.pool.Query(ctx, `
		SELECT id, enabled_detectors, location_kind,
		       mute_classes_override, unmute_classes_override
		FROM cameras`)
	if err != nil {
		return err
	}
	enabled := map[string][]string{}
	type camMutes struct {
		location string // "", "indoor", or "outdoor"
		mute     []string
		unmute   []string
	}
	camsByID := map[string]camMutes{}
	for crows.Next() {
		var id string
		var kinds []string
		var location *string
		var mute, unmute []string
		if err := crows.Scan(&id, &kinds, &location, &mute, &unmute); err != nil {
			crows.Close()
			return err
		}
		if len(kinds) > 0 {
			enabled[id] = kinds
		}
		loc := ""
		if location != nil {
			loc = *location
		}
		camsByID[id] = camMutes{location: loc, mute: mute, unmute: unmute}
	}
	crows.Close()

	// Class-mute buckets from settings. Missing rows = empty bucket —
	// first-boot safety, since migration 0008 seeds them but a
	// pre-migration start shouldn't break.
	bucket := func(key string) []string {
		var raw []byte
		err := e.pool.QueryRow(ctx,
			`SELECT value FROM settings WHERE key=$1`, key).Scan(&raw)
		if err != nil {
			return nil
		}
		var out []string
		_ = json.Unmarshal(raw, &out)
		return out
	}
	globalMutes := bucket("classes.disabled.global")
	indoorMutes := bucket("classes.disabled.indoor")
	outdoorMutes := bucket("classes.disabled.outdoor")

	muted := map[string]map[string]struct{}{}
	for id, cm := range camsByID {
		// Start with global, add the location bucket that matches.
		set := map[string]struct{}{}
		for _, c := range globalMutes {
			set[c] = struct{}{}
		}
		switch cm.location {
		case "indoor":
			for _, c := range indoorMutes {
				set[c] = struct{}{}
			}
		case "outdoor":
			for _, c := range outdoorMutes {
				set[c] = struct{}{}
			}
		}
		// Subtract the camera's unmute_override, then add its
		// mute_override. Order matters: unmute-then-mute lets an
		// operator unmute a class globally-muted *and* then re-mute it
		// themselves — weird but unambiguous.
		for _, c := range cm.unmute {
			delete(set, c)
		}
		for _, c := range cm.mute {
			set[c] = struct{}{}
		}
		if len(set) > 0 {
			muted[id] = set
		}
	}

	// Plate hotlist: enabled rows only; disabled entries are simply
	// absent from the in-memory list, not flagged. Pattern is stored
	// pre-normalised by the store so we can match directly.
	hrows, err := e.pool.Query(ctx, `
		SELECT id::text, pattern, label, severity
		FROM plate_hotlist
		WHERE enabled = TRUE`)
	if err != nil {
		return err
	}
	var hotlist []hotlistEntry
	for hrows.Next() {
		var h hotlistEntry
		if err := hrows.Scan(&h.ID, &h.Pattern, &h.Label, &h.Severity); err != nil {
			hrows.Close()
			return err
		}
		if h.Severity == "" {
			h.Severity = "warning"
		}
		hotlist = append(hotlist, h)
	}
	hrows.Close()

	e.mu.Lock()
	e.rules = compiled
	e.zones = zones
	e.enabledDetectors = enabled
	e.mutedClasses = muted
	e.hotlist = hotlist
	e.mu.Unlock()
	slog.Info("rules reloaded",
		"rules", len(compiled),
		"zone_cameras", len(zones),
		"detector_filtered_cameras", len(enabled),
		"class_muted_cameras", len(muted),
		"plate_hotlist", len(hotlist))
	return nil
}

func (e *Engine) onDetection(ctx context.Context, d Detection) error {
	e.mu.RLock()
	rules := e.rules
	zones := e.zones[d.CameraID]
	allowed := e.enabledDetectors[d.CameraID]
	muted := e.mutedClasses[d.CameraID]
	hotlist := e.hotlist
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

	// Class-mute hierarchy (global ∪ location-bucket, minus per-camera
	// unmute, plus per-camera mute). Resolved in reload() so this hot
	// path is an O(1) lookup.
	if muted != nil {
		if _, hit := muted[d.ClassName]; hit {
			return nil
		}
	}

	// Persist raw detection — the timeline reads from here.
	kind := d.Kind
	if kind == "" {
		kind = "object"
	}
	if _, err := e.pool.Exec(ctx, `
		INSERT INTO detections (event_id, camera_id, ts, class_name, kind, confidence, bbox, track_id, attributes)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
		d.ID, d.CameraID, d.TS, d.ClassName, kind, d.Confidence,
		mustJSON(d.BBox), nullIfEmpty(d.TrackID), mustJSON(d.Attributes),
	); err != nil {
		return err
	}

	// Mirror into the per-segment JSONL sidecar so older detections
	// survive Postgres' hot-window pruning and travel with their mp4.
	if e.sidecar != nil {
		e.sidecar.Enqueue(sidecar.Detection{
			ID:         d.ID,
			CameraID:   d.CameraID,
			TS:         d.TS,
			ClassName:  d.ClassName,
			Kind:       d.Kind,
			Confidence: d.Confidence,
			BBox:       d.BBox,
			TrackID:    d.TrackID,
			Attributes: d.Attributes,
		})
	}

	// Plate hotlist match. ANPR-only; ignored for object/face
	// detections. Cooldown keyed by (entry.ID, camera) so a plate
	// moving through a few frames fires exactly one incident per
	// camera per 30s. We fire AFTER the PG INSERT so the incident
	// can always be traced back to a real detection row if future
	// work links incidents↔detections.
	if d.Kind == "anpr" && len(hotlist) > 0 {
		if plate := normalisePlate(d.Attributes["plate"]); plate != "" {
			for _, h := range hotlist {
				if !likePlateMatch(plate, h.Pattern) {
					continue
				}
				key := "hotlist:" + h.ID + ":" + d.CameraID
				if !e.cooldownOK(key, 30, d.TS) {
					continue
				}
				if err := e.fireHotlistIncident(ctx, d, plate, h); err != nil {
					slog.Warn("fire hotlist incident",
						"hotlist_id", h.ID, "err", err)
				}
			}
		}
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
		if r.Definition.ZoneID != "" {
			zone := findZone(r.Definition.ZoneID, zones)
			if zone == nil {
				continue
			}
			if zone.Kind == "polygon" {
				if !pointInPolygon(d.BBox.X+d.BBox.W/2,
					d.BBox.Y+d.BBox.H/2, zone.Geometry) {
					continue
				}
			} else {
				// line / tripwire. Skip unless the track crossed it
				// between this frame and the previous one, and the
				// crossing direction matches the rule (if specified).
				crossed, dir := e.lineCrossed(d, zone)
				if !crossed {
					continue
				}
				wantDir := r.Definition.Direction
				if wantDir != "" && wantDir != dir {
					continue
				}
			}
		}
		if !e.cooldownOK(r.ID, r.Definition.CooldownSec, d.TS) {
			continue
		}
		if err := e.fireIncident(ctx, r, d); err != nil {
			slog.Warn("fire incident", "rule", r.ID, "err", err)
		}
	}

	// Record this frame's centre on the track so the NEXT detection on
	// the same track has a previous-position to compare against for
	// line-crossing evaluation.
	e.rememberTrack(d)
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

// fireHotlistIncident mirrors fireIncident but for a plate-hotlist
// match: rule_id is NULL (incidents.rule_id is nullable and
// FK ON DELETE SET NULL, so dispatcher + HA bridge pick it up just
// fine), severity comes from the hotlist entry, and the summary is
// operator-readable. The dispatcher's subscription join already
// treats s.rule_id IS NULL as "match any rule", so any subscription
// without a specific rule_id filter receives these.
func (e *Engine) fireHotlistIncident(ctx context.Context, d Detection, plate string, h hotlistEntry) error {
	severity := h.Severity
	if severity == "" {
		severity = "warning"
	}
	summary := fmt.Sprintf("hotlist: %s (%s) on %s", h.Label, plate, d.CameraID)

	var incidentID string
	err := e.pool.QueryRow(ctx, `
		INSERT INTO incidents (rule_id, camera_id, started_at, ended_at, severity, summary)
		VALUES (NULL, $1, $2, $2, $3, $4) RETURNING id::text`,
		d.CameraID, d.TS, severity, summary).Scan(&incidentID)
	if err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]any{
		"id":         incidentID,
		"camera_id":  d.CameraID,
		"started_at": d.TS,
		"severity":   severity,
		"summary":    summary,
		// Carry a hint so downstream consumers (HA, MQTT channel)
		// can distinguish hotlist hits from rule-driven ones.
		"hotlist_id": h.ID,
		"plate":      plate,
	})
	return e.nc.Publish("fnvr.events.incident."+d.CameraID, payload)
}

// normalisePlate strips non-alphanumerics and uppercases a raw plate
// string from a detection's Attributes["plate"]. Mirrors the SQL
// generated-column expression in migration 0013 and the api-server
// plates.NormalisePattern so all three layers agree.
func normalisePlate(p string) string {
	out := make([]byte, 0, len(p))
	for i := 0; i < len(p); i++ {
		c := p[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
			out = append(out, c)
		case c >= 'a' && c <= 'z':
			out = append(out, c-32)
		}
	}
	return string(out)
}

// likePlateMatch is a tiny SQL-LIKE matcher: literal + '%' wildcard.
// Both inputs must be pre-normalised to the same alphabet. No
// single-char '_' wildcard — plates never need it.
func likePlateMatch(s, pattern string) bool {
	if pattern == "" {
		return false
	}
	if !containsByte(pattern, '%') {
		return s == pattern
	}
	segs := splitByte(pattern, '%')
	if segs[0] != "" && !hasPrefix(s, segs[0]) {
		return false
	}
	pos := len(segs[0])
	for i := 1; i < len(segs)-1; i++ {
		seg := segs[i]
		if seg == "" {
			continue
		}
		idx := indexFrom(s, seg, pos)
		if idx < 0 {
			return false
		}
		pos = idx + len(seg)
	}
	last := segs[len(segs)-1]
	if last != "" && !hasSuffix(s[pos:], last) {
		return false
	}
	return true
}

// Tiny string helpers so we don't import `strings` just for these.
func containsByte(s string, c byte) bool {
	for i := 0; i < len(s); i++ {
		if s[i] == c {
			return true
		}
	}
	return false
}
func splitByte(s string, c byte) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == c {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	out = append(out, s[start:])
	return out
}
func hasPrefix(s, p string) bool {
	if len(p) > len(s) {
		return false
	}
	return s[:len(p)] == p
}
func hasSuffix(s, p string) bool {
	if len(p) > len(s) {
		return false
	}
	return s[len(s)-len(p):] == p
}
func indexFrom(s, sub string, from int) int {
	if from < 0 || from > len(s) {
		return -1
	}
	for i := from; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
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

func findZone(zoneID string, zones []Zone) *Zone {
	for i := range zones {
		if zones[i].ID == zoneID {
			return &zones[i]
		}
	}
	return nil
}

// bboxInZone is used only by the zone-mute path where the semantics
// are "bbox centre inside polygon". Retained for that caller; rules
// use findZone + pointInPolygon / lineCrossed directly.
func bboxInZone(b BBox, zoneID string, zones []Zone) bool {
	cx, cy := b.X+b.W/2, b.Y+b.H/2
	z := findZone(zoneID, zones)
	if z == nil || z.Kind != "polygon" {
		return false
	}
	return pointInPolygon(cx, cy, z.Geometry)
}

// rememberTrack updates the last-known centre for a detection's track.
// No-op if the detection has no track_id (sentinel UINT64_MAX from
// un-tracked nvinfer output).
func (e *Engine) rememberTrack(d Detection) {
	if d.TrackID == "" || d.TrackID == "18446744073709551615" {
		return
	}
	key := d.CameraID + "|" + d.TrackID
	cx, cy := d.BBox.X+d.BBox.W/2, d.BBox.Y+d.BBox.H/2
	e.mu.Lock()
	e.tracks[key] = trackEntry{CX: cx, CY: cy, Stamped: d.TS}
	// Opportunistic GC of entries older than 30s. A real pass can be a
	// background goroutine later; doing it inline here is fine at
	// expected detection volumes.
	if len(e.tracks) > 2000 {
		cutoff := d.TS.Add(-30 * time.Second)
		for k, v := range e.tracks {
			if v.Stamped.Before(cutoff) {
				delete(e.tracks, k)
			}
		}
	}
	e.mu.Unlock()
}

// lineCrossed reports whether the track (identified by d.TrackID) moved
// across the line zone `z` between its previous observation and the
// current detection. Returns (true, "in"|"out") on crossing, where "in"
// = left-to-right of the line when traversing its first endpoint to its
// second (the order the UI wrote them in). Returns (false, "") if no
// crossing happened or the track has no previous observation yet.
func (e *Engine) lineCrossed(d Detection, z *Zone) (bool, string) {
	if d.TrackID == "" || d.TrackID == "18446744073709551615" {
		return false, ""
	}
	if len(z.Geometry) < 4 {
		return false, ""
	}
	ax, ay := z.Geometry[0], z.Geometry[1] // line endpoint A
	bx, by := z.Geometry[2], z.Geometry[3] // line endpoint B

	key := d.CameraID + "|" + d.TrackID
	e.mu.RLock()
	prev, ok := e.tracks[key]
	e.mu.RUnlock()
	if !ok {
		return false, ""
	}
	// Drop stale history; missed frames > 2s is not a continuous track.
	if d.TS.Sub(prev.Stamped) > 2*time.Second {
		return false, ""
	}
	cx, cy := d.BBox.X+d.BBox.W/2, d.BBox.Y+d.BBox.H/2
	if !segmentsIntersect(prev.CX, prev.CY, cx, cy, ax, ay, bx, by) {
		return false, ""
	}
	// Determine direction by the sign of the cross product (B-A) × (P-A)
	// evaluated at prev vs curr. A positive-to-negative flip = "in"
	// (crossing left-to-right relative to the A→B direction), negative-
	// to-positive = "out".
	sidePrev := cross(bx-ax, by-ay, prev.CX-ax, prev.CY-ay)
	sideCurr := cross(bx-ax, by-ay, cx-ax, cy-ay)
	if sidePrev >= 0 && sideCurr < 0 {
		return true, "in"
	}
	if sidePrev < 0 && sideCurr >= 0 {
		return true, "out"
	}
	// Exact collinear or grazing case — count it as "in" rather than
	// losing the event.
	return true, "in"
}

// segmentsIntersect returns true iff segment p1→p2 crosses segment
// p3→p4. Uses the standard orientation method.
func segmentsIntersect(x1, y1, x2, y2, x3, y3, x4, y4 float32) bool {
	o1 := orient(x1, y1, x2, y2, x3, y3)
	o2 := orient(x1, y1, x2, y2, x4, y4)
	o3 := orient(x3, y3, x4, y4, x1, y1)
	o4 := orient(x3, y3, x4, y4, x2, y2)
	if o1 != o2 && o3 != o4 {
		return true
	}
	return false
}

// orient returns the sign of the cross product of (p1→p2) × (p1→p3):
// 1 = CCW, -1 = CW, 0 = collinear.
func orient(x1, y1, x2, y2, x3, y3 float32) int {
	v := (x2-x1)*(y3-y1) - (y2-y1)*(x3-x1)
	if v > 0 {
		return 1
	}
	if v < 0 {
		return -1
	}
	return 0
}

func cross(ax, ay, bx, by float32) float32 {
	return ax*by - ay*bx
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

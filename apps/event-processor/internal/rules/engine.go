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
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"math/bits"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"

	"github.com/fnvr/fnvr/apps/event-processor/internal/metrics"
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

	// Enrolled face embeddings joined with person metadata. Reload()
	// fetches the current snapshot every 30s. Match at detection
	// time is a cosine-similarity scan over this slice; at operator
	// scale (tens to low hundreds of embeddings) a brute force scan
	// costs ~50µs per face detection — cheaper than anything
	// fancier to maintain.
	faceEnrolments   []enrolledEmbedding
	faceMatchThresh  float64
	// faceMarginThresh is the minimum gap between the top-scoring
	// person and the runner-up before a multi-person match is
	// accepted. Prevents an ambiguous probe from matching either of
	// two similar-looking enrolled people. Skipped when the pool
	// contains only one person. Default 0.05.
	faceMarginThresh float64
	// Dismissed (not-a-face / duplicate) embeddings used to penalise
	// false-positive matches at scoring time. Previously applied as a
	// score haircut at every threshold comparison, which was lethal on
	// a noisy negatives pool. Now applied as a late veto: only a
	// probe that both clears the threshold AND lands close to a known
	// negative is retracted.
	faceNegatives       []dismissedEmbedding
	negPenaltyWeight    float64

	// Object-flag suppression library. Keyed as
	//   objectFlags[camera_id][class_original] = []phash
	// so the per-detection check is an O(1) map lookup + a short
	// linear Hamming scan (typical branch length single digits even on
	// busy setups). Reloaded every 30 s from object_flags WHERE
	// dismissed_at IS NULL.
	objectFlags   map[string]map[string][]uint64
	phashHamming  int // setting detections.suppression_hamming_threshold

	// Per-rule cooldown state: last-fired timestamp.
	cooldowns map[string]time.Time

	// Per-track last-known centre and timestamp. Key is
	// "<camera_id>|<track_id>". Used by line-crossing evaluation to
	// decide whether a tripwire was crossed between consecutive
	// observations of the same track. Entries older than 30s are
	// pruned on insert so the map doesn't grow forever for ghost tracks.
	tracks map[string]trackEntry

	// Per-(rule,step) rolling sighting log for cross-camera sequence
	// rules. Key is "<rule_id>|<step_idx>", value is timestamped
	// sightings kept for up to the rule's window. Pruned lazily on
	// each evaluation for that rule/step so the map stays bounded.
	sequenceSightings map[string][]sequenceSighting

	// Global alarm state: "home" | "away" | "disarmed". Rules with an
	// active_when field only fire when their required state matches.
	// Seeded in reload() from settings.alarm.state, updated live via
	// fnvr.settings.alarm.changed so flipping the state from the UI
	// takes effect immediately rather than at the next 30 s reload.
	alarmState atomic.Value // string
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
	// Kind selects the rule flavour. Empty / "single" = the original
	// per-detection form (all fields below, minus Steps+WindowSec,
	// apply). "sequence" = cross-camera ordered-sightings rule; fields
	// Steps + WindowSec drive it, the top-level CameraID/Classes are
	// ignored. Leaving Kind absent preserves compatibility with every
	// existing rule row.
	Kind           string          `json:"kind,omitempty"`
	// CameraID is the legacy single-camera targeting field. New rules
	// written by the UI use CameraIDs instead. Both are honoured: the
	// rule matches a detection if the camera is in CameraIDs OR equals
	// CameraID. Empty CameraID + empty CameraIDs = all cameras.
	CameraID       string          `json:"camera_id,omitempty"`
	CameraIDs      []string        `json:"camera_ids,omitempty"` // subset; empty = defer to CameraID
	Classes        []string        `json:"classes"`             // e.g. ["person","car"]
	MinConfidence  float32         `json:"min_confidence"`
	ZoneID         string          `json:"zone_id,omitempty"`
	Direction      string          `json:"direction,omitempty"` // "in" | "out" | "" for both
	CooldownSec    int             `json:"cooldown_sec"`
	// MergeWindowSec controls how far back this rule looks for an
	// existing open incident on the same camera to merge into. The
	// merge target is the most recent incident on the camera within
	// the window — so this rule's firings will fold into incidents
	// originally opened by ANY rule on the same camera, not just
	// itself. Set:
	//   0  — use engine default (180s, 3 minutes)
	//  -1  — never merge; every detection past CooldownSec creates
	//        a fresh incident (legacy behaviour, useful for test rules)
	MergeWindowSec int             `json:"merge_window_sec,omitempty"`
	Schedule       Schedule        `json:"schedule"`
	Severity       string          `json:"severity"` // info | warning | critical
	// ActiveWhen gates the rule on the global alarm state:
	//   ""        or "any" — fires regardless of state (default)
	//   "home"    — only when alarm is home
	//   "away"    — only when alarm is away
	//   "disarmed" — only when alarm is disarmed
	ActiveWhen     string          `json:"active_when,omitempty"`
	// Sequence-rule fields. Ignored unless Kind=="sequence".
	Steps          []SequenceStep  `json:"steps,omitempty"`
	WindowSec      int             `json:"window_sec,omitempty"`
}

// ruleMatchesAlarmState reports whether a rule's active_when field
// permits firing given the current global alarm state. Empty or "any"
// means fires regardless; otherwise the field must equal the state.
func ruleMatchesAlarmState(def *RuleDef, state string) bool {
	if def.ActiveWhen == "" || def.ActiveWhen == "any" {
		return true
	}
	return def.ActiveWhen == state
}

// currentAlarmState returns the cached global alarm state, defaulting
// to "disarmed" if the atomic hasn't been populated yet (pre-reload).
func (e *Engine) currentAlarmState() string {
	v := e.alarmState.Load()
	if v == nil {
		return "disarmed"
	}
	s, ok := v.(string)
	if !ok || s == "" {
		return "disarmed"
	}
	return s
}

// ruleMatchesCamera reports whether a single-camera rule targets the
// given camera. Empty CameraID + empty CameraIDs = all cameras.
// Otherwise the rule matches if the camera is in CameraIDs or equals
// CameraID (legacy scalar).
func ruleMatchesCamera(def *RuleDef, cameraID string) bool {
	if len(def.CameraIDs) == 0 && def.CameraID == "" {
		return true
	}
	if def.CameraID != "" && def.CameraID == cameraID {
		return true
	}
	for _, id := range def.CameraIDs {
		if id == cameraID {
			return true
		}
	}
	return false
}

// SequenceStep is one hop in a cross-camera sequence rule. The
// engine requires a sighting matching every step, in order, within
// WindowSec seconds from first to last step. Per-hop filter is the
// intersection of (camera_id) + (classes, if non-empty) + min_confidence.
type SequenceStep struct {
	CameraID      string   `json:"camera_id"`
	Classes       []string `json:"classes,omitempty"`
	MinConfidence float32  `json:"min_confidence,omitempty"`
}

type Schedule struct {
	StartMinute int    `json:"start_minute"` // 0..1439 (minute of day)
	EndMinute   int    `json:"end_minute"`
	Days        []int  `json:"days"` // 0=Sun..6=Sat; empty = all days
	Timezone    string `json:"timezone,omitempty"`
}

type compiledRule struct {
	Rule
	classes  map[string]struct{}
	// sequence is nil for single-camera rules. Populated only when
	// reload() parses a Kind=="sequence" rule with at least two steps.
	sequence *compiledSequence
}

// compiledSequence holds the parsed step list + window duration for a
// cross-camera rule. steps[i].classes is pre-lowered into a set for
// O(1) membership checks in onDetection.
type compiledSequence struct {
	steps  []compiledSequenceStep
	window time.Duration
}

type compiledSequenceStep struct {
	cameraID      string
	classes       map[string]struct{} // empty set = match any
	minConfidence float32
}

// sequenceSighting records that a sequence rule's step N has been
// matched for a given detection. Kept in Engine.sequenceSightings for
// up to the rule's window so a later step can look back and confirm
// the chain. trackKey is retained for future per-track re-ID — not
// used in slice 1.
type sequenceSighting struct {
	ts       time.Time
	trackKey string
}

// DriftAlert is the payload ml-worker publishes to fnvr.alerts.drift
// when the weekly face-embedding self-match check drops more than
// _DRIFT_THRESHOLD below the baseline. Event-processor turns this
// into a system-scope incident (rule_id=NULL, camera_id=NULL).
type DriftAlert struct {
	At       time.Time `json:"at"`
	Current  float64   `json:"current"`
	Baseline float64   `json:"baseline"`
	Delta    float64   `json:"delta"`
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

// enrolledEmbedding is a pgvector-backed face embedding pre-joined
// with the owning person's label + alert flag. The vector is stored
// L2-normalised so cosine similarity == dot product (cheap).
type enrolledEmbedding struct {
	PersonID     string
	Label        string
	AlertOnMatch bool
	Vector       []float32 // normalised, len=512
}

// dismissedEmbedding is an operator-flagged false-positive (or
// near-duplicate) kept so the matcher can score penalised.
type dismissedEmbedding struct {
	Vector []float32 // normalised, len=512
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
		cooldowns:         map[string]time.Time{},
		tracks:            map[string]trackEntry{},
		sequenceSightings: map[string][]sequenceSighting{},
		objectFlags:       map[string]map[string][]uint64{},
		phashHamming:      8,
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

	// Live alarm-state updates from api-server. reload() also reads
	// the same key so a missed NATS message on startup can't leave the
	// engine stuck on a stale state.
	_, err = e.nc.Subscribe("fnvr.settings.alarm.changed", func(msg *nats.Msg) {
		var a struct {
			State string `json:"state"`
		}
		if err := json.Unmarshal(msg.Data, &a); err != nil {
			slog.Warn("bad alarm state payload", "err", err)
			return
		}
		if a.State == "" {
			return
		}
		e.alarmState.Store(a.State)
		slog.Info("alarm state updated", "state", a.State)
	})
	if err != nil {
		return err
	}

	// Drift alerts from ml-worker (weekly self-match check on the
	// enrolled embeddings). Turn each alert into a system-scope
	// incident; the notification dispatcher fans it out to any
	// channel that isn't pinned to a specific camera.
	_, err = e.nc.Subscribe("fnvr.alerts.drift", func(msg *nats.Msg) {
		var a DriftAlert
		if err := json.Unmarshal(msg.Data, &a); err != nil {
			slog.Warn("bad drift alert", "err", err)
			return
		}
		if err := e.fireDriftIncident(ctx, a); err != nil {
			slog.Warn("fire drift incident", "err", err)
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
	reloadStart := time.Now()
	defer func() {
		metrics.ReloadDuration.Observe(time.Since(reloadStart).Seconds())
	}()
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
		cr := compiledRule{Rule: r, classes: cls}
		if r.Definition.Kind == "sequence" {
			seq, serr := compileSequence(r.Definition)
			if serr != nil {
				slog.Warn("bad sequence rule", "id", r.ID, "err", serr)
				continue
			}
			cr.sequence = seq
		}
		compiled = append(compiled, cr)
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

	// Face enrolments: join face_embeddings with persons, only
	// enabled persons. The embedding column comes back as pgvector's
	// text form "[v0,v1,...]" which we parse into []float32 and then
	// L2-normalise so cosine similarity becomes a dot product.
	enrols, err := e.loadFaceEnrolments(ctx)
	if err != nil {
		return err
	}

	// Face match threshold — cosine-similarity floor. Default 0.4 if
	// the setting is missing. On this codebase the recommended value
	// after the top-K overhaul is 0.32 — lower because the score is
	// now a mean over the top-3 matches, so a probe doesn't need a
	// single near-perfect hit to clear the bar. Reload every cycle
	// so the operator can tune it live without restarting anything.
	thresh := loadFaceThreshold(ctx, e.pool)

	// Multi-person match margin — how much the winning person's
	// top-K score must exceed the runner-up's before a match is
	// accepted when more than one person is enrolled. Skipped when
	// only one person exists in the pool.
	margin := loadFaceMargin(ctx, e.pool)

	// Dismissed embeddings + their penalty weight. Missing table /
	// missing setting degrade gracefully to "no penalty".
	negs, err := e.loadFaceNegatives(ctx)
	if err != nil {
		return err
	}
	penaltyWeight := loadNegPenaltyWeight(ctx, e.pool)

	// Object-flag suppression library. Loaded from object_flags WHERE
	// dismissed_at IS NULL. Missing table = empty library.
	flagLib, flagCount, err := e.loadObjectFlags(ctx)
	if err != nil {
		return err
	}
	phashHamming := loadPHashHamming(ctx, e.pool)

	e.mu.Lock()
	e.rules = compiled
	e.zones = zones
	e.enabledDetectors = enabled
	e.mutedClasses = muted
	e.hotlist = hotlist
	e.faceEnrolments = enrols
	e.faceMatchThresh = thresh
	e.faceMarginThresh = margin
	e.faceNegatives = negs
	e.negPenaltyWeight = penaltyWeight
	e.objectFlags = flagLib
	e.phashHamming = phashHamming
	e.mu.Unlock()

	// Alarm state from settings.alarm.state. Falls back to "disarmed"
	// if the key is absent (fresh install) or malformed. This path is
	// the backstop: the live NATS subscriber updates the atomic on
	// each UI-driven change, but if the api-server was down when the
	// flip happened or the key was edited directly in psql, reload()
	// still catches up within the 30 s poll window.
	alarmState := "disarmed"
	{
		var raw []byte
		if err := e.pool.QueryRow(ctx,
			`SELECT value FROM settings WHERE key = 'alarm.state'`).Scan(&raw); err == nil {
			var obj struct{ State string `json:"state"` }
			if jerr := json.Unmarshal(raw, &obj); jerr == nil && obj.State != "" {
				alarmState = obj.State
			}
		}
	}
	e.alarmState.Store(alarmState)
	metrics.RulesLoaded.Set(float64(len(compiled)))
	metrics.EnrolledEmbeddings.Set(float64(len(enrols)))
	metrics.FaceNegatives.Set(float64(len(negs)))
	metrics.ObjectFlagsLoaded.Set(float64(flagCount))
	slog.Info("rules reloaded",
		"rules", len(compiled),
		"zone_cameras", len(zones),
		"detector_filtered_cameras", len(enabled),
		"class_muted_cameras", len(muted),
		"plate_hotlist", len(hotlist),
		"face_enrolments", len(enrols),
		"face_threshold", thresh,
		"face_margin", margin,
		"face_negatives", len(negs),
		"neg_penalty_weight", penaltyWeight,
		"object_flags", flagCount,
		"phash_hamming", phashHamming,
		"alarm_state", e.currentAlarmState())
	return nil
}

func (e *Engine) onDetection(ctx context.Context, d Detection) error {
	kindLabel := d.Kind
	if kindLabel == "" {
		kindLabel = "object"
	}
	metrics.DetectionsProcessed.WithLabelValues(d.CameraID, kindLabel).Inc()
	e.mu.RLock()
	rules := e.rules
	zones := e.zones[d.CameraID]
	allowed := e.enabledDetectors[d.CameraID]
	muted := e.mutedClasses[d.CameraID]
	hotlist := e.hotlist
	faceEnrolments := e.faceEnrolments
	faceThresh := e.faceMatchThresh
	faceMargin := e.faceMarginThresh
	faceNegatives := e.faceNegatives
	negPenaltyW := e.negPenaltyWeight
	objectFlagsByClass := e.objectFlags[d.CameraID]
	phashHamming := e.phashHamming
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

	// Object-flag suppression. If the operator has flagged a visually
	// similar bbox on this same camera with the same class as a false
	// positive, drop the detection before it reaches persistence,
	// SSE, or rule evaluation. Match is pHash Hamming distance on the
	// 64-bit bbox-crop perceptual hash; cost is a handful of XORs +
	// popcounts per detection. Only runs when:
	//   - the detection is an "object" kind (not face / anpr),
	//   - there are active flags for this (camera, class) pair, and
	//   - the pipeline emitted a `phash` attribute on the detection.
	if len(objectFlagsByClass) > 0 {
		if phashes, ok := objectFlagsByClass[d.ClassName]; ok && len(phashes) > 0 {
			if hashStr := d.Attributes["phash"]; hashStr != "" {
				if probe, ok := parsePHash(hashStr); ok {
					for _, flagHash := range phashes {
						if bits.OnesCount64(probe^flagHash) <= phashHamming {
							slog.Debug("suppressed by flag",
								"camera", d.CameraID,
								"class", d.ClassName,
								"phash", hashStr)
							metrics.DetectionsSuppressed.
								WithLabelValues(d.CameraID, d.ClassName).Inc()
							return nil
						}
					}
				}
			}
		}
	}

	// Face match — for kind="face" detections with an embedding in
	// attributes. Scoring is adaptive top-K mean per person: the
	// matcher averages each person's three most-similar enrolment
	// cosines against the probe, picks the person with the highest
	// mean, and accepts when that mean clears the threshold. With
	// multiple enrolled persons the runner-up must be at least
	// faceMargin behind, so an ambiguous probe matches neither.
	//
	// Top-K mean replaces a plain best-of-N to reward probes that
	// look like several of a person's enrolments, not just one —
	// diverse same-person pools (different poses, lighting) become
	// assets instead of a single rogue embedding defining a match.
	//
	// Negative penalty is applied as a late veto: a probe that
	// clears the threshold but also lands close to a known
	// dismissed embedding is retracted. This is less aggressive
	// than the previous "subtract at scoring time" path which made
	// the system unmatchable on a noisy negatives pool.
	var matchedPerson enrolledEmbedding
	var matchedSim float32
	if d.Kind == "face" && len(faceEnrolments) > 0 {
		if raw := d.Attributes["embedding"]; raw != "" {
			probe := decodeEmbeddingBase64(raw)
			if probe != nil {
				// Group similarities by person.
				simsByPerson := map[string][]float32{}
				labelByPerson := map[string]enrolledEmbedding{}
				for i := range faceEnrolments {
					enrol := faceEnrolments[i]
					s := cosineSim(probe, enrol.Vector)
					simsByPerson[enrol.PersonID] = append(simsByPerson[enrol.PersonID], s)
					labelByPerson[enrol.PersonID] = enrol
				}

				type personScore struct {
					label enrolledEmbedding
					topK  float32 // mean of the top-3 cosines (or best-of-N when pool < 3)
				}
				scores := make([]personScore, 0, len(simsByPerson))
				for pid, sims := range simsByPerson {
					sort.Slice(sims, func(i, j int) bool { return sims[i] > sims[j] })
					k := 3
					if len(sims) < k {
						k = len(sims)
					}
					var sum float32
					for i := 0; i < k; i++ {
						sum += sims[i]
					}
					scores = append(scores, personScore{
						label: labelByPerson[pid],
						topK:  sum / float32(k),
					})
				}
				sort.Slice(scores, func(i, j int) bool { return scores[i].topK > scores[j].topK })

				// Adaptive acceptance. Single-person pool: just clear
				// the threshold. Multi-person: also require a margin
				// over the runner-up so ambiguity doesn't resolve into
				// a false match.
				accept := false
				if len(scores) > 0 && float64(scores[0].topK) >= faceThresh {
					if len(scores) == 1 || float64(scores[0].topK-scores[1].topK) >= faceMargin {
						accept = true
					}
				}

				// Late negative veto: if the probe is highly similar to
				// a known dismissed embedding, withdraw the match.
				if accept && negPenaltyW > 0 && len(faceNegatives) > 0 {
					var negSim float32
					for i := range faceNegatives {
						s := cosineSim(probe, faceNegatives[i].Vector)
						if s > negSim {
							negSim = s
						}
					}
					if float64(scores[0].topK-float32(negPenaltyW)*negSim) < faceThresh {
						accept = false
					}
				}

				if accept {
					matchedPerson = scores[0].label
					matchedSim = scores[0].topK
				}
			}
		}
	}
	// Rewrite attributes on a face detection. Keep the raw embedding
	// either way so the per-person matches view can let an operator
	// flag a mis-matched tile as "not a face" (which records the
	// embedding as a negative for future penalty scoring). Previously
	// matched rows lost the blob; bloat is tolerable (~2KB/row) and
	// hot-table retention trims it anyway.
	if d.Kind == "face" {
		if matchedPerson.PersonID != "" {
			d.Attributes["person"] = matchedPerson.Label
			d.Attributes["person_id"] = matchedPerson.PersonID
			d.Attributes["similarity"] = strconv.FormatFloat(float64(matchedSim), 'f', 3, 32)
		} else {
			// Keep embedding so the enrolment UI can pick it up, plus
			// a short hash for de-duping the "recent faces" grid.
			if emb := d.Attributes["embedding"]; emb != "" {
				// Hash the first 64 chars of base64 — cheap and
				// distinguishing enough.
				end := len(emb)
				if end > 64 {
					end = 64
				}
				d.Attributes["embedding_hash"] = strconv.FormatUint(fnv64(emb[:end]), 16)
			}
		}
	}

	// Persist raw detection — the timeline reads from here.
	kind := d.Kind
	if kind == "" {
		kind = "object"
	}
	var pgID int64
	if err := e.pool.QueryRow(ctx, `
		INSERT INTO detections (event_id, camera_id, ts, class_name, kind, confidence, bbox, track_id, attributes)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		RETURNING id`,
		d.ID, d.CameraID, d.TS, d.ClassName, kind, d.Confidence,
		mustJSON(d.BBox), nullIfEmpty(d.TrackID), mustJSON(d.Attributes),
	).Scan(&pgID); err != nil {
		return err
	}

	// Republish the accepted detection on fnvr.events.detection_accepted.<cam>.
	// The api-server's SSE bus + the HA bridge consume THIS subject, not the
	// raw pipeline subject — that way suppressed detections never reach the
	// browser (before this, a user's flagged truck still appeared on the Live
	// view because api-server's SSE handler was subscribed to the pipeline
	// subject directly, bypassing the suppression decision). Adds the PG id
	// to the payload so the flag endpoint works without an event_id → id
	// lookup, closing the race where a click on a just-appeared bbox 404s
	// because the INSERT hadn't landed yet.
	if e.nc != nil {
		// Field naming is hand-wired rather than reusing Detection so
		// `id` can carry the event-id string (back-compat with old SSE
		// consumers) while `pg_id` carries the new PG int id. A single
		// struct couldn't do both with sane JSON tags.
		type acceptedPayload struct {
			PgID       int64             `json:"pg_id"`
			ID         string            `json:"id"`
			CameraID   string            `json:"camera_id"`
			TS         time.Time         `json:"ts"`
			ClassName  string            `json:"class_name"`
			Kind       string            `json:"kind"`
			Confidence float32           `json:"confidence"`
			BBox       BBox              `json:"bbox"`
			TrackID    string            `json:"track_id,omitempty"`
			Attributes map[string]string `json:"attributes,omitempty"`
		}
		ap := acceptedPayload{
			PgID:       pgID,
			ID:         d.ID,
			CameraID:   d.CameraID,
			TS:         d.TS,
			ClassName:  d.ClassName,
			Kind:       kind,
			Confidence: d.Confidence,
			BBox:       d.BBox,
			TrackID:    d.TrackID,
			Attributes: d.Attributes,
		}
		if buf, err := json.Marshal(ap); err == nil {
			_ = e.nc.Publish("fnvr.events.detection_accepted."+d.CameraID, buf)
		}
	}

	// Face thumbnail rename — the pipeline wrote a JPEG of the face
	// crop under {event_id}.jpg at detection time. Rename to the PG
	// row id so the api-server's thumbnail handler (keyed by PG id)
	// serves it straight from disk without another live-snapshot
	// crop. Best-effort: missing source file is fine (face_id off or
	// crop write raced), we just fall through to the api's live-
	// snapshot fallback.
	if kind == "face" && pgID > 0 && d.ID != "" {
		const dir = "/var/lib/fnvr/thumbs/faces/"
		src := dir + d.ID + ".jpg"
		dst := dir + strconv.FormatInt(pgID, 10) + ".jpg"
		if err := os.Rename(src, dst); err != nil && !os.IsNotExist(err) {
			slog.Warn("face thumb rename", "src", src, "err", err)
		}
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

	// Face-match incident. Parallel to the plate hotlist path: the
	// match was computed pre-INSERT; here we just decide whether to
	// escalate it into an incident when the person has alert_on_match
	// set. Cooldown keyed by (person_id, camera) — walking past the
	// same camera for 60 seconds should fire at most twice, not 60
	// times.
	if d.Kind == "face" && matchedPerson.PersonID != "" && matchedPerson.AlertOnMatch {
		key := "face:" + matchedPerson.PersonID + ":" + d.CameraID
		if e.cooldownOK(key, 30, d.TS) {
			if err := e.fireFaceIncident(ctx, d, matchedPerson, matchedSim); err != nil {
				slog.Warn("fire face incident",
					"person_id", matchedPerson.PersonID, "err", err)
			}
		}
	}

	for _, r := range rules {
		// Sequence rules are handled below; the per-detection loop
		// applies only to the original single-camera kind.
		if r.sequence != nil {
			continue
		}
		if !ruleMatchesCamera(&r.Definition, d.CameraID) {
			continue
		}
		if !ruleMatchesAlarmState(&r.Definition, e.currentAlarmState()) {
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

	// Cross-camera sequence rules. A detection can advance a sequence
	// AND fire a single-camera rule in the same tick; the two loops
	// are independent.
	for _, r := range rules {
		if r.sequence == nil {
			continue
		}
		if !ruleMatchesAlarmState(&r.Definition, e.currentAlarmState()) {
			continue
		}
		if !inSchedule(r.Definition.Schedule, d.TS) {
			continue
		}
		if err := e.evalSequence(ctx, r, d); err != nil {
			slog.Warn("eval sequence", "rule", r.ID, "err", err)
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

// defaultMergeWindow is the merge window applied to rules that
// don't override MergeWindowSec. Three minutes is long enough to
// fold "same actor still in frame" into one incident across the
// natural gaps between detections, short enough that distinct
// visits an hour apart stay distinct.
const defaultMergeWindow = 180 * time.Second

// fireIncident is the entry point used by the rule loop. It tries
// to fold this firing into an existing open incident on the same
// camera within the rule's merge window; if there's nothing to
// merge into, it creates a new incident. NATS publishing is split
// between the creation subject (drives notification dispatch — fires
// once per incident) and the update subject (UI-only, fires on
// every merge so the row's badges update without a refetch).
func (e *Engine) fireIncident(ctx context.Context, r compiledRule, d Detection) error {
	severity := r.Definition.Severity
	if severity == "" {
		severity = "info"
	}

	window := mergeWindowFor(r.Definition.MergeWindowSec)
	if window > 0 {
		if merged, err := e.tryMergeIncident(ctx, r, d, severity, window); err != nil {
			return err
		} else if merged {
			return nil
		}
	}
	return e.createIncident(ctx, r, d, severity)
}

// mergeWindowFor resolves the rule's MergeWindowSec into a duration.
// 0 means "use default", negative means "never merge".
func mergeWindowFor(secs int) time.Duration {
	switch {
	case secs == 0:
		return defaultMergeWindow
	case secs < 0:
		return 0
	default:
		return time.Duration(secs) * time.Second
	}
}

// tryMergeIncident does a single-statement UPDATE that finds the
// most recent incident on this camera within the merge window and
// folds the new detection into it: bumps last_detection_at + ended_at,
// increments detection_count, adds the class + rule_id to their
// respective sets if not already present, raises severity if the
// new firing's severity is higher.
//
// Returns (merged=true, nil) when an incident was updated, (false, nil)
// when there was nothing in the window to merge into, or (false, err)
// on a real DB error. The caller falls through to createIncident
// only on the (false, nil) path.
//
// Concurrency: two engine goroutines (or two rules firing in the
// same tick) can race to merge into the same incident. The
// UPDATE...WHERE id=(SELECT...LIMIT 1) is a single statement and
// runs atomically; the second writer's SELECT sees the
// already-bumped last_detection_at and merges into the now-current
// state. No double insert.
func (e *Engine) tryMergeIncident(ctx context.Context, r compiledRule,
	d Detection, severity string, window time.Duration) (bool, error) {
	cutoff := d.TS.Add(-window)

	var incidentID string
	err := e.pool.QueryRow(ctx, `
		UPDATE incidents
		   SET ended_at          = $1,
		       last_detection_at = $1,
		       detection_count   = detection_count + 1,
		       classes = CASE
		           WHEN $2 = ANY(classes) THEN classes
		           ELSE array_append(classes, $2)
		         END,
		       rule_ids = CASE
		           WHEN $3::uuid = ANY(rule_ids) THEN rule_ids
		           ELSE array_append(rule_ids, $3::uuid)
		         END,
		       severity = CASE
		           WHEN severity_rank($4) > severity_rank(severity)
		           THEN $4 ELSE severity
		         END
		 WHERE id = (
		     SELECT id FROM incidents
		      WHERE camera_id = $5
		        AND last_detection_at >= $6
		      ORDER BY last_detection_at DESC
		      LIMIT 1)
		RETURNING id::text`,
		d.TS, d.ClassName, r.ID, severity, d.CameraID, cutoff,
	).Scan(&incidentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}

	// Update — broadcast on the incident_update subject so the UI can
	// re-render the row. Notification dispatcher does NOT subscribe
	// to this subject — it would spam users with duplicate alerts.
	payload, _ := json.Marshal(map[string]any{
		"id":              incidentID,
		"camera_id":       d.CameraID,
		"class_added":     d.ClassName,
		"rule_added":      r.ID,
		"last_detection":  d.TS,
		"severity":        severity,
	})
	_ = e.nc.Publish("fnvr.events.incident_update."+d.CameraID, payload)
	metrics.IncidentsFired.WithLabelValues(severity, "merged").Inc()
	return true, nil
}

// createIncident inserts a fresh incidents row. Used both when the
// merge window is disabled and when no existing incident was found
// in the window. Publishes on the canonical creation subject so
// the notification dispatcher fans out once per real event.
func (e *Engine) createIncident(ctx context.Context, r compiledRule,
	d Detection, severity string) error {
	summary := fmt.Sprintf("%s on %s (%.0f%%)", d.ClassName, d.CameraID, d.Confidence*100)

	var incidentID string
	err := e.pool.QueryRow(ctx, `
		INSERT INTO incidents (rule_id, camera_id, started_at, ended_at,
		                       last_detection_at, detection_count,
		                       classes, rule_ids, severity, summary)
		VALUES ($1,$2,$3,$3,$3,1,ARRAY[$4]::TEXT[],ARRAY[$1]::UUID[],$5,$6)
		RETURNING id::text`,
		r.ID, d.CameraID, d.TS, d.ClassName, severity, summary,
	).Scan(&incidentID)
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
		"classes":    []string{d.ClassName},
	})
	metrics.IncidentsFired.WithLabelValues(severity, "object").Inc()
	return e.nc.Publish("fnvr.events.incident."+d.CameraID, payload)
}

// compileSequence parses a Kind=="sequence" rule definition into the
// engine's runtime shape. Validates shape enough to guarantee
// evalSequence never panics — deeper validation (e.g. camera existence)
// is the api-server's job at create-time. Returns an error on anything
// evalSequence couldn't sensibly interpret.
func compileSequence(def RuleDef) (*compiledSequence, error) {
	if len(def.Steps) < 2 {
		return nil, fmt.Errorf("sequence rule needs >=2 steps, got %d", len(def.Steps))
	}
	if def.WindowSec <= 0 {
		return nil, fmt.Errorf("sequence rule needs window_sec > 0")
	}
	out := &compiledSequence{
		steps:  make([]compiledSequenceStep, 0, len(def.Steps)),
		window: time.Duration(def.WindowSec) * time.Second,
	}
	for i, s := range def.Steps {
		if s.CameraID == "" {
			return nil, fmt.Errorf("sequence step %d missing camera_id", i)
		}
		cs := compiledSequenceStep{
			cameraID:      s.CameraID,
			minConfidence: s.MinConfidence,
		}
		if len(s.Classes) > 0 {
			cs.classes = make(map[string]struct{}, len(s.Classes))
			for _, c := range s.Classes {
				cs.classes[c] = struct{}{}
			}
		}
		out.steps = append(out.steps, cs)
	}
	return out, nil
}

// evalSequence advances a cross-camera sequence rule with the current
// detection. If d matches step i, record the sighting; if it's the
// final step AND every earlier step has a sighting within the rule's
// window, fire one incident (subject to the rule's cooldown).
func (e *Engine) evalSequence(ctx context.Context, r compiledRule, d Detection) error {
	seq := r.sequence
	// Identify which step(s) this detection matches. A rule that
	// visits the same camera twice could match multiple indices; we
	// advance each independently.
	matched := make([]int, 0, 1)
	for i, s := range seq.steps {
		if s.cameraID != d.CameraID {
			continue
		}
		if d.Confidence < s.minConfidence {
			continue
		}
		if len(s.classes) > 0 {
			if _, ok := s.classes[d.ClassName]; !ok {
				continue
			}
		}
		matched = append(matched, i)
	}
	if len(matched) == 0 {
		return nil
	}

	cutoff := d.TS.Add(-seq.window)
	trackKey := d.CameraID + "|" + d.TrackID

	// Record sightings + prune stale ones for every step we'll touch
	// (matched steps and earlier steps we'll look back at).
	e.mu.Lock()
	for _, idx := range matched {
		key := r.ID + "|" + strconv.Itoa(idx)
		kept := e.sequenceSightings[key][:0]
		for _, s := range e.sequenceSightings[key] {
			if s.ts.After(cutoff) {
				kept = append(kept, s)
			}
		}
		kept = append(kept, sequenceSighting{ts: d.TS, trackKey: trackKey})
		e.sequenceSightings[key] = kept
	}
	// Prune earlier steps lazily too, so the lookback below sees a
	// clean slice.
	for i := 0; i < len(seq.steps); i++ {
		key := r.ID + "|" + strconv.Itoa(i)
		if _, ok := e.sequenceSightings[key]; !ok {
			continue
		}
		kept := e.sequenceSightings[key][:0]
		for _, s := range e.sequenceSightings[key] {
			if s.ts.After(cutoff) {
				kept = append(kept, s)
			}
		}
		e.sequenceSightings[key] = kept
	}
	e.mu.Unlock()

	// Chain-complete check: only when a matched step is the LAST step
	// do we look back across earlier steps.
	lastIdx := len(seq.steps) - 1
	fired := false
	for _, idx := range matched {
		if idx != lastIdx {
			continue
		}
		e.mu.RLock()
		ok := true
		for i := 0; i < lastIdx; i++ {
			key := r.ID + "|" + strconv.Itoa(i)
			if len(e.sequenceSightings[key]) == 0 {
				ok = false
				break
			}
		}
		e.mu.RUnlock()
		if !ok {
			continue
		}
		if !e.cooldownOK(r.ID, r.Definition.CooldownSec, d.TS) {
			continue
		}
		if err := e.fireSequenceIncident(ctx, r, d); err != nil {
			return err
		}
		fired = true
	}
	if fired {
		slog.Debug("sequence fired",
			"rule", r.ID, "camera", d.CameraID, "class", d.ClassName)
	} else {
		slog.Debug("sequence step matched",
			"rule", r.ID, "steps", matched, "camera", d.CameraID)
	}
	return nil
}

// fireSequenceIncident writes an incident row for a cross-camera
// sequence rule. Mirrors fireIncident but the summary names both
// endpoints + the window so operators can tell at a glance what
// chained.
func (e *Engine) fireSequenceIncident(ctx context.Context, r compiledRule, d Detection) error {
	severity := r.Definition.Severity
	if severity == "" {
		severity = "info"
	}
	seq := r.sequence
	first := seq.steps[0].cameraID
	last := seq.steps[len(seq.steps)-1].cameraID
	summary := fmt.Sprintf("sequence: %s → %s within %ds (%s)",
		first, last, int(seq.window.Seconds()), r.Name)

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
		"rule_kind":  "sequence",
	})
	metrics.IncidentsFired.WithLabelValues(severity, "sequence").Inc()
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
	metrics.IncidentsFired.WithLabelValues(severity, "hotlist").Inc()
	return e.nc.Publish("fnvr.events.incident."+d.CameraID, payload)
}

// fireFaceIncident mirrors fireHotlistIncident for a face match: a
// rule-less incident (rule_id NULL) with a warning severity and a
// summary the operator can read at a glance. Downstream subscriptions
// with s.rule_id IS NULL fire as usual.
func (e *Engine) fireFaceIncident(ctx context.Context, d Detection, p enrolledEmbedding, sim float32) error {
	summary := fmt.Sprintf("face: %s on %s (%.0f%%)", p.Label, d.CameraID, sim*100)
	var incidentID string
	err := e.pool.QueryRow(ctx, `
		INSERT INTO incidents (rule_id, camera_id, started_at, ended_at, severity, summary)
		VALUES (NULL, $1, $2, $2, 'warning', $3) RETURNING id::text`,
		d.CameraID, d.TS, summary).Scan(&incidentID)
	if err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]any{
		"id":         incidentID,
		"camera_id":  d.CameraID,
		"started_at": d.TS,
		"severity":   "warning",
		"summary":    summary,
		"person_id":  p.PersonID,
		"person":     p.Label,
		"similarity": sim,
	})
	metrics.IncidentsFired.WithLabelValues("warning", "face").Inc()
	return e.nc.Publish("fnvr.events.incident."+d.CameraID, payload)
}

// fireDriftIncident records a system-scope incident for a face-ID
// embedding drift alert. rule_id and camera_id are both NULL — drift
// is not attributable to any one camera or rule — and the summary
// carries enough numbers that an operator can read the email/push
// without opening the app. 24 h cooldown prevents a flapping
// baseline from spamming channels; publishes on the reserved
// "__system" camera suffix so the dispatcher's wildcard catches it.
func (e *Engine) fireDriftIncident(ctx context.Context, a DriftAlert) error {
	const cooldownKey = "drift:global"
	ts := a.At
	if ts.IsZero() {
		ts = time.Now()
	}
	if !e.cooldownOK(cooldownKey, 24*3600, ts) {
		slog.Info("drift alert suppressed by cooldown",
			"baseline", a.Baseline, "current", a.Current, "delta", a.Delta)
		return nil
	}
	summary := fmt.Sprintf(
		"face embedding drift: baseline %.3f → current %.3f (%+.1f%%)",
		a.Baseline, a.Current, -a.Delta*100)
	var incidentID string
	err := e.pool.QueryRow(ctx, `
		INSERT INTO incidents (rule_id, camera_id, started_at, ended_at, severity, summary)
		VALUES (NULL, NULL, $1, $1, 'warning', $2) RETURNING id::text`,
		ts, summary).Scan(&incidentID)
	if err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]any{
		"id":         incidentID,
		"camera_id":  "",
		"started_at": ts,
		"severity":   "warning",
		"summary":    summary,
		"rule_kind":  "drift",
		"baseline":   a.Baseline,
		"current":    a.Current,
		"delta":      a.Delta,
	})
	metrics.IncidentsFired.WithLabelValues("warning", "drift").Inc()
	return e.nc.Publish("fnvr.events.incident.__system", payload)
}

// loadFaceEnrolments pulls every enabled person's embeddings joined
// with that person's metadata, parses the pgvector text literal, and
// L2-normalises so cosine similarity degenerates to a dot product.
func (e *Engine) loadFaceEnrolments(ctx context.Context) ([]enrolledEmbedding, error) {
	rows, err := e.pool.Query(ctx, `
		SELECT p.id::text, p.label, p.alert_on_match, fe.embedding::text
		FROM face_embeddings fe JOIN persons p ON p.id = fe.person_id
		WHERE p.enabled = TRUE`)
	if err != nil {
		// If the migration hasn't run yet the table doesn't exist;
		// return empty so the rest of reload() still succeeds.
		if isRelationMissing(err) {
			return nil, nil
		}
		return nil, err
	}
	defer rows.Close()
	out := make([]enrolledEmbedding, 0, 32)
	for rows.Next() {
		var e enrolledEmbedding
		var vecStr string
		if err := rows.Scan(&e.PersonID, &e.Label, &e.AlertOnMatch, &vecStr); err != nil {
			return nil, err
		}
		v := parseVectorLiteral(vecStr)
		if len(v) == 0 {
			continue
		}
		l2normalise(v)
		e.Vector = v
		out = append(out, e)
	}
	return out, rows.Err()
}

// loadFaceThreshold reads settings.faces.match_threshold; defaults
// 0.4 on any error / missing / out-of-range value.
func loadFaceThreshold(ctx context.Context, pool *pgxpool.Pool) float64 {
	const def = 0.40
	var raw []byte
	err := pool.QueryRow(ctx,
		`SELECT value FROM settings WHERE key = 'faces.match_threshold'`).Scan(&raw)
	if err != nil {
		return def
	}
	var t float64
	if err := json.Unmarshal(raw, &t); err != nil || t <= 0 || t >= 1 {
		return def
	}
	return t
}

// loadFaceMargin reads settings.faces.match_margin — the minimum gap
// required between the top-scoring person and the runner-up in a
// multi-person pool before we accept the match. Defaults to 0.05 on
// missing / out-of-range. Clamped to [0, 0.5] so a misconfiguration
// can't make every probe fail the margin check or render it useless.
func loadFaceMargin(ctx context.Context, pool *pgxpool.Pool) float64 {
	const def = 0.05
	var raw []byte
	err := pool.QueryRow(ctx,
		`SELECT value FROM settings WHERE key = 'faces.match_margin'`).Scan(&raw)
	if err != nil {
		return def
	}
	var m float64
	if err := json.Unmarshal(raw, &m); err != nil {
		return def
	}
	if m < 0 {
		m = 0
	}
	if m > 0.5 {
		m = 0.5
	}
	return m
}

// loadFaceNegatives pulls dismissed embeddings that carry training
// signal — "not a face" and "duplicate". Other reasons ("deleted",
// "enrolled") are UI-only hides and must not influence scoring.
// L2-normalises so cosine similarity is a plain dot product. Missing
// table returns empty.
func (e *Engine) loadFaceNegatives(ctx context.Context) ([]dismissedEmbedding, error) {
	rows, err := e.pool.Query(ctx,
		`SELECT embedding::text FROM face_dismissals
		 WHERE reason IN ('not_a_face', 'duplicate')`)
	if err != nil {
		if isRelationMissing(err) {
			return nil, nil
		}
		return nil, err
	}
	defer rows.Close()
	out := make([]dismissedEmbedding, 0, 32)
	for rows.Next() {
		var vecStr string
		if err := rows.Scan(&vecStr); err != nil {
			return nil, err
		}
		v := parseVectorLiteral(vecStr)
		if len(v) == 0 {
			continue
		}
		l2normalise(v)
		out = append(out, dismissedEmbedding{Vector: v})
	}
	return out, rows.Err()
}

// loadNegPenaltyWeight reads settings.faces.negative_penalty_weight;
// defaults 1.0. Values <0 clamp to 0 (penalty disabled); values >2
// clamp to 2 (aggressive cap, prevents a single close negative from
// nuking a solid positive below 0).
func loadNegPenaltyWeight(ctx context.Context, pool *pgxpool.Pool) float64 {
	const def = 1.0
	var raw []byte
	err := pool.QueryRow(ctx,
		`SELECT value FROM settings WHERE key = 'faces.negative_penalty_weight'`).Scan(&raw)
	if err != nil {
		return def
	}
	var w float64
	if err := json.Unmarshal(raw, &w); err != nil {
		return def
	}
	if w < 0 {
		w = 0
	}
	if w > 2 {
		w = 2
	}
	return w
}

// parsePHash decodes a detection's attributes.phash — a 16-char
// lowercase hex string — into a uint64. Returns false on any
// decoding failure so the caller just skips the suppression check.
func parsePHash(s string) (uint64, bool) {
	if len(s) != 16 {
		return 0, false
	}
	b, err := hex.DecodeString(s)
	if err != nil {
		return 0, false
	}
	var p uint64
	for _, v := range b {
		p = (p << 8) | uint64(v)
	}
	return p, true
}

// loadPHashHamming reads settings.detections.suppression_hamming_threshold.
// Default 8 is the well-known pHash identity cutoff; clamped to
// [4, 16] on read so a typo can't disable suppression entirely nor
// suppress unrelated detections.
func loadPHashHamming(ctx context.Context, pool *pgxpool.Pool) int {
	const def = 8
	var raw []byte
	err := pool.QueryRow(ctx,
		`SELECT value FROM settings WHERE key = 'detections.suppression_hamming_threshold'`).Scan(&raw)
	if err != nil {
		return def
	}
	var n int
	if err := json.Unmarshal(raw, &n); err != nil {
		return def
	}
	if n < 4 {
		n = 4
	}
	if n > 16 {
		n = 16
	}
	return n
}

// loadObjectFlags pulls the active suppression library and groups by
// (camera_id, class_original). phash comes out as int64 from pgx —
// reinterpret as uint64 so bits.OnesCount64 works directly.
// Missing table (fresh install predating migration 0024) returns
// empty / no error, consistent with loadFaceNegatives.
func (e *Engine) loadObjectFlags(ctx context.Context) (map[string]map[string][]uint64, int, error) {
	// Manual flags (drawn straight on a frozen tile to teach the
	// detector about a missed object) have no phash — they're
	// training data only, not suppression entries. Filter them out
	// so the live-suppression library only contains real
	// detection-derived pHashes.
	rows, err := e.pool.Query(ctx, `
		SELECT camera_id, class_original, phash
		FROM object_flags
		WHERE dismissed_at IS NULL AND phash IS NOT NULL`)
	if err != nil {
		if isRelationMissing(err) {
			return map[string]map[string][]uint64{}, 0, nil
		}
		return nil, 0, err
	}
	defer rows.Close()
	out := map[string]map[string][]uint64{}
	n := 0
	for rows.Next() {
		var camera, class string
		var signed int64
		if err := rows.Scan(&camera, &class, &signed); err != nil {
			return nil, 0, err
		}
		byClass, ok := out[camera]
		if !ok {
			byClass = map[string][]uint64{}
			out[camera] = byClass
		}
		byClass[class] = append(byClass[class], uint64(signed))
		n++
	}
	return out, n, rows.Err()
}

// parseVectorLiteral parses pgvector's "[v0,v1,...]" text form into a
// []float32. On parse error returns nil — caller skips the row.
func parseVectorLiteral(s string) []float32 {
	s = strings.TrimSpace(s)
	if len(s) < 2 || s[0] != '[' || s[len(s)-1] != ']' {
		return nil
	}
	parts := strings.Split(s[1:len(s)-1], ",")
	out := make([]float32, len(parts))
	for i, p := range parts {
		f, err := strconv.ParseFloat(strings.TrimSpace(p), 32)
		if err != nil {
			return nil
		}
		out[i] = float32(f)
	}
	return out
}

// l2normalise in-place divides by ||v||_2 so subsequent dot products
// with other normalised vectors yield cosine similarity directly.
func l2normalise(v []float32) {
	var sq float64
	for _, x := range v {
		sq += float64(x) * float64(x)
	}
	if sq <= 0 {
		return
	}
	inv := float32(1.0 / math.Sqrt(sq))
	for i := range v {
		v[i] *= inv
	}
}

// cosineSim assumes both inputs are L2-normalised and the same
// length; returns the dot product.
func cosineSim(a, b []float32) float32 {
	n := len(a)
	if n != len(b) {
		return 0
	}
	var s float32
	for i := 0; i < n; i++ {
		s += a[i] * b[i]
	}
	return s
}

// decodeEmbeddingBase64 decodes a little-endian float32 vector from
// the probe's base64 payload and L2-normalises for cosine-as-dot.
// Returns nil if the blob length isn't exactly 512 floats.
func decodeEmbeddingBase64(s string) []float32 {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil
	}
	if len(b) != 512*4 {
		return nil
	}
	out := make([]float32, 512)
	for i := 0; i < 512; i++ {
		u := uint32(b[i*4]) | uint32(b[i*4+1])<<8 |
			uint32(b[i*4+2])<<16 | uint32(b[i*4+3])<<24
		out[i] = math.Float32frombits(u)
	}
	l2normalise(out)
	return out
}

// isRelationMissing true for Postgres 42P01 ("undefined table") —
// used so reload() survives cleanly when migrations haven't yet
// created a table the engine wants.
func isRelationMissing(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "SQLSTATE 42P01") ||
		strings.Contains(err.Error(), "does not exist")
}

// fnv64 — tiny FNV-1a over a string. Used for short dedup hashes on
// unmatched face embeddings so the /faces/recent grid can group
// lookalikes without storing anything expensive.
func fnv64(s string) uint64 {
	const off, prime uint64 = 14695981039346656037, 1099511628211
	h := off
	for i := 0; i < len(s); i++ {
		h ^= uint64(s[i])
		h *= prime
	}
	return h
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

package camera

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrNotFound = errors.New("camera not found")

type Camera struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	URL           string    `json:"url"`
	Substream     string    `json:"substream,omitempty"`
	RecordMode    string    `json:"record_mode"`
	Enabled       bool      `json:"enabled"`
	RetentionDays int       `json:"retention_days"`
	QuotaGB       int       `json:"quota_gb"`
	GroupID       string    `json:"group_id"`
	// EnabledDetectors is a whitelist of detector kinds (e.g. ["object"]) —
	// empty array means "every detector" (the friendly default so legacy
	// rows behave like they always did).
	EnabledDetectors []string `json:"enabled_detectors"`
	// LocationKind selects which class-mute bucket applies on top of
	// global (indoor/outdoor). nil = no bucket, only global applies.
	LocationKind *string `json:"location_kind,omitempty"`
	// MuteClassesOverride adds classes to the mute set for this camera
	// only (classes muted here even if not in global/location buckets).
	MuteClassesOverride []string `json:"mute_classes_override"`
	// UnmuteClassesOverride removes classes from the resolved mute set
	// for this camera only (re-enables an inherited mute).
	UnmuteClassesOverride []string `json:"unmute_classes_override"`
	// Rotation is the clockwise software rotation applied by the pipeline,
	// in degrees. Valid: 0, 90, 180, 270. Used to correct cameras that
	// can't be physically reoriented.
	Rotation int `json:"rotation"`
	// MtxProxy routes the pipeline worker through the local MediaMTX
	// re-muxer instead of pulling the source URL directly. Only useful
	// for cameras with corrupt RTSP streams (qtmux chokes on broken
	// Rockchip-style NAL framing); the UI only offers it for no-AI
	// cameras (enabled_detectors=["none"]).
	MtxProxy bool `json:"mtx_proxy"`
	// MtxTLSFingerprint is the SHA256 cert fingerprint of the upstream
	// RTSPS source, uppercase + colon-separated. When non-empty,
	// MediaMTX's source pins trust to this cert and skips the usual
	// CA-validation path. Needed for devices with self-signed certs that
	// lack IP SAN entries (e.g. Bambu H2D). Populated automatically by
	// the API when the operator toggles "Ignore certificate" in the UI.
	MtxTLSFingerprint string `json:"mtx_tls_fingerprint,omitempty"`
	// DetectorBackend selects the primary-detector (PGIE) inference
	// path for this camera. "trt" (default) = DeepStream nvinfer on
	// the Orin GPU. "hailo" = route via hailonet to the Hailo-8 PCIe
	// accelerator. Tracker + ANPR SGIEs + face SGIEs stay on GPU
	// regardless — only PGIE moves.
	DetectorBackend       string    `json:"detector_backend"`
	CreatedAt             time.Time `json:"created_at"`
	UpdatedAt             time.Time `json:"updated_at"`
}

type Store struct {
	pool *pgxpool.Pool
}

func NewStore(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

func (s *Store) List(ctx context.Context) ([]Camera, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, name, url, coalesce(substream,''), record_mode, enabled,
		       retention_days, quota_gb, group_id, enabled_detectors,
		       location_kind, mute_classes_override, unmute_classes_override,
		       rotation, mtx_proxy, mtx_tls_fingerprint,
		       detector_backend, created_at, updated_at
		FROM cameras ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Camera, 0)
	for rows.Next() {
		var c Camera
		if err := rows.Scan(&c.ID, &c.Name, &c.URL, &c.Substream, &c.RecordMode,
			&c.Enabled, &c.RetentionDays, &c.QuotaGB, &c.GroupID,
			&c.EnabledDetectors, &c.LocationKind, &c.MuteClassesOverride,
			&c.UnmuteClassesOverride, &c.Rotation, &c.MtxProxy,
			&c.MtxTLSFingerprint, &c.DetectorBackend,
			&c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) Get(ctx context.Context, id string) (Camera, error) {
	var c Camera
	err := s.pool.QueryRow(ctx, `
		SELECT id, name, url, coalesce(substream,''), record_mode, enabled,
		       retention_days, quota_gb, group_id, enabled_detectors,
		       location_kind, mute_classes_override, unmute_classes_override,
		       rotation, mtx_proxy, mtx_tls_fingerprint,
		       detector_backend, created_at, updated_at
		FROM cameras WHERE id = $1`, id).
		Scan(&c.ID, &c.Name, &c.URL, &c.Substream, &c.RecordMode, &c.Enabled,
			&c.RetentionDays, &c.QuotaGB, &c.GroupID, &c.EnabledDetectors,
			&c.LocationKind, &c.MuteClassesOverride, &c.UnmuteClassesOverride,
			&c.Rotation, &c.MtxProxy, &c.MtxTLSFingerprint,
			&c.DetectorBackend, &c.CreatedAt, &c.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return c, ErrNotFound
	}
	return c, err
}

// SetClassMuting updates any combination of {location_kind, mute_override,
// unmute_override}. Each argument is applied only if non-nil; that way the
// PATCH endpoint can send partial bodies without us having to pre-read the
// row. locKind points to "indoor" / "outdoor" / "" (empty string clears the
// tag and writes NULL); nil leaves it untouched. For the two slices, nil =
// don't change, empty = clear.
func (s *Store) SetClassMuting(ctx context.Context, id string,
	locKind *string, muteOverride, unmuteOverride []string) error {
	// Build the UPDATE dynamically so we only touch the columns that were
	// supplied. Always bumps updated_at.
	sets := []string{"updated_at = NOW()"}
	args := []any{id}
	add := func(v any) string {
		args = append(args, v)
		return "$" + itoa(len(args))
	}
	if locKind != nil {
		if *locKind == "" {
			sets = append(sets, "location_kind = NULL")
		} else {
			if *locKind != "indoor" && *locKind != "outdoor" {
				return errors.New("location_kind must be indoor, outdoor, or empty")
			}
			sets = append(sets, "location_kind = "+add(*locKind))
		}
	}
	if muteOverride != nil {
		sets = append(sets, "mute_classes_override = "+add(muteOverride))
	}
	if unmuteOverride != nil {
		sets = append(sets, "unmute_classes_override = "+add(unmuteOverride))
	}
	sql := "UPDATE cameras SET " + strings.Join(sets, ", ") + " WHERE id = $1"
	tag, err := s.pool.Exec(ctx, sql, args...)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// UpdateStorage sets retention_days and/or quota_gb on a camera. Either
// pointer may be nil to leave the column untouched, so the PATCH handler
// accepts partial bodies without pre-reading the row. Both values are
// validated against sane ceilings (3650 days / 10000 GB) so a typo can't
// disable retention entirely or reserve absurd quota.
func (s *Store) UpdateStorage(ctx context.Context, id string,
	retentionDays, quotaGB *int) error {
	sets := []string{"updated_at = NOW()"}
	args := []any{id}
	add := func(v any) string {
		args = append(args, v)
		return "$" + itoa(len(args))
	}
	if retentionDays != nil {
		if *retentionDays < 1 || *retentionDays > 3650 {
			return errors.New("retention_days must be in [1, 3650]")
		}
		sets = append(sets, "retention_days = "+add(*retentionDays))
	}
	if quotaGB != nil {
		if *quotaGB < 1 || *quotaGB > 10000 {
			return errors.New("quota_gb must be in [1, 10000]")
		}
		sets = append(sets, "quota_gb = "+add(*quotaGB))
	}
	if len(sets) == 1 {
		return errors.New("no fields to update")
	}
	sql := "UPDATE cameras SET " + strings.Join(sets, ", ") + " WHERE id = $1"
	tag, err := s.pool.Exec(ctx, sql, args...)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// SetEnabledDetectors replaces the camera's detector whitelist. Nil = "all
// enabled" (empty array on disk). Returns ErrNotFound for unknown id.
func (s *Store) SetEnabledDetectors(ctx context.Context, id string, kinds []string) error {
	if kinds == nil {
		kinds = []string{}
	}
	tag, err := s.pool.Exec(ctx,
		`UPDATE cameras SET enabled_detectors=$2, updated_at=NOW() WHERE id=$1`,
		id, kinds)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) Create(ctx context.Context, c Camera) (Camera, error) {
	if c.RecordMode == "" {
		c.RecordMode = "continuous"
	}
	if c.RetentionDays == 0 {
		c.RetentionDays = 14
	}
	if c.QuotaGB == 0 {
		c.QuotaGB = 200
	}
	if c.GroupID == "" {
		c.GroupID = "default"
	}
	if c.ID == "" {
		id, err := s.uniqueSlug(ctx, c.Name)
		if err != nil {
			return c, err
		}
		c.ID = id
	}
	err := s.pool.QueryRow(ctx, `
		INSERT INTO cameras (id, name, url, substream, record_mode, enabled,
		                     retention_days, quota_gb, group_id)
		VALUES ($1,$2,$3,NULLIF($4,''),$5,true,$6,$7,$8)
		RETURNING created_at, updated_at`,
		c.ID, c.Name, c.URL, c.Substream, c.RecordMode,
		c.RetentionDays, c.QuotaGB, c.GroupID).
		Scan(&c.CreatedAt, &c.UpdatedAt)
	c.Enabled = true
	return c, err
}

var slugStripRe = regexp.MustCompile(`[^a-z0-9]+`)

// slugify converts "Front Door" → "front-door". Falls back to "camera" on
// empty inputs so we always have something to bump with a suffix.
func slugify(s string) string {
	s = strings.ToLower(s)
	s = slugStripRe.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	if s == "" {
		return "camera"
	}
	if len(s) > 48 {
		s = s[:48]
	}
	return s
}

// uniqueSlug turns a display name into a camera ID, bumping with -2, -3…
// on collision. Runs a handful of SELECTs in the worst case; the cameras
// table is small so this is fine.
func (s *Store) uniqueSlug(ctx context.Context, name string) (string, error) {
	base := slugify(name)
	candidate := base
	for i := 2; i < 1000; i++ {
		var exists bool
		err := s.pool.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM cameras WHERE id = $1)`, candidate).Scan(&exists)
		if err != nil {
			return "", err
		}
		if !exists {
			return candidate, nil
		}
		candidate = base + "-" + itoa(i)
	}
	return "", errors.New("could not allocate unique camera id")
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [12]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

func (s *Store) Delete(ctx context.Context, id string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM cameras WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) SetEnabled(ctx context.Context, id string, enabled bool) error {
	tag, err := s.pool.Exec(ctx, `UPDATE cameras SET enabled=$1, updated_at=NOW() WHERE id=$2`, enabled, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// UpdateBasics updates name and/or url on an existing camera row.
// Fields passed as nil are left alone. Trims whitespace and rejects
// empty strings on either field to avoid blanking a row by accident.
// Returns ErrNotFound if no row matches.
func (s *Store) UpdateBasics(ctx context.Context, id string, name *string, url *string) error {
	if name != nil {
		trimmed := strings.TrimSpace(*name)
		if trimmed == "" {
			return fmt.Errorf("name cannot be empty")
		}
		name = &trimmed
	}
	if url != nil {
		trimmed := strings.TrimSpace(*url)
		if trimmed == "" {
			return fmt.Errorf("url cannot be empty")
		}
		url = &trimmed
	}
	if name == nil && url == nil {
		return fmt.Errorf("name or url required")
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE cameras
		   SET name = COALESCE($2, name),
		       url  = COALESCE($3, url),
		       updated_at = NOW()
		 WHERE id = $1`, id, name, url)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// SetRotation updates the per-camera software rotation. Valid values are
// 0, 90, 180, 270 (enforced by a DB CHECK constraint). The pipeline's
// supervisor picks up the change on its next reconcile tick and respawns
// the worker so the new rotation takes effect.
func (s *Store) SetRotation(ctx context.Context, id string, rotation int) error {
	switch rotation {
	case 0, 90, 180, 270:
	default:
		return fmt.Errorf("invalid rotation %d", rotation)
	}
	tag, err := s.pool.Exec(ctx, `UPDATE cameras SET rotation=$1, updated_at=NOW() WHERE id=$2`, rotation, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// SetMtxProxy toggles the per-camera MediaMTX re-muxer flag. The UI
// only surfaces this for no-AI cameras, but the backend doesn't
// enforce that — keeping the two columns independent means an
// operator doing a CSV bulk import can set them in any order.
func (s *Store) SetMtxProxy(ctx context.Context, id string, enabled bool) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE cameras SET mtx_proxy=$1, updated_at=NOW() WHERE id=$2`,
		enabled, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// SetMtxTLSFingerprint stores the SHA256 cert fingerprint to pin for
// this camera's MediaMTX-proxied upstream. Empty string clears it (use
// standard TLS verification again). Normalised to lowercase hex with
// no separators — the format MediaMTX's RTSP client expects for its
// sourceFingerprint equality check.
func (s *Store) SetMtxTLSFingerprint(ctx context.Context, id, fingerprint string) error {
	fingerprint = strings.ToLower(strings.TrimSpace(fingerprint))
	// Strip colon separators if caller pasted the openssl-style format.
	fingerprint = strings.ReplaceAll(fingerprint, ":", "")
	tag, err := s.pool.Exec(ctx,
		`UPDATE cameras SET mtx_tls_fingerprint=$1, updated_at=NOW() WHERE id=$2`,
		fingerprint, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// SetDetectorBackend switches this camera's primary-detector path
// between the TensorRT (GPU) backend and the Hailo-8 (PCIe) backend.
// The pipeline-supervisor's reconcile loop picks up the change on
// its next tick (~5 s) and respawns just the affected worker. Other
// cameras are unaffected.
func (s *Store) SetDetectorBackend(ctx context.Context, id, backend string) error {
	switch backend {
	case "trt", "hailo":
	default:
		return fmt.Errorf("invalid detector_backend %q (want trt|hailo)", backend)
	}
	tag, err := s.pool.Exec(ctx,
		`UPDATE cameras SET detector_backend=$1, updated_at=NOW() WHERE id=$2`,
		backend, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

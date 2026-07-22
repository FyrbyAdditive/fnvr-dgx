// Package persons backs the Faces UI: enrolled-person CRUD plus
// embedding storage using pgvector. Event-processor reads the
// AllEmbeddings view every 30s to refresh its in-memory match
// cache — same reload cadence as rules and the plate hotlist.
package persons

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrNotFound   = errors.New("person not found")
	ErrLabelTaken = errors.New("label already in use")
)

type Person struct {
	ID             string    `json:"id"`
	Label          string    `json:"label"`
	Notes          string    `json:"notes,omitempty"`
	Enabled        bool      `json:"enabled"`
	AlertOnMatch   bool      `json:"alert_on_match"`
	EmbeddingCount int       `json:"embedding_count"`
	// ThumbDetectionID is the newest enrolled embedding's detection id
	// — resolvable to a face thumbnail, so the People cards get an
	// avatar without N+1 embedding fetches. Nil when no embedding has
	// a detection source (e.g. photo-upload-only enrolments).
	ThumbDetectionID *int64    `json:"thumb_detection_id,omitempty"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
}

type Embedding struct {
	ID        string    `json:"id"`
	PersonID  string    `json:"person_id"`
	Source    string    `json:"source"`
	CreatedAt time.Time `json:"created_at"`
	// DetectionID is the PG detections.id that this embedding came
	// from. Nullable for rows predating the 0017 migration. The UI
	// uses it to show the face thumbnail next to each embedding.
	DetectionID *int64 `json:"detection_id,omitempty"`
	// NearestNeighbourSimilarity is this embedding's average cosine to
	// its 3 nearest neighbours in the same person's pool. Outliers
	// (wrong person, heavy noise) land noticeably low because they
	// have no similar siblings. Pose/lighting variants of the real
	// person stay healthy as long as at least a few similar siblings
	// exist — which is the opposite of the pool-coherence metric this
	// replaced, and the opposite of what the matcher penalises.
	// 0 when the pool has fewer than 2 embeddings.
	NearestNeighbourSimilarity float32 `json:"nearest_neighbour_similarity"`
	// Vector omitted from JSON by default — the UI never needs it and
	// shipping 512 floats per list call is wasteful.
	Vector []float32 `json:"-"`
}

// EnrolledEmbedding is the shape event-processor pulls on reload:
// the vector, plus enough person metadata to label and route a match
// without a second query.
type EnrolledEmbedding struct {
	PersonID     string
	Label        string
	AlertOnMatch bool
	Vector       []float32
}

// DismissedEmbedding is a "not a face" (or near-duplicate) sample that
// the matcher penalises at scoring time: a detection too similar to
// any of these loses match score equal to the cosine similarity.
type DismissedEmbedding struct {
	DetectionID string
	Reason      string
	Vector      []float32
}

type Store struct {
	pool *pgxpool.Pool
	// thumbsRoot is where cached face-thumbnail JPEGs live — must match
	// the write path in server/faces.go ({DataDir}/thumbs/faces) or
	// right-to-erasure deletes from the wrong directory.
	thumbsRoot string
}

func NewStore(pool *pgxpool.Pool, thumbsRoot string) *Store {
	return &Store{pool: pool, thumbsRoot: thumbsRoot}
}

// --- Person CRUD ---

func (s *Store) List(ctx context.Context) ([]Person, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT p.id::text, p.label, COALESCE(p.notes,''), p.enabled,
		       p.alert_on_match,
		       (SELECT COUNT(*) FROM face_embeddings e WHERE e.person_id = p.id),
		       (SELECT e.detection_id FROM face_embeddings e
		        WHERE e.person_id = p.id AND e.detection_id IS NOT NULL
		        ORDER BY e.created_at DESC LIMIT 1),
		       p.created_at, p.updated_at
		FROM persons p
		ORDER BY p.label ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Person, 0, 16)
	for rows.Next() {
		var p Person
		if err := rows.Scan(&p.ID, &p.Label, &p.Notes, &p.Enabled,
			&p.AlertOnMatch, &p.EmbeddingCount, &p.ThumbDetectionID,
			&p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) Get(ctx context.Context, id string) (Person, error) {
	var p Person
	err := s.pool.QueryRow(ctx, `
		SELECT p.id::text, p.label, COALESCE(p.notes,''), p.enabled,
		       p.alert_on_match,
		       (SELECT COUNT(*) FROM face_embeddings e WHERE e.person_id = p.id),
		       p.created_at, p.updated_at
		FROM persons p WHERE p.id = $1`, id).
		Scan(&p.ID, &p.Label, &p.Notes, &p.Enabled, &p.AlertOnMatch,
			&p.EmbeddingCount, &p.CreatedAt, &p.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, ErrNotFound
	}
	return p, err
}

func (s *Store) Create(ctx context.Context, p Person) (Person, error) {
	label := strings.TrimSpace(p.Label)
	if label == "" {
		return p, fmt.Errorf("label required")
	}
	err := s.pool.QueryRow(ctx, `
		INSERT INTO persons (label, notes, enabled, alert_on_match)
		VALUES ($1, NULLIF($2,''), COALESCE($3, TRUE), COALESCE($4, FALSE))
		RETURNING id::text, created_at, updated_at`,
		label, p.Notes, p.Enabled, p.AlertOnMatch).
		Scan(&p.ID, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		if strings.Contains(err.Error(), "persons_label_idx") {
			return p, ErrLabelTaken
		}
		return p, err
	}
	p.Label = label
	return p, nil
}

// Update applies any non-nil field from the supplied struct. Empty-
// string fields clear notes; bool pointers gate enabled + alert.
func (s *Store) Update(ctx context.Context, id string,
	label *string, notes *string, enabled *bool, alertOnMatch *bool) error {
	sets := []string{"updated_at = NOW()"}
	args := []any{id}
	add := func(v any) string {
		args = append(args, v)
		return "$" + itoa(len(args))
	}
	if label != nil {
		l := strings.TrimSpace(*label)
		if l == "" {
			return fmt.Errorf("label cannot be empty")
		}
		sets = append(sets, "label = "+add(l))
	}
	if notes != nil {
		// Empty string → NULL so the DB stores a clean absence.
		if *notes == "" {
			sets = append(sets, "notes = NULL")
		} else {
			sets = append(sets, "notes = "+add(*notes))
		}
	}
	if enabled != nil {
		sets = append(sets, "enabled = "+add(*enabled))
	}
	if alertOnMatch != nil {
		sets = append(sets, "alert_on_match = "+add(*alertOnMatch))
	}
	sql := "UPDATE persons SET " + strings.Join(sets, ", ") + " WHERE id = $1"
	tag, err := s.pool.Exec(ctx, sql, args...)
	if err != nil {
		if strings.Contains(err.Error(), "persons_label_idx") {
			return ErrLabelTaken
		}
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) Delete(ctx context.Context, id string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM persons WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// --- Embedding CRUD ---

// AddEmbedding stores a new 512-d embedding for a person. The caller
// is expected to pass the raw float32 slice from the detection's
// attributes (after base64 decode). pgvector's on-the-wire text shape
// is "[0.1,0.2,...]" — we stringify manually since pgx doesn't have
// a native codec for the vector type.
//
// detectionID links the embedding to the source detection so the UI
// can show its thumbnail next to the embedding row. Pass 0 when no
// detection id is available (e.g. future upload-by-photo enrolment).
func (s *Store) AddEmbedding(ctx context.Context, personID string, vector []float32, source string, detectionID int64) (Embedding, error) {
	if len(vector) != 512 {
		return Embedding{}, fmt.Errorf("expected 512-d embedding, got %d", len(vector))
	}
	vecLit := vectorLiteral(vector)
	var e Embedding
	var did any
	if detectionID > 0 {
		did = detectionID
	}
	// model tag: everything enrolled since the 2026 aligned-stack
	// rework embeds with TopoFR R100 on ArcFace-aligned crops
	// (ml-worker is the only embedder — live and upload paths share it).
	err := s.pool.QueryRow(ctx, `
		INSERT INTO face_embeddings (person_id, embedding, source, detection_id, model)
		VALUES ($1, $2::vector, $3, $4, 'topofr_r100')
		RETURNING id::text, person_id::text, source, created_at, detection_id`,
		personID, vecLit, source, did).
		Scan(&e.ID, &e.PersonID, &e.Source, &e.CreatedAt, &e.DetectionID)
	if err != nil {
		return e, err
	}
	return e, nil
}

func (s *Store) ListEmbeddings(ctx context.Context, personID string) ([]Embedding, error) {
	// Each row comes back with the mean cosine to its 3 NEAREST
	// neighbours in the same pool — not the whole pool. That makes
	// the metric robust to legitimate diversity: a pose-variant
	// embedding still scores well as long as it has a few similar
	// siblings, while an outlier with no similar siblings anywhere
	// in the pool scores low regardless of how big the pool is.
	//
	// pgvector's `<=>` returns cosine distance (0..2). Subtract from
	// 1 for cosine similarity. ROW_NUMBER partitions per source
	// embedding so we pick each row's top-3 matches independently.
	// Small pools (1 or 2 rows) have no siblings / fewer than 3 —
	// COALESCE to 0 so the JSON is never null.
	rows, err := s.pool.Query(ctx, `
		WITH pool AS (
		    SELECT id, embedding FROM face_embeddings WHERE person_id = $1
		),
		ranked AS (
		    SELECT a.id AS id,
		           1 - (a.embedding <=> b.embedding) AS sim,
		           ROW_NUMBER() OVER (
		               PARTITION BY a.id
		               ORDER BY a.embedding <=> b.embedding ASC
		           ) AS rn
		    FROM pool a JOIN pool b ON a.id <> b.id
		),
		knn AS (
		    SELECT id, AVG(sim)::real AS mean_knn
		    FROM ranked
		    WHERE rn <= 3
		    GROUP BY id
		)
		SELECT e.id::text, e.person_id::text, e.source, e.created_at,
		       e.detection_id,
		       COALESCE(k.mean_knn, 0)::real AS mean_knn
		FROM face_embeddings e
		LEFT JOIN knn k ON k.id = e.id
		WHERE e.person_id = $1
		ORDER BY e.created_at DESC`, personID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Embedding, 0, 8)
	for rows.Next() {
		var e Embedding
		if err := rows.Scan(&e.ID, &e.PersonID, &e.Source, &e.CreatedAt,
			&e.DetectionID, &e.NearestNeighbourSimilarity); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func (s *Store) DeleteEmbedding(ctx context.Context, id string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM face_embeddings WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// BulkDeleteEmbeddings removes a batch of embeddings from a single
// person's pool. Scoping the WHERE by person_id means a forged ids
// array can't reach into another person's row even if the UUIDs are
// known. Returns the count actually deleted; empty/no-match inputs
// collapse to 0 without an error (idempotent).
func (s *Store) BulkDeleteEmbeddings(ctx context.Context, personID string, ids []string) (int, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	tag, err := s.pool.Exec(ctx, `
		DELETE FROM face_embeddings
		WHERE person_id = $1 AND id = ANY($2::uuid[])`, personID, ids)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

// AllEmbeddings returns every enrolled embedding belonging to an
// enabled person, joined with the person's label + alert flag so the
// event-processor match loop doesn't need a second query.
func (s *Store) AllEmbeddings(ctx context.Context) ([]EnrolledEmbedding, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT p.id::text, p.label, p.alert_on_match, e.embedding::text
		FROM face_embeddings e JOIN persons p ON p.id = e.person_id
		WHERE p.enabled = TRUE AND e.model = 'topofr_r100'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]EnrolledEmbedding, 0, 16)
	for rows.Next() {
		var e EnrolledEmbedding
		var vecStr string
		if err := rows.Scan(&e.PersonID, &e.Label, &e.AlertOnMatch, &vecStr); err != nil {
			return nil, err
		}
		v, err := ParseVectorLiteral(vecStr)
		if err != nil {
			continue
		}
		e.Vector = v
		out = append(out, e)
	}
	return out, rows.Err()
}

// --- Dismissals (hard-negative + duplicate marking) ---

// Dismiss records a detection as hidden. Reason is one of:
//   not_a_face — feeds the matcher's negative-penalty scorer.
//   duplicate  — feeds the scorer (treated same as not_a_face).
//   deleted    — UI-only hide; matcher ignores.
//   enrolled   — UI-only hide after save; matcher ignores.
// Upserts on detection_id so repeated clicks are harmless.
func (s *Store) Dismiss(ctx context.Context, detectionID string, vector []float32, reason string) error {
	if len(vector) != 512 {
		return fmt.Errorf("expected 512-d embedding, got %d", len(vector))
	}
	switch reason {
	case "not_a_face", "duplicate", "deleted", "enrolled":
	default:
		return fmt.Errorf("reason must be not_a_face, duplicate, deleted or enrolled")
	}
	vecLit := vectorLiteral(vector)
	_, err := s.pool.Exec(ctx, `
		INSERT INTO face_dismissals (detection_id, embedding, reason, model)
		VALUES ($1, $2::vector, $3, 'topofr_r100')
		ON CONFLICT (detection_id) DO UPDATE
		SET reason = EXCLUDED.reason, model = EXCLUDED.model`,
		detectionID, vecLit, reason)
	return err
}

// Undismiss removes a dismissal (e.g. operator realised they
// mis-clicked). Silent if the dismissal doesn't exist.
func (s *Store) Undismiss(ctx context.Context, detectionID string) error {
	_, err := s.pool.Exec(ctx,
		`DELETE FROM face_dismissals WHERE detection_id = $1`, detectionID)
	return err
}

// ListDismissedIDs returns the set of detection_ids that have been
// dismissed — used by the /faces/recent handler to filter them out.
func (s *Store) ListDismissedIDs(ctx context.Context) (map[string]struct{}, error) {
	rows, err := s.pool.Query(ctx, `SELECT detection_id FROM face_dismissals`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]struct{}, 64)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = struct{}{}
	}
	return out, rows.Err()
}

// AllNegatives returns the dismissed embeddings that carry training
// signal — "not_a_face" and "duplicate" only, mirroring the live
// matcher's loadFaceNegatives. "deleted" and "enrolled" are UI-only
// hides and MUST NOT feed the negative veto: they are usually the
// operator's own face (hidden queue tiles, auto-hidden enrol seeds),
// so including them vetoes every genuine match.
func (s *Store) AllNegatives(ctx context.Context) ([]DismissedEmbedding, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT detection_id, reason, embedding::text
		FROM face_dismissals
		WHERE reason IN ('not_a_face', 'duplicate')
		  AND model = 'topofr_r100'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]DismissedEmbedding, 0, 32)
	for rows.Next() {
		var e DismissedEmbedding
		var vecStr string
		if err := rows.Scan(&e.DetectionID, &e.Reason, &vecStr); err != nil {
			return nil, err
		}
		v, err := ParseVectorLiteral(vecStr)
		if err != nil {
			continue
		}
		e.Vector = v
		out = append(out, e)
	}
	return out, rows.Err()
}

// AddEmbeddingsBulk writes multiple embeddings for a single person in
// one call — used by the "enrol this cluster" UI where the operator
// names one representative thumbnail and wants the diverse members
// added too. Source strings are per-embedding so the caller can stamp
// them with the source detection IDs.
//
// The batch is quality-gated (filterEnrolQuality — turned/blurred/
// marginal detections stay matchable but don't enter the pool) and
// then diversity-pruned (PruneEnrolBatch): near-duplicates of the
// person's existing pool or of an earlier batch entry are dropped,
// and each action adds at most faces.enrol.max_per_action new
// samples. Item order is priority order. Returns
// (added, near-duplicates+over-cap skipped, quality-rejected).
func (s *Store) AddEmbeddingsBulk(ctx context.Context, personID string, items []struct {
	Vector      []float32
	Source      string
	DetectionID int64
}) (int, int, int, error) {
	ids := make([]int64, 0, len(items))
	for _, it := range items {
		if it.DetectionID > 0 {
			ids = append(ids, it.DetectionID)
		}
	}
	lowQuality := s.filterEnrolQuality(ctx, ids)

	skippedQuality := 0
	valid := items[:0:0]
	for _, it := range items {
		if len(it.Vector) != 512 {
			continue
		}
		if it.DetectionID > 0 && lowQuality[it.DetectionID] {
			skippedQuality++
			continue
		}
		valid = append(valid, it)
	}
	if len(valid) == 0 {
		return 0, 0, skippedQuality, nil
	}
	existing, err := s.personVectors(ctx, personID)
	if err != nil {
		return 0, 0, skippedQuality, err
	}
	dedupSim, maxPerAction := s.enrolParams(ctx)
	cands := make([][]float32, len(valid))
	for i := range valid {
		cands[i] = valid[i].Vector
	}
	keep, skipped := PruneEnrolBatch(existing, cands, dedupSim, maxPerAction)

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, skipped, skippedQuality, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	n := 0
	for _, i := range keep {
		it := valid[i]
		var did any
		if it.DetectionID > 0 {
			did = it.DetectionID
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO face_embeddings (person_id, embedding, source, detection_id, model)
			VALUES ($1, $2::vector, $3, $4, 'topofr_r100')`,
			personID, vectorLiteral(it.Vector), it.Source, did); err != nil {
			return n, skipped, skippedQuality, err
		}
		n++
	}
	return n, skipped, skippedQuality, tx.Commit(ctx)
}

// --- helpers ---

// vectorLiteral formats a []float32 as pgvector's text shape
// "[v0,v1,...]". Used for INSERT; Scan'ing out uses the same text
// representation which we then parse with ParseVectorLiteral.
func vectorLiteral(v []float32) string {
	var b strings.Builder
	b.Grow(len(v) * 10)
	b.WriteByte('[')
	for i, x := range v {
		if i > 0 {
			b.WriteByte(',')
		}
		// Strconv avoids the `fmt` overhead per-float; 6 sig figs is
		// plenty for ArcFace embeddings (they're already fp32).
		b.WriteString(fmtFloat32(x))
	}
	b.WriteByte(']')
	return b.String()
}

// ParseVectorLiteral parses pgvector's "[v0,v1,...]" text form into a
// []float32. Exported so event-processor can consume the same shape
// directly from its own PG queries.
func ParseVectorLiteral(s string) ([]float32, error) {
	s = strings.TrimSpace(s)
	if len(s) < 2 || s[0] != '[' || s[len(s)-1] != ']' {
		return nil, fmt.Errorf("bad vector literal")
	}
	parts := strings.Split(s[1:len(s)-1], ",")
	out := make([]float32, len(parts))
	for i, p := range parts {
		f, err := parseFloat32(strings.TrimSpace(p))
		if err != nil {
			return nil, fmt.Errorf("bad component %d: %w", i, err)
		}
		out[i] = f
	}
	return out, nil
}

// fmtFloat32 / parseFloat32 — strconv wrappers. 6 sig figs is plenty
// for ArcFace embeddings (already fp32).
func fmtFloat32(f float32) string {
	return strconv.FormatFloat(float64(f), 'g', 6, 32)
}
func parseFloat32(s string) (float32, error) {
	f, err := strconv.ParseFloat(s, 32)
	if err != nil {
		return 0, err
	}
	return float32(f), nil
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [12]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

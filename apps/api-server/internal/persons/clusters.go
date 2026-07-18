package persons

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Cluster is one row of face_clusters with enough extra to render a
// review tile (representative thumbnail, first/last seen).
type Cluster struct {
	ID                        string     `json:"id"`
	MemberCount               int        `json:"member_count"`
	RepresentativeDetectionID *int64     `json:"representative_detection_id,omitempty"`
	Algorithm                 string     `json:"algorithm"`
	CreatedAt                 time.Time  `json:"created_at"`
	UpdatedAt                 time.Time  `json:"updated_at"`
	EnrolledPersonID          *string    `json:"enrolled_person_id,omitempty"`
	// FirstSeen / LastSeen come from face_cluster_members.added_at,
	// useful to show "observed over 3 days" in the UI.
	FirstSeen *time.Time `json:"first_seen,omitempty"`
	LastSeen  *time.Time `json:"last_seen,omitempty"`
}

// ClusterMember is one face in a cluster, keyed by its source
// detection id so the UI can reuse the existing thumbnail endpoint.
type ClusterMember struct {
	ClusterID            string  `json:"cluster_id"`
	DetectionID          int64   `json:"detection_id"`
	SimilarityToCentroid float32 `json:"similarity_to_centroid"`
	AddedAt              time.Time `json:"added_at"`
}

// ListClusters returns clusters with member-count + representative.
// When unenrolledOnly is true, clusters already claimed by a person
// are omitted — that's the default for the Faces-tab review grid.
func (s *Store) ListClusters(ctx context.Context, unenrolledOnly bool) ([]Cluster, error) {
	q := `
		SELECT c.id::text, c.member_count,
		       c.representative_detection_id, c.algorithm,
		       c.created_at, c.updated_at,
		       c.enrolled_person_id::text,
		       (SELECT MIN(added_at) FROM face_cluster_members m WHERE m.cluster_id = c.id),
		       (SELECT MAX(added_at) FROM face_cluster_members m WHERE m.cluster_id = c.id)
		FROM face_clusters c`
	if unenrolledOnly {
		q += " WHERE c.enrolled_person_id IS NULL"
	}
	q += " ORDER BY c.member_count DESC, c.updated_at DESC"
	rows, err := s.pool.Query(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Cluster, 0, 16)
	for rows.Next() {
		var c Cluster
		var repDet *int64
		var enrolled *string
		var first, last *time.Time
		if err := rows.Scan(
			&c.ID, &c.MemberCount, &repDet, &c.Algorithm,
			&c.CreatedAt, &c.UpdatedAt, &enrolled, &first, &last,
		); err != nil {
			return nil, err
		}
		c.RepresentativeDetectionID = repDet
		c.EnrolledPersonID = enrolled
		c.FirstSeen = first
		c.LastSeen = last
		out = append(out, c)
	}
	return out, rows.Err()
}

// ListClusterMembers returns every member detection of a cluster.
// The embedding itself is NOT returned here — callers either serve
// a thumbnail (via detection_id → /api/v1/faces/thumbnail) or go
// read the vector back from detections.attributes when they need
// to enrol. Keeps the response small.
func (s *Store) ListClusterMembers(ctx context.Context, clusterID string) ([]ClusterMember, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT cluster_id::text, detection_id, similarity_to_centroid, added_at
		FROM face_cluster_members
		WHERE cluster_id = $1
		ORDER BY similarity_to_centroid DESC NULLS LAST, added_at DESC`,
		clusterID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]ClusterMember, 0, 16)
	for rows.Next() {
		var m ClusterMember
		var sim *float32
		if err := rows.Scan(&m.ClusterID, &m.DetectionID, &sim, &m.AddedAt); err != nil {
			return nil, err
		}
		if sim != nil {
			m.SimilarityToCentroid = *sim
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// AssignClusterToPerson adds the cluster members' embeddings to the
// given person (source="cluster-{first-8-of-id}-{detection_id}"),
// marks the cluster row as enrolled, and returns (added, skipped,
// quality-rejected) counts. Reuses AddEmbeddingsBulk so the batch is
// quality-gated + diversity-pruned and the matcher reload picks the
// new embeddings up on its next 30s tick. Members are submitted
// most-central-first so the pruner keeps the best exemplar and only
// genuinely different poses after it.
func (s *Store) AssignClusterToPerson(ctx context.Context, clusterID, personID string) (int, int, int, error) {
	// Fetch member embeddings directly from face_cluster_members
	// (the vector is stored there in pgvector's text form).
	rows, err := s.pool.Query(ctx, `
		SELECT detection_id, embedding::text
		FROM face_cluster_members WHERE cluster_id = $1
		ORDER BY similarity_to_centroid DESC NULLS LAST, added_at DESC`,
		clusterID)
	if err != nil {
		return 0, 0, 0, err
	}
	items := make([]struct {
		Vector      []float32
		Source      string
		DetectionID int64
	}, 0, 16)
	shortID := clusterID
	if len(shortID) > 8 {
		shortID = shortID[:8]
	}
	for rows.Next() {
		var detID int64
		var vecStr string
		if err := rows.Scan(&detID, &vecStr); err != nil {
			rows.Close()
			return 0, 0, 0, err
		}
		v, err := ParseVectorLiteral(vecStr)
		if err != nil {
			continue
		}
		items = append(items, struct {
			Vector      []float32
			Source      string
			DetectionID int64
		}{
			Vector:      v,
			Source:      fmt.Sprintf("cluster-%s-%d", shortID, detID),
			DetectionID: detID,
		})
	}
	rows.Close()
	if len(items) == 0 {
		return 0, 0, 0, errors.New("cluster has no members")
	}
	n, skipped, lowq, err := s.AddEmbeddingsBulk(ctx, personID, items)
	if err != nil {
		return n, skipped, lowq, err
	}
	// Mark the cluster as enrolled so /clusters?unenrolled=true hides
	// it on the next reload. added == 0 is still an enrolment: it
	// means the person's pool already covers every member pose.
	if _, err := s.pool.Exec(ctx, `
		UPDATE face_clusters SET enrolled_person_id = $2, updated_at = NOW()
		WHERE id = $1`, clusterID, personID); err != nil {
		return n, skipped, lowq, err
	}
	return n, skipped, lowq, nil
}

// DeleteCluster drops a cluster and cascades its members. Does not
// touch face_embeddings — an enrolled cluster already copied its
// members into face_embeddings; deleting it after enrolment is a
// "remove from review" action, not "undo enrolment".
func (s *Store) DeleteCluster(ctx context.Context, clusterID string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM face_clusters WHERE id = $1`, clusterID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
}

// DismissClusterAsNotAFace bulk-writes every member embedding into
// face_dismissals with reason='not_a_face', then drops the cluster.
// Atomic: either every member contributes training signal and the
// cluster disappears, or nothing changes. Returns the count of
// dismissal rows inserted or updated (usually == member_count;
// smaller only if some members were previously dismissed with a
// different reason, in which case ON CONFLICT upgrades them).
//
// No embedding round-trip through Go — both face_cluster_members and
// face_dismissals store vector(512), so the INSERT…SELECT copies the
// pgvector column directly.
func (s *Store) DismissClusterAsNotAFace(ctx context.Context, clusterID string) (int, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)

	// 1. Seed face_dismissals with every member. reason='not_a_face'
	//    so loadFaceNegatives() in event-processor picks them up on
	//    the next 30 s reload.
	tag, err := tx.Exec(ctx, `
		INSERT INTO face_dismissals (detection_id, embedding, reason)
		SELECT detection_id::text, embedding, 'not_a_face'
		FROM face_cluster_members
		WHERE cluster_id = $1
		ON CONFLICT (detection_id) DO UPDATE SET reason = 'not_a_face'`,
		clusterID)
	if err != nil {
		return 0, err
	}
	written := int(tag.RowsAffected())

	// 2. Drop the cluster; face_cluster_members cascades.
	delTag, err := tx.Exec(ctx,
		`DELETE FROM face_clusters WHERE id = $1`, clusterID)
	if err != nil {
		return 0, err
	}
	if delTag.RowsAffected() == 0 {
		return 0, pgx.ErrNoRows
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return written, nil
}

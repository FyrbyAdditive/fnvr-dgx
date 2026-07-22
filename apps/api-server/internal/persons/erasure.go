package persons

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

// ErasureReport is the response for the right-to-erasure flow.
// Counts are surfaced in the UI so the operator sees the scope of
// what was removed.
type ErasureReport struct {
	PersonID          string    `json:"person_id"`
	Label             string    `json:"label"`
	ErasedAt          time.Time `json:"erased_at"`
	ThumbsRemoved     int       `json:"thumbs_removed"`
	DetectionsNulled  int       `json:"detections_nulled"`
	EmbeddingsRemoved int       `json:"embeddings_removed"`
}

// ErasureRoot is the fallback thumbnail root when the Store was built
// without one. Matches the default FNVR_DATA_DIR; deployments that
// override DataDir get the real path via NewStore.
const ErasureRoot = "/var/lib/fnvr/thumbs/faces"

// Erase performs a record-purge erasure for a person. This is
// deliberately narrower than "scrub every trace": rec.mp4 and
// sidecar jsonl entries are left to age out via retention. We:
//
//   1. delete cached face-thumbnail JPEGs for detections that
//      matched this person,
//   2. strip person_id/person/similarity/embedding from those
//      detection rows (the row survives — other people may be in
//      the same frame),
//   3. delete face_embeddings owned by this person,
//   4. delete the person row,
//   5. write an erasure_audit row for compliance demonstrability.
func (s *Store) Erase(ctx context.Context, personID, actor string) (ErasureReport, error) {
	if actor == "" {
		actor = "system"
	}
	report := ErasureReport{
		PersonID: personID,
		ErasedAt: time.Now().UTC(),
	}

	// Preload the label so the audit row remembers who was erased.
	if err := s.pool.QueryRow(ctx,
		`SELECT label FROM persons WHERE id = $1`, personID,
	).Scan(&report.Label); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return report, ErrNotFound
		}
		return report, err
	}

	// 1. Fetch all detection ids matched to this person so we can
	//    remove their cached thumbnails. Limit to a big-but-sane
	//    ceiling — nobody should have millions of matched rows,
	//    and if they do something else is wrong.
	rows, err := s.pool.Query(ctx, `
		SELECT id FROM detections
		WHERE kind = 'face'
		  AND attributes->>'person_id' = $1
		LIMIT 1000000`, personID)
	if err != nil {
		return report, err
	}
	var detectionIDs []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return report, err
		}
		detectionIDs = append(detectionIDs, id)
	}
	rows.Close()

	// 2. Best-effort thumbnail delete. A missing file is fine (the
	//    cache is populated lazily); a permission error logs and
	//    moves on rather than aborting the erasure.
	thumbsRoot := s.thumbsRoot
	if thumbsRoot == "" {
		thumbsRoot = ErasureRoot
	}
	for _, id := range detectionIDs {
		path := filepath.Join(thumbsRoot, strconv.FormatInt(id, 10)+".jpg")
		if err := os.Remove(path); err != nil {
			if !errors.Is(err, os.ErrNotExist) {
				slog.Warn("erasure: thumbnail remove",
					"path", path, "err", err)
				continue
			}
			continue
		}
		report.ThumbsRemoved++
	}

	// 3-5. Do the PG mutations atomically so a crash between steps
	//      doesn't leave identity fields orphaned on detection rows
	//      without a matching person row.
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return report, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Strip identity fields from any matching detection row (keeps
	// bbox / confidence / kind — the detection itself still
	// happened, it just no longer points at an erased identity).
	tag, err := tx.Exec(ctx, `
		UPDATE detections
		SET attributes = attributes - 'person' - 'person_id'
		                  - 'similarity' - 'embedding'
		WHERE kind = 'face'
		  AND attributes->>'person_id' = $1`, personID)
	if err != nil {
		return report, err
	}
	report.DetectionsNulled = int(tag.RowsAffected())

	// Count embeddings before delete so the audit row records the
	// actual number; DELETE returns affected rows too, but the
	// count-then-delete makes the audit independent of RETURNING.
	if err := tx.QueryRow(ctx,
		`SELECT COUNT(*) FROM face_embeddings WHERE person_id = $1`,
		personID,
	).Scan(&report.EmbeddingsRemoved); err != nil {
		return report, err
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM face_embeddings WHERE person_id = $1`, personID,
	); err != nil {
		return report, err
	}

	// Delete the person. ON DELETE SET NULL on face_clusters means
	// any cluster that had pointed at this person becomes unenrolled
	// and will resurface in the /clusters review grid — which is
	// correct behaviour (the same faces are still appearing; the
	// operator can decide whether to re-enrol them as a different
	// person or leave them unmatched).
	if _, err := tx.Exec(ctx,
		`DELETE FROM persons WHERE id = $1`, personID,
	); err != nil {
		return report, err
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO erasure_audit
			(person_id, label, erased_by_user,
			 thumbs_removed, detections_nulled, embeddings_removed)
		VALUES ($1, $2, $3, $4, $5, $6)`,
		personID, report.Label, actor,
		report.ThumbsRemoved, report.DetectionsNulled,
		report.EmbeddingsRemoved,
	); err != nil {
		return report, err
	}

	if err := tx.Commit(ctx); err != nil {
		return report, fmt.Errorf("commit: %w", err)
	}
	return report, nil
}

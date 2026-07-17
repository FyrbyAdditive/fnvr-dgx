package persons

import (
	"context"
	"encoding/json"
)

// Enrolment diversity pruning: the matcher scores a probe by the mean
// of its top-3 cosines against a person's pool, so three near-copies
// of one frame act as a single vote counted three times — they
// inflate scores for that one pose and add nothing for any other.
// Clusters and multi-select batches are full of such near-copies.
// PruneEnrolBatch greedily keeps only candidates that are genuinely
// new: not a near-duplicate of the person's existing pool, nor of a
// candidate already kept, capped per action so a huge selection can't
// flood the pool. Candidate order is priority order — callers put the
// best exemplar first (clusters order by similarity to centroid).

// PruneEnrolBatch returns the indices of cands to keep. A candidate
// is skipped when its cosine to any existing vector or any
// already-kept candidate exceeds maxSim, or once maxNew have been
// kept. skipped counts only near-duplicate rejections, not the
// over-cap remainder — the cap is a flood guard, not a quality
// signal, but both are excluded from keep.
func PruneEnrolBatch(existing, cands [][]float32, maxSim float64, maxNew int) (keep []int, skipped int) {
	kept := make([][]float32, 0, len(cands))
	for i, c := range cands {
		if len(keep) >= maxNew {
			skipped += len(cands) - i
			break
		}
		dup := false
		for _, e := range existing {
			if float64(cosineSim(c, e)) > maxSim {
				dup = true
				break
			}
		}
		if !dup {
			for _, k := range kept {
				if float64(cosineSim(c, k)) > maxSim {
					dup = true
					break
				}
			}
		}
		if dup {
			skipped++
			continue
		}
		keep = append(keep, i)
		kept = append(kept, c)
	}
	return keep, skipped
}

// enrolParams reads the enrolment pruning tunables, mirroring the
// whitelist's defaults and clamps (fail open on any read error).
func (s *Store) enrolParams(ctx context.Context) (dedupSim float64, maxPerAction int) {
	dedupSim, maxPerAction = 0.90, 8
	var raw []byte
	if err := s.pool.QueryRow(ctx,
		`SELECT value FROM settings WHERE key = 'faces.enrol.dedup_similarity'`).Scan(&raw); err == nil {
		var v float64
		if json.Unmarshal(raw, &v) == nil && v >= 0.5 && v <= 0.999 {
			dedupSim = v
		}
	}
	raw = nil
	if err := s.pool.QueryRow(ctx,
		`SELECT value FROM settings WHERE key = 'faces.enrol.max_per_action'`).Scan(&raw); err == nil {
		var v float64
		if json.Unmarshal(raw, &v) == nil && v >= 1 && v <= 50 {
			maxPerAction = int(v)
		}
	}
	return
}

// personVectors loads a person's current embedding pool for dedup.
func (s *Store) personVectors(ctx context.Context, personID string) ([][]float32, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT embedding::text FROM face_embeddings WHERE person_id = $1`, personID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([][]float32, 0, 16)
	for rows.Next() {
		var vecStr string
		if err := rows.Scan(&vecStr); err != nil {
			return nil, err
		}
		if v, err := ParseVectorLiteral(vecStr); err == nil {
			out = append(out, v)
		}
	}
	return out, rows.Err()
}

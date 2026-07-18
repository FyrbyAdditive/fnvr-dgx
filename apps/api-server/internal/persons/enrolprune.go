package persons

import (
	"context"
	"encoding/json"
	"math"
	"strconv"
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

// enrolQualityParams reads the enrolment quality gates (whitelist
// defaults/clamps mirrored; fail open).
func (s *Store) enrolQualityParams(ctx context.Context) (minDet, maxYaw, minBlur float64) {
	minDet, maxYaw, minBlur = 0.5, 0.35, 30
	read := func(key string, def, lo, hi float64) float64 {
		var raw []byte
		if err := s.pool.QueryRow(ctx,
			`SELECT value FROM settings WHERE key = $1`, key).Scan(&raw); err != nil {
			return def
		}
		var v float64
		if json.Unmarshal(raw, &v) != nil || v < lo || v > hi {
			return def
		}
		return v
	}
	minDet = read("faces.enrol.min_det_score", 0.5, 0, 0.99)
	maxYaw = read("faces.enrol.max_abs_yaw", 0.35, 0.05, 1.0)
	minBlur = read("faces.enrol.min_blur", 30, 0, 500)
	return
}

// filterEnrolQuality drops candidate detection ids that fail the
// quality gates, using the signals ml-worker stamped on the detection
// rows (det_score, yaw, blur). MATCHING uses every sample — these
// gates only protect the person's ENROLMENT pool from turned, blurred
// or marginal faces that would dilute its top-3 corroboration.
// Fail-open by design: ids with no row (hot-table pruned), no signals
// (pre-rework rows), or a query error pass through — an operator who
// can see the tile can enrol it.
func (s *Store) filterEnrolQuality(ctx context.Context, ids []int64) map[int64]bool {
	rejected := map[int64]bool{}
	if len(ids) == 0 {
		return rejected
	}
	minDet, maxYaw, minBlur := s.enrolQualityParams(ctx)
	rows, err := s.pool.Query(ctx, `
		SELECT id,
		       attributes->>'det_score',
		       attributes->>'yaw',
		       attributes->>'blur'
		FROM detections
		WHERE id = ANY($1) AND kind = 'face'`, ids)
	if err != nil {
		return rejected
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var det, yaw, blur *string
		if rows.Scan(&id, &det, &yaw, &blur) != nil {
			continue
		}
		parse := func(p *string) (float64, bool) {
			if p == nil {
				return 0, false
			}
			v, err := strconv.ParseFloat(*p, 64)
			return v, err == nil
		}
		if v, ok := parse(det); ok && v < minDet {
			rejected[id] = true
		}
		if v, ok := parse(yaw); ok && math.Abs(v) > maxYaw {
			rejected[id] = true
		}
		if v, ok := parse(blur); ok && v < minBlur {
			rejected[id] = true
		}
	}
	return rejected
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

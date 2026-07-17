package persons

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

// Retro-matching: the live matcher (event-processor) only scores a
// face at INSERT time, so detections that arrived before a person was
// enrolled stay "unmatched" forever — the review queue keeps showing
// a now-known person as a stranger. RetroMatch re-scores the recent
// unmatched face rows against the current enrolment set using the
// SAME logic as the live matcher (top-3-mean per person, threshold +
// runner-up margin, negative veto) and flips winners to matched:
// they leave the unmatched queue and appear in the person's history.
//
// Called after every enrolment path (bulk add, cluster enrol, photo
// upload). The scan window mirrors the review queue's maximum (7
// days); with capture limiting live the candidate set is small.

// retroCandidateWindow matches the review queue's max lookback.
const retroCandidateWindow = 7 * 24 * time.Hour

// RetroMatch scans recent unmatched face detections and assigns the
// best-scoring enrolled person to each row that clears the matcher's
// acceptance rules. Returns the number of rows updated.
func (s *Store) RetroMatch(ctx context.Context) (int, error) {
	enrolled, err := s.AllEmbeddings(ctx)
	if err != nil {
		return 0, err
	}
	if len(enrolled) == 0 {
		return 0, nil
	}
	negatives, err := s.AllNegatives(ctx)
	if err != nil {
		return 0, err
	}
	thresh, margin, negW := s.matchParams(ctx)

	rows, err := s.pool.Query(ctx, `
		SELECT id, attributes->>'embedding'
		FROM detections
		WHERE kind = 'face'
		  AND ts > $1
		  AND attributes->>'person_id' IS NULL
		  AND attributes ? 'embedding'`,
		time.Now().Add(-retroCandidateWindow))
	if err != nil {
		return 0, err
	}
	type cand struct {
		id  int64
		b64 string
	}
	cands := make([]cand, 0, 256)
	for rows.Next() {
		var c cand
		if rows.Scan(&c.id, &c.b64) == nil && c.b64 != "" {
			cands = append(cands, c)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}

	updated := 0
	for _, c := range cands {
		probe := decodeEmbeddingBase64(c.b64)
		if probe == nil {
			continue
		}
		pid, label, sim, ok := scoreProbe(probe, enrolled, negatives, thresh, margin, negW)
		if !ok {
			continue
		}
		// Mirror the live matcher's matched-row shape: person fields
		// in, raw embedding (and its UI-dedup hash) out.
		attrs, _ := json.Marshal(map[string]any{
			"person":     label,
			"person_id":  pid,
			"similarity": sim,
		})
		tag, err := s.pool.Exec(ctx, `
			UPDATE detections
			SET attributes = (attributes - 'embedding' - 'embedding_hash') || $2::jsonb
			WHERE id = $1 AND attributes->>'person_id' IS NULL`,
			c.id, string(attrs))
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				continue
			}
			return updated, err
		}
		updated += int(tag.RowsAffected())
	}
	return updated, nil
}

// scoreProbe applies the live matcher's acceptance rules: per-person
// mean of the top-3 cosines, threshold, runner-up margin when more
// than one person is enrolled, and the dismissed-negative veto.
func scoreProbe(
	probe []float32,
	enrolled []EnrolledEmbedding,
	negatives []DismissedEmbedding,
	thresh, margin, negW float64,
) (personID, label string, sim float32, ok bool) {
	simsByPerson := map[string][]float32{}
	labelByPerson := map[string]string{}
	for i := range enrolled {
		e := &enrolled[i]
		simsByPerson[e.PersonID] = append(simsByPerson[e.PersonID], cosineSim(probe, e.Vector))
		labelByPerson[e.PersonID] = e.Label
	}
	type score struct {
		pid  string
		topK float32
	}
	scores := make([]score, 0, len(simsByPerson))
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
		scores = append(scores, score{pid: pid, topK: sum / float32(k)})
	}
	sort.Slice(scores, func(i, j int) bool { return scores[i].topK > scores[j].topK })

	if len(scores) == 0 || float64(scores[0].topK) < thresh {
		return "", "", 0, false
	}
	if len(scores) > 1 && float64(scores[0].topK-scores[1].topK) < margin {
		return "", "", 0, false
	}
	if negW > 0 && len(negatives) > 0 {
		var negSim float32
		for i := range negatives {
			if s := cosineSim(probe, negatives[i].Vector); s > negSim {
				negSim = s
			}
		}
		if float64(scores[0].topK-float32(negW)*negSim) < thresh {
			return "", "", 0, false
		}
	}
	best := scores[0]
	return best.pid, labelByPerson[best.pid], best.topK, true
}

// matchParams reads the same settings rows the live matcher reloads,
// with identical defaults and clamps.
func (s *Store) matchParams(ctx context.Context) (thresh, margin, negW float64) {
	thresh, margin, negW = 0.40, 0.05, 1.0
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
	thresh = read("faces.match_threshold", 0.40, 0.01, 0.99)
	margin = read("faces.match_margin", 0.05, 0, 0.5)
	negW = read("faces.negative_penalty_weight", 1.0, 0, 2)
	return
}

// decodeEmbeddingBase64 decodes the probe's base64 512×float32 (LE)
// blob — the same wire format the pipeline publishes.
func decodeEmbeddingBase64(s string) []float32 {
	raw, err := base64.StdEncoding.DecodeString(s)
	if err != nil || len(raw) != 512*4 {
		return nil
	}
	out := make([]float32, 512)
	for i := range out {
		out[i] = math.Float32frombits(binary.LittleEndian.Uint32(raw[i*4:]))
	}
	return out
}

func cosineSim(a, b []float32) float32 {
	if len(a) != len(b) || len(a) == 0 {
		return 0
	}
	var dot, na, nb float64
	for i := range a {
		dot += float64(a[i]) * float64(b[i])
		na += float64(a[i]) * float64(a[i])
		nb += float64(b[i]) * float64(b[i])
	}
	if na == 0 || nb == 0 {
		return 0
	}
	return float32(dot / (math.Sqrt(na) * math.Sqrt(nb)))
}

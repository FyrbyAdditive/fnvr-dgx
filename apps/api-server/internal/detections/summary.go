package detections

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/fnvr/fnvr/apps/api-server/internal/segments"
)

// Summary aggregates detections into fixed time buckets server-side so
// the Timeline can render a faithful full-day activity band without
// shipping (or truncating at) thousands of raw rows. Same hot-PG +
// cold-JSONL union as List: Postgres does the heavy grouping for the
// hot window, sidecar files are scanned with a lean decoder for the
// cold range, and both feed one reducer.

type SummaryArgs struct {
	CameraID string    // required
	From     time.Time // required, From < To
	To       time.Time
	Buckets  int // 1..1000; out-of-range defaults to 288 (5-min buckets over a day)
}

type ClassCount struct {
	Class string `json:"class"`
	Count int    `json:"count"`
}

type SummaryBucket struct {
	// I is the bucket index within [From, To); empty buckets are
	// omitted, so the slice is sparse and ascending.
	I          int          `json:"i"`
	Count      int          `json:"count"`
	MaxConf    float32      `json:"max_confidence"`
	TopClasses []ClassCount `json:"top_classes"`
	Kinds      []string     `json:"kinds"`
}

type SummaryResult struct {
	From     time.Time       `json:"from"`
	To       time.Time       `json:"to"`
	BucketMS int64           `json:"bucket_ms"`
	Buckets  []SummaryBucket `json:"buckets"`
}

// classKind keys the per-bucket aggregation; kind is already
// defaulted to "object" by the time it lands here.
type classKind struct{ class, kind string }

type aggCell struct {
	n       int
	maxConf float32
}

type summaryAgg map[int]map[classKind]*aggCell

func (m summaryAgg) add(i int, class, kind string, n int, maxConf float32) {
	b := m[i]
	if b == nil {
		b = map[classKind]*aggCell{}
		m[i] = b
	}
	k := classKind{class: class, kind: kind}
	c := b[k]
	if c == nil {
		b[k] = &aggCell{n: n, maxConf: maxConf}
		return
	}
	c.n += n
	if maxConf > c.maxConf {
		c.maxConf = maxConf
	}
}

// bucketIndex maps ts to its bucket in [from, to) split n ways,
// mirroring Postgres width_bucket()'s float arithmetic. Out-of-range
// results are clamped so boundary rounding can't index past the ends.
func bucketIndex(from, to time.Time, n int, ts time.Time) int {
	i := int(float64(ts.Sub(from)) / float64(to.Sub(from)) * float64(n))
	if i < 0 {
		return 0
	}
	if i >= n {
		return n - 1
	}
	return i
}

func (s *Store) Summary(ctx context.Context, a SummaryArgs) (*SummaryResult, error) {
	if a.CameraID == "" || a.From.IsZero() || a.To.IsZero() || !a.To.After(a.From) {
		return nil, errors.New("summary: camera_id and from < to are required")
	}
	if a.Buckets < 1 || a.Buckets > 1000 {
		a.Buckets = 288
	}

	hotHours, _ := s.hotHours(ctx)
	var hotCutoff time.Time
	if hotHours > 0 {
		hotCutoff = time.Now().Add(-time.Duration(hotHours) * time.Hour)
	}

	agg := summaryAgg{}
	pgFrom := a.From
	if !hotCutoff.IsZero() && a.From.Before(hotCutoff) {
		coldTo := a.To
		if coldTo.After(hotCutoff) {
			coldTo = hotCutoff
		}
		if err := s.aggregateSidecars(ctx, a, coldTo, agg); err != nil {
			return nil, err
		}
		pgFrom = hotCutoff
	}
	if pgFrom.Before(a.To) {
		if err := s.aggregatePG(ctx, a, pgFrom, agg); err != nil {
			return nil, err
		}
	}

	return &SummaryResult{
		From:     a.From,
		To:       a.To,
		BucketMS: a.To.Sub(a.From).Milliseconds() / int64(a.Buckets),
		Buckets:  reduceSummary(agg),
	}, nil
}

// aggregatePG groups the [pgFrom, a.To) range in one indexed query;
// buckets stay anchored to a.From so hot and cold halves line up.
func (s *Store) aggregatePG(ctx context.Context, a SummaryArgs, pgFrom time.Time, agg summaryAgg) error {
	rows, err := s.pool.Query(ctx, `
		SELECT width_bucket(extract(epoch from ts),
		                    extract(epoch from $2::timestamptz),
		                    extract(epoch from $3::timestamptz), $4) - 1 AS i,
		       class_name,
		       COALESCE(NULLIF(kind, ''), 'object') AS kind,
		       count(*), max(confidence)
		FROM detections
		WHERE camera_id = $1 AND ts >= $5 AND ts < $3
		GROUP BY 1, 2, 3`,
		a.CameraID, a.From, a.To, a.Buckets, pgFrom)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			i       int
			class   string
			kind    string
			n       int64
			maxConf float32
		)
		if err := rows.Scan(&i, &class, &kind, &n, &maxConf); err != nil {
			return err
		}
		if i < 0 {
			i = 0
		}
		if i >= a.Buckets {
			i = a.Buckets - 1
		}
		agg.add(i, class, kind, int(n), maxConf)
	}
	return rows.Err()
}

// leanSidecarEvent decodes only the fields the aggregation needs —
// bbox/attributes stay raw bytes the scanner skips over.
type leanSidecarEvent struct {
	CameraID   string    `json:"camera_id"`
	TS         time.Time `json:"ts"`
	ClassName  string    `json:"class_name"`
	Kind       string    `json:"kind,omitempty"`
	Confidence float32   `json:"confidence"`
}

func (s *Store) aggregateSidecars(ctx context.Context, a SummaryArgs, coldTo time.Time, agg summaryAgg) error {
	segs, err := s.segments.List(ctx, segments.ListQuery{
		CameraID: a.CameraID,
		From:     a.From,
		To:       coldTo,
		Limit:    2000,
	})
	if err != nil {
		return err
	}
	for _, seg := range segs {
		clean := filepath.Clean(seg.Path)
		if !strings.HasPrefix(clean+string(filepath.Separator), s.root+string(filepath.Separator)) {
			continue
		}
		if err := aggregateSidecarFile(sidecarPath(clean), a, coldTo, agg); err != nil {
			// Missing sidecar = hour with zero detections or a segment
			// predating the feature; anything else is also non-fatal
			// for an aggregate view.
			continue
		}
	}
	return nil
}

func aggregateSidecarFile(path string, a SummaryArgs, coldTo time.Time, agg summaryAgg) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), 256*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var ev leanSidecarEvent
		if err := json.Unmarshal(line, &ev); err != nil {
			continue // truncated last line or garbage
		}
		if ev.CameraID != a.CameraID {
			continue
		}
		if ev.TS.Before(a.From) || !ev.TS.Before(coldTo) {
			continue
		}
		kind := ev.Kind
		if kind == "" {
			kind = "object"
		}
		agg.add(bucketIndex(a.From, a.To, a.Buckets, ev.TS), ev.ClassName, kind, 1, ev.Confidence)
	}
	return scanner.Err()
}

// reduceSummary flattens the aggregation into the sparse on-wire shape:
// per bucket a total count, overall max confidence, top-3 classes by
// count (ties broken by name for determinism), and the set of kinds.
func reduceSummary(agg summaryAgg) []SummaryBucket {
	out := make([]SummaryBucket, 0, len(agg))
	for i, cells := range agg {
		b := SummaryBucket{I: i}
		classTotals := map[string]int{}
		kindSet := map[string]bool{}
		for k, c := range cells {
			b.Count += c.n
			if c.maxConf > b.MaxConf {
				b.MaxConf = c.maxConf
			}
			classTotals[k.class] += c.n
			kindSet[k.kind] = true
		}
		classes := make([]ClassCount, 0, len(classTotals))
		for class, n := range classTotals {
			classes = append(classes, ClassCount{Class: class, Count: n})
		}
		sort.Slice(classes, func(x, y int) bool {
			if classes[x].Count != classes[y].Count {
				return classes[x].Count > classes[y].Count
			}
			return classes[x].Class < classes[y].Class
		})
		if len(classes) > 3 {
			classes = classes[:3]
		}
		b.TopClasses = classes
		for kind := range kindSet {
			b.Kinds = append(b.Kinds, kind)
		}
		sort.Strings(b.Kinds)
		out = append(out, b)
	}
	sort.Slice(out, func(x, y int) bool { return out[x].I < out[y].I })
	return out
}

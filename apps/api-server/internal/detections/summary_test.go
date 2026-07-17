package detections

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

var (
	day0 = time.Date(2026, 7, 16, 0, 0, 0, 0, time.UTC)
	day1 = day0.Add(24 * time.Hour)
)

func TestBucketIndex(t *testing.T) {
	const n = 288 // 5-min buckets over a day
	cases := []struct {
		name string
		ts   time.Time
		want int
	}{
		{"at from", day0, 0},
		{"just under first boundary", day0.Add(5*time.Minute - time.Millisecond), 0},
		{"exactly second bucket", day0.Add(5 * time.Minute), 1},
		{"just under to", day1.Add(-time.Millisecond), n - 1},
		{"at to clamps", day1, n - 1},
		{"before from clamps", day0.Add(-time.Hour), 0},
	}
	for _, c := range cases {
		if got := bucketIndex(day0, day1, n, c.ts); got != c.want {
			t.Errorf("%s: got %d want %d", c.name, got, c.want)
		}
	}
}

func TestReduceSummary(t *testing.T) {
	agg := summaryAgg{}
	// Bucket 7: four classes so top-3 truncates; count tie between cat
	// and dog resolves alphabetically.
	agg.add(7, "person", "object", 10, 0.91)
	agg.add(7, "person", "object", 5, 0.85) // merges into person=15
	agg.add(7, "car", "object", 9, 0.60)
	agg.add(7, "dog", "object", 2, 0.99)
	agg.add(7, "cat", "object", 2, 0.10)
	agg.add(7, "car", "anpr", 1, 0.75) // car total 10, adds anpr kind
	// Bucket 2 (out of order on purpose — output must sort ascending).
	agg.add(2, "person", "object", 1, 0.5)

	got := reduceSummary(agg)
	if len(got) != 2 {
		t.Fatalf("got %d buckets, want 2", len(got))
	}
	if got[0].I != 2 || got[1].I != 7 {
		t.Fatalf("bucket order: got [%d %d], want [2 7]", got[0].I, got[1].I)
	}
	b := got[1]
	if b.Count != 29 {
		t.Errorf("count: got %d want 29", b.Count)
	}
	if b.MaxConf != 0.99 {
		t.Errorf("max_confidence: got %v want 0.99", b.MaxConf)
	}
	wantClasses := []ClassCount{{"person", 15}, {"car", 10}, {"cat", 2}}
	if !reflect.DeepEqual(b.TopClasses, wantClasses) {
		t.Errorf("top_classes: got %+v want %+v", b.TopClasses, wantClasses)
	}
	if !reflect.DeepEqual(b.Kinds, []string{"anpr", "object"}) {
		t.Errorf("kinds: got %v want [anpr object]", b.Kinds)
	}
}

func TestAggregateSidecarFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "rec.jsonl")
	lines := `{"id":"e1","camera_id":"cam1","ts":"2026-07-16T00:01:00Z","class_name":"person","confidence":0.9,"bbox":{"x":1,"y":2,"w":3,"h":4}}
{"id":"e2","camera_id":"cam1","ts":"2026-07-16T00:02:00Z","class_name":"car","kind":"anpr","confidence":0.7,"attributes":{"plate":"AB12CDE"}}
{"id":"e3","camera_id":"other","ts":"2026-07-16T00:03:00Z","class_name":"person","confidence":0.9}
{"id":"e4","camera_id":"cam1","ts":"2026-07-15T23:59:59Z","class_name":"person","confidence":0.9}
{"id":"e5","camera_id":"cam1","ts":"2026-07-16T12:00:00Z","class_name":"person","confidence":0.9}
this line is garbage and must be skipped
{"id":"e6","camera_id":"cam1","ts":"2026-07-16T00:04:30Z","class_name":"person","confidence":0.95}
`
	if err := os.WriteFile(path, []byte(lines), 0o644); err != nil {
		t.Fatal(err)
	}

	a := SummaryArgs{CameraID: "cam1", From: day0, To: day1, Buckets: 288}
	coldTo := day0.Add(6 * time.Hour) // e5 at 12:00 is beyond the cold range
	agg := summaryAgg{}
	if err := aggregateSidecarFile(path, a, coldTo, agg); err != nil {
		t.Fatal(err)
	}

	got := reduceSummary(agg)
	if len(got) != 1 {
		t.Fatalf("got %d buckets, want 1 (all rows in bucket 0): %+v", len(got), got)
	}
	b := got[0]
	// e1, e2, e6 pass the filters (e3 wrong camera, e4 before from,
	// e5 past coldTo, garbage skipped).
	if b.I != 0 || b.Count != 3 {
		t.Fatalf("got bucket i=%d count=%d, want i=0 count=3", b.I, b.Count)
	}
	if b.MaxConf != 0.95 {
		t.Errorf("max_confidence: got %v want 0.95", b.MaxConf)
	}
	wantClasses := []ClassCount{{"person", 2}, {"car", 1}}
	if !reflect.DeepEqual(b.TopClasses, wantClasses) {
		t.Errorf("top_classes: got %+v want %+v", b.TopClasses, wantClasses)
	}
	if !reflect.DeepEqual(b.Kinds, []string{"anpr", "object"}) {
		t.Errorf("kinds (default 'object' + anpr): got %v", b.Kinds)
	}
}

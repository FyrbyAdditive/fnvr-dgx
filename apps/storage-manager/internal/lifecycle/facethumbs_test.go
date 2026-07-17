package lifecycle

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestFaceThumbReferenced(t *testing.T) {
	keepIDs := map[int64]struct{}{42: {}, 777: {}}
	keepUploads := map[string]struct{}{"upload-abcd1234": {}}
	cases := []struct {
		name string
		want bool
	}{
		{"42.jpg", true},          // enrolled pg id
		{"43.jpg", false},         // unenrolled pg id
		{"upload-abcd1234.jpg", true},
		{"upload-deadbeef.jpg", false},
		{"a1b2c3d4e5f6.jpg", false}, // hex event_id orphan
		{"777.jpg", true},           // digit-only name colliding with pg id — kept (fail-safe)
	}
	for _, c := range cases {
		if got := faceThumbReferenced(c.name, keepIDs, keepUploads); got != c.want {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}

func TestPruneFaceThumbDir(t *testing.T) {
	dir := t.TempDir()
	old := time.Now().Add(-40 * 24 * time.Hour)
	write := func(name string, mod time.Time) {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("jpg"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, mod, mod); err != nil {
			t.Fatal(err)
		}
	}
	write("42.jpg", old)               // enrolled, old → kept
	write("99.jpg", old)               // unreferenced, old → deleted
	write("100.jpg", time.Now())       // unreferenced, fresh → kept (age gate)
	write("upload-abcd1234.jpg", old)  // referenced upload → kept
	write("upload-zzzz0000.jpg", old)  // unreferenced upload, old → deleted
	write("deadbeefcafe.jpg", old)     // hex orphan, old → deleted
	write("notes.txt", old)            // non-jpg → untouched

	cutoff := time.Now().Add(-30 * 24 * time.Hour)
	deleted, kept := pruneFaceThumbDir(dir, cutoff,
		map[int64]struct{}{42: {}},
		map[string]struct{}{"upload-abcd1234": {}})

	if deleted != 3 {
		t.Errorf("deleted: got %d want 3", deleted)
	}
	if kept != 2 {
		t.Errorf("kept-by-reference: got %d want 2", kept)
	}
	for _, want := range []string{"42.jpg", "100.jpg", "upload-abcd1234.jpg", "notes.txt"} {
		if _, err := os.Stat(filepath.Join(dir, want)); err != nil {
			t.Errorf("%s should survive: %v", want, err)
		}
	}
	for _, gone := range []string{"99.jpg", "upload-zzzz0000.jpg", "deadbeefcafe.jpg"} {
		if _, err := os.Stat(filepath.Join(dir, gone)); !os.IsNotExist(err) {
			t.Errorf("%s should be deleted", gone)
		}
	}
}

func TestPruneFaceThumbDirMissing(t *testing.T) {
	deleted, kept := pruneFaceThumbDir("/nonexistent/path", time.Now(), nil, nil)
	if deleted != 0 || kept != 0 {
		t.Error("missing dir must be a no-op")
	}
}

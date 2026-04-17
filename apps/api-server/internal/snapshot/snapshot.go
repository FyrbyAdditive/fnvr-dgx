// Package snapshot extracts a JPEG thumbnail from the most-recent recorded
// segment for a camera. It shells out to ffmpeg and caches results briefly.
//
// Pre-WebRTC live view — when M3 lands webrtcbin streams, the Live tiles
// switch to WebRTC and this endpoint stays around as a fallback for mobile
// / bandwidth-constrained clients.
package snapshot

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

var ErrNoSegments = errors.New("no segments for camera")

type Service struct {
	recordingsDir string
	liveDir       string
	cacheTTL      time.Duration

	mu    sync.Mutex
	cache map[string]cachedEntry // camera_id -> entry
}

type cachedEntry struct {
	jpg     []byte
	stamped time.Time
}

func New(recordingsDir string) *Service {
	return &Service{
		recordingsDir: recordingsDir,
		liveDir:       "/var/lib/fnvr/live",
		cacheTTL:      1 * time.Second,
		cache:         map[string]cachedEntry{},
	}
}

// Snapshot returns a JPEG of the first frame of the most-recent segment for
// the camera, or ErrNoSegments if none found. Results are cached for a few
// seconds so a page full of tiles doesn't hammer ffmpeg.
func (s *Service) Snapshot(ctx context.Context, cameraID string) ([]byte, error) {
	s.mu.Lock()
	if e, ok := s.cache[cameraID]; ok && time.Since(e.stamped) < s.cacheTTL {
		defer s.mu.Unlock()
		return e.jpg, nil
	}
	s.mu.Unlock()

	// Fast path: the pipeline writes a 1 fps ring of indexed JPEGs at
	// /var/lib/fnvr/live/<id>.<n>.jpg. Pick the newest complete one.
	if jpg, ok := s.readLiveJpeg(cameraID); ok {
		s.mu.Lock()
		s.cache[cameraID] = cachedEntry{jpg: jpg, stamped: time.Now()}
		s.mu.Unlock()
		return jpg, nil
	}

	segs, err := s.candidateSegments(cameraID)
	if err != nil {
		return nil, err
	}

	// Walk newer-to-older, skipping unfinished / corrupt segments (missing
	// moov atom, mid-write). Bail after a handful of tries so a pathological
	// camera doesn't spin through dozens of bad files.
	const maxTries = 5
	try := 0
	for _, seg := range segs {
		if try >= maxTries {
			break
		}
		try++
		jpg, err := s.extractFirstFrame(ctx, seg)
		if err == nil {
			s.mu.Lock()
			s.cache[cameraID] = cachedEntry{jpg: jpg, stamped: time.Now()}
			s.mu.Unlock()
			return jpg, nil
		}
		// Loop on any ffmpeg failure — "moov atom not found", truncated
		// reads, codec negotiation, all fatal-for-this-file but not for us.
	}
	return nil, ErrNoSegments
}

// readLiveJpeg picks the newest-but-one JPEG from the pipeline's live ring.
// The newest file may be half-written; one back is safe. A valid JPEG
// always starts with FF D8 and ends with FF D9, so we validate before
// returning. Returns false when no live ring exists (pipeline down, or
// first frame not written yet).
func (s *Service) readLiveJpeg(cameraID string) ([]byte, bool) {
	matches, err := filepath.Glob(filepath.Join(s.liveDir, cameraID+".*.jpg"))
	if err != nil || len(matches) == 0 {
		return nil, false
	}

	// Sort descending by mtime.
	type ent struct {
		path string
		mod  time.Time
	}
	list := make([]ent, 0, len(matches))
	for _, p := range matches {
		info, err := os.Stat(p)
		if err != nil {
			continue
		}
		list = append(list, ent{p, info.ModTime()})
	}
	for i := range list {
		for j := i + 1; j < len(list); j++ {
			if list[j].mod.After(list[i].mod) {
				list[i], list[j] = list[j], list[i]
			}
		}
	}
	// Skip the newest (may be mid-write), try the rest.
	start := 1
	if len(list) < 2 {
		start = 0
	}
	for i := start; i < len(list); i++ {
		b, err := os.ReadFile(list[i].path)
		if err != nil || len(b) < 4 {
			continue
		}
		if b[0] != 0xFF || b[1] != 0xD8 || b[len(b)-2] != 0xFF || b[len(b)-1] != 0xD9 {
			continue // truncated
		}
		// Freshness gate: if even the "safe" file is older than 10s, the
		// pipeline is probably dead — fall back to segment extraction so
		// the user sees something rather than a frozen image.
		if time.Since(list[i].mod) > 10*time.Second {
			return nil, false
		}
		return b, true
	}
	return nil, false
}

func (s *Service) extractFirstFrame(ctx context.Context, seg string) ([]byte, error) {
	tmp, err := os.CreateTemp("", "fnvr-snap-*.jpg")
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmp.Name())
	tmp.Close()

	cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, "ffmpeg",
		"-nostdin", "-hide_banner", "-loglevel", "error",
		"-ss", "0", "-i", seg,
		"-frames:v", "1", "-q:v", "5", "-vf", "scale=480:-2",
		"-y", tmp.Name(),
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("ffmpeg: %w — %s", err, string(out))
	}
	return os.ReadFile(tmp.Name())
}

// candidateSegments returns the camera's .mp4 files ordered newest-first
// with the newest dropped (still being written — no moov atom). Caller
// iterates until one yields a frame.
func (s *Service) candidateSegments(cameraID string) ([]string, error) {
	type segStat struct {
		path string
		mod  time.Time
	}
	var found []segStat

	err := filepath.WalkDir(s.recordingsDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if filepath.Base(filepath.Dir(path)) != cameraID {
			return nil
		}
		if filepath.Ext(path) != ".mp4" {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		found = append(found, segStat{path: path, mod: info.ModTime()})
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(found) == 0 {
		return nil, ErrNoSegments
	}
	// Sort descending by mtime.
	for i := range found {
		for j := i + 1; j < len(found); j++ {
			if found[j].mod.After(found[i].mod) {
				found[i], found[j] = found[j], found[i]
			}
		}
	}
	// Drop the newest (likely still open, no moov). If only one, return it
	// anyway — better than always-empty.
	paths := make([]string, 0, len(found))
	start := 1
	if len(found) < 2 {
		start = 0
	}
	for i := start; i < len(found); i++ {
		paths = append(paths, found[i].path)
	}
	return paths, nil
}

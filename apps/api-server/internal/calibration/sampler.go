// Package calibration produces a set of JPEG frames sampled from the
// operator's own camera recordings, for use as INT8 calibration input
// to trtexec on the pipeline container. Images sampled from the
// deployment distribution quantise better than generic COCO samples.
//
// Design notes:
//   - We walk /var/lib/fnvr/recordings/YYYY/MM/DD/HH/<camera>/rec.mp4
//     (the hour-bucketed layout the pipeline writes).
//   - Sampling is bucketed: the lookback window is split into
//     TargetCount equal time buckets; we take at most one keyframe
//     per bucket, round-robin across cameras so a chatty camera
//     doesn't dominate quantisation.
//   - Writes land in calib_images.tmp/ and are renamed to
//     calib_images/ on successful completion; a partial crash leaves
//     an incomplete tmp dir that the entrypoint ignores.
package calibration

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type Config struct {
	// ModelDir is the yolo26 model cache. Samples land under
	// ModelDir/calib_images/. Defaults to /var/lib/fnvr/models/yolo26.
	ModelDir string
	// RecordingsRoot is the hour-bucketed recordings root.
	// Defaults to /var/lib/fnvr/recordings.
	RecordingsRoot string
	// LookbackHours is how far back to reach for source frames.
	// Default 4 hours; bump if cameras are quiet.
	LookbackHours int
	// TargetCount is the number of frames to produce. Default 500.
	TargetCount int
	// Progress, if non-nil, is called after each write with the
	// current frame count. Used to surface progress in the UI.
	Progress func(written int)
}

type Result struct {
	Written int
	Skipped int
	Took    time.Duration
}

// SampleFromRecordings runs one end-to-end sampling pass. The caller
// should run this from a goroutine — it can take several seconds to
// a minute depending on how many mp4s get seeked.
func SampleFromRecordings(ctx context.Context, cfg Config) (Result, error) {
	if cfg.ModelDir == "" {
		cfg.ModelDir = "/var/lib/fnvr/models/yolo26"
	}
	if cfg.RecordingsRoot == "" {
		cfg.RecordingsRoot = "/var/lib/fnvr/recordings"
	}
	if cfg.LookbackHours <= 0 {
		// 24h default — wide enough to tolerate gaps when cameras
		// were restarting during development / intermittent RTSP
		// outages. The sampler just takes what it can get; the
		// calibrator only needs ≥100 frames.
		cfg.LookbackHours = 24
	}
	if cfg.TargetCount <= 0 {
		cfg.TargetCount = 500
	}

	start := time.Now()
	tmpDir := filepath.Join(cfg.ModelDir, "calib_images.tmp")
	dstDir := filepath.Join(cfg.ModelDir, "calib_images")
	// Fresh tmp dir so a prior aborted run can't poison results.
	if err := os.RemoveAll(tmpDir); err != nil && !errors.Is(err, os.ErrNotExist) {
		return Result{}, fmt.Errorf("remove tmp: %w", err)
	}
	if err := os.MkdirAll(tmpDir, 0o755); err != nil {
		return Result{}, fmt.Errorf("mkdir tmp: %w", err)
	}

	// Enumerate candidate rec.mp4 files within the lookback window.
	// Return map[camera] -> []mp4 path, sorted newest first.
	perCamera, err := enumerateRecentRecordings(cfg.RecordingsRoot, cfg.LookbackHours)
	if err != nil {
		return Result{}, err
	}
	if len(perCamera) == 0 {
		return Result{}, fmt.Errorf(
			"no recordings found under %s in the last %dh",
			cfg.RecordingsRoot, cfg.LookbackHours)
	}

	// Divide the window into TargetCount buckets. Each bucket gets
	// one frame from whichever camera's turn it is in the round-robin.
	bucketSec := float64(cfg.LookbackHours*3600) / float64(cfg.TargetCount)
	cams := make([]string, 0, len(perCamera))
	for id := range perCamera {
		cams = append(cams, id)
	}
	sort.Strings(cams)

	result := Result{}
	rng := rand.New(rand.NewSource(time.Now().UnixNano()))

	for i := 0; i < cfg.TargetCount; i++ {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		cam := cams[i%len(cams)]
		files := perCamera[cam]
		if len(files) == 0 {
			result.Skipped++
			continue
		}
		// Bucket midpoint (seconds before now). For bucket i, that's
		// `(i + 0.5) * bucketSec` — older buckets get the older i's.
		// Add small jitter so buckets from the same camera aren't all
		// keyframe-aligned to the same GOP offset.
		midSec := (float64(i) + 0.5 + rng.Float64()*0.4 - 0.2) * bucketSec
		cutoff := time.Now().Add(-time.Duration(midSec * float64(time.Second)))

		mp4, offset := pickRecordingForCutoff(files, cutoff)
		if mp4 == "" {
			result.Skipped++
			continue
		}
		dst := filepath.Join(tmpDir, fmt.Sprintf("%s_%03d.jpg", cam, i))
		if err := grabKeyframe(ctx, mp4, offset, dst); err != nil {
			result.Skipped++
			continue
		}
		result.Written++
		if cfg.Progress != nil && result.Written%25 == 0 {
			cfg.Progress(result.Written)
		}
	}

	if result.Written < 10 {
		return result, fmt.Errorf("only %d frames produced (need ≥10)", result.Written)
	}

	// Atomic swap: remove old calib_images, rename tmp → calib_images.
	if err := os.RemoveAll(dstDir); err != nil && !errors.Is(err, os.ErrNotExist) {
		return result, fmt.Errorf("remove dst: %w", err)
	}
	if err := os.Rename(tmpDir, dstDir); err != nil {
		return result, fmt.Errorf("rename tmp → dst: %w", err)
	}

	result.Took = time.Since(start)
	if cfg.Progress != nil {
		cfg.Progress(result.Written)
	}
	return result, nil
}

// recordingEntry is one rec.mp4 we might sample from.
type recordingEntry struct {
	Path   string
	Camera string
	// StartedAt is when the pipeline opened this mp4 — derived from
	// the YYYY/MM/DD/HH directory path, truncated to the hour.
	StartedAt time.Time
}

// enumerateRecentRecordings walks the hour-bucketed tree and returns
// a per-camera slice of recordings within the last `hours` hours,
// newest first. Cheap — only stat directories, not mp4 contents.
func enumerateRecentRecordings(root string, hours int) (map[string][]recordingEntry, error) {
	cutoff := time.Now().Add(-time.Duration(hours) * time.Hour)
	out := make(map[string][]recordingEntry)
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			// Keep going past permission / missing-dir hiccups.
			return nil
		}
		if d.IsDir() || filepath.Base(path) != "rec.mp4" {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return nil
		}
		// Expect YYYY/MM/DD/HH/<camera>/rec.mp4 → 5 parts before the
		// filename.
		parts := strings.Split(rel, string(filepath.Separator))
		if len(parts) != 6 {
			return nil
		}
		t, perr := time.Parse("2006-01-02 15",
			fmt.Sprintf("%s-%s-%s %s", parts[0], parts[1], parts[2], parts[3]))
		if perr != nil {
			return nil
		}
		if t.Before(cutoff) {
			return nil
		}
		cam := parts[4]
		out[cam] = append(out[cam], recordingEntry{
			Path: path, Camera: cam, StartedAt: t,
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	for cam := range out {
		sort.Slice(out[cam], func(i, j int) bool {
			return out[cam][i].StartedAt.After(out[cam][j].StartedAt)
		})
	}
	return out, nil
}

// pickRecordingForCutoff finds the recording that started at or before
// the cutoff and returns the path + the seconds offset to seek into.
// Files are ordered newest first; we scan for the first one whose
// start is ≤ cutoff.
func pickRecordingForCutoff(files []recordingEntry, cutoff time.Time) (string, float64) {
	for _, f := range files {
		if !f.StartedAt.After(cutoff) {
			offset := cutoff.Sub(f.StartedAt).Seconds()
			// Clamp to the hour length. If no file covers the target
			// (e.g. sparse recordings), return empty to skip.
			if offset < 0 || offset > 3600 {
				continue
			}
			return f.Path, offset
		}
	}
	return "", 0
}

// grabKeyframe seeks to the given offset inside the mp4 and writes
// a single JPEG. -skip_frame nokey biases toward keyframes which
// don't need full B-frame context to decode — fast and clean.
// Returns nil only if ffmpeg exits 0 AND the output JPEG is non-
// empty on disk. ffmpeg sometimes exits 0 without writing (e.g.
// seek past the end of a truncated file); we treat those as a
// skip so the caller's "written" tally matches reality.
func grabKeyframe(ctx context.Context, mp4 string, offsetSec float64, dst string) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffmpeg",
		"-v", "error",
		"-skip_frame", "nokey",
		"-ss", fmt.Sprintf("%.2f", offsetSec),
		"-i", mp4,
		"-frames:v", "1",
		"-q:v", "3",
		"-y",
		dst,
	)
	if err := cmd.Run(); err != nil {
		_ = os.Remove(dst)
		return err
	}
	st, err := os.Stat(dst)
	if err != nil || st.Size() < 1024 {
		_ = os.Remove(dst)
		return fmt.Errorf("ffmpeg produced no / tiny output (%s)", dst)
	}
	return nil
}

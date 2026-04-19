// Package sidecar writes a per-segment JSONL file with detection events
// alongside each rec.mp4 on the recordings volume. The sidecar travels
// with the video: when storage-manager purges a segment, it also
// removes the sidecar, so detection pins never outlive the clip they
// describe and Postgres stays small regardless of camera retention.
//
// The writer runs inside event-processor on a dedicated goroutine. The
// NATS consumer `Enqueue`s events non-blockingly; file I/O happens on
// the writer goroutine so detection consumption never stalls on disk.
package sidecar

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Detection mirrors the subset of rules.Detection we serialise.
// Duplicated here to avoid a circular import between sidecar and rules.
type Detection struct {
	ID         string            `json:"id"`
	CameraID   string            `json:"camera_id"`
	TS         time.Time         `json:"ts"`
	ClassName  string            `json:"class_name"`
	Kind       string            `json:"kind,omitempty"`
	Confidence float32           `json:"confidence"`
	BBox       any               `json:"bbox"`
	TrackID    string            `json:"track_id,omitempty"`
	Attributes map[string]string `json:"attributes,omitempty"`
}

type Config struct {
	Root       string // /var/lib/fnvr/recordings
	BufferSize int    // default 4096
}

type Writer struct {
	cfg  Config
	pool *pgxpool.Pool
	ch   chan Detection

	// openFiles is keyed by segment path (= the .mp4's dirname + /rec.jsonl).
	openFiles map[string]*openFile

	// segmentCache: most-recent segment row per camera_id. Reused
	// across detections until the cached segment's end time is
	// crossed, then refreshed.
	segmentCache map[string]segmentRow

	// pending: events that arrived before their segment was indexed
	// by storage-manager. Flushed on the next tick or dropped after
	// maxPendingAge.
	pending []pendingEvent

	droppedEnqueue atomic.Int64 // non-blocking queue full
	droppedNoSeg   atomic.Int64 // pending expired, no segment ever landed
}

type openFile struct {
	f        *os.File
	lastUsed time.Time
}

type segmentRow struct {
	path      string
	startedAt time.Time
	endedAt   time.Time // zero if still open; treated as startedAt + 1h
}

type pendingEvent struct {
	d    Detection
	seen time.Time // when enqueued; used for TTL
}

const (
	maxPendingAge = 60 * time.Second
	idleFileClose = 5 * time.Minute
)

func New(cfg Config, pool *pgxpool.Pool) *Writer {
	if cfg.BufferSize <= 0 {
		cfg.BufferSize = 4096
	}
	return &Writer{
		cfg:          cfg,
		pool:         pool,
		ch:           make(chan Detection, cfg.BufferSize),
		openFiles:    map[string]*openFile{},
		segmentCache: map[string]segmentRow{},
	}
}

// Enqueue is non-blocking. If the buffer is full, the event is dropped
// and counted; never blocks the caller.
func (w *Writer) Enqueue(d Detection) {
	select {
	case w.ch <- d:
	default:
		w.droppedEnqueue.Add(1)
	}
}

// Run consumes from the channel until ctx is cancelled. Runs file I/O,
// the segment cache, and the pending-event flush loop all on this single
// goroutine so there's no cross-goroutine locking.
func (w *Writer) Run(ctx context.Context) error {
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()

	reportTick := time.NewTicker(10 * time.Second)
	defer reportTick.Stop()

	for {
		select {
		case <-ctx.Done():
			w.closeAll()
			return nil
		case d := <-w.ch:
			w.handle(ctx, d)
		case <-tick.C:
			w.flushPending(ctx)
			w.sweepIdleFiles()
		case <-reportTick.C:
			w.reportDrops()
		}
	}
}

func (w *Writer) Close() error {
	w.closeAll()
	return nil
}

func (w *Writer) reportDrops() {
	enq := w.droppedEnqueue.Swap(0)
	noseg := w.droppedNoSeg.Swap(0)
	if enq > 0 || noseg > 0 {
		slog.Warn("sidecar drops",
			"enqueue_full", enq,
			"no_segment_after_ttl", noseg)
	}
}

// handle routes a detection to the correct segment's .jsonl. If the
// segment isn't indexed yet, queue to pending and try again on the
// next tick.
func (w *Writer) handle(ctx context.Context, d Detection) {
	seg, ok := w.resolveSegment(ctx, d.CameraID, d.TS)
	if !ok {
		w.pending = append(w.pending, pendingEvent{d: d, seen: time.Now()})
		return
	}
	w.appendLine(seg.path, d)
}

// flushPending retries pending events whose segment may now exist in
// the DB. Expired events are dropped.
func (w *Writer) flushPending(ctx context.Context) {
	if len(w.pending) == 0 {
		return
	}
	now := time.Now()
	remaining := w.pending[:0]
	for _, p := range w.pending {
		if now.Sub(p.seen) > maxPendingAge {
			w.droppedNoSeg.Add(1)
			continue
		}
		seg, ok := w.resolveSegment(ctx, p.d.CameraID, p.d.TS)
		if !ok {
			remaining = append(remaining, p)
			continue
		}
		w.appendLine(seg.path, p.d)
	}
	w.pending = remaining
}

// resolveSegment returns the segment covering the timestamp, using
// a per-camera cache to avoid DB lookups on every detection. Cache is
// invalidated when the timestamp falls outside the cached window.
func (w *Writer) resolveSegment(ctx context.Context, cameraID string, ts time.Time) (segmentRow, bool) {
	if cached, ok := w.segmentCache[cameraID]; ok {
		end := cached.endedAt
		if end.IsZero() {
			end = cached.startedAt.Add(1 * time.Hour)
		}
		if !ts.Before(cached.startedAt) && ts.Before(end) {
			return cached, true
		}
	}
	// DB lookup.
	var path string
	var startedAt time.Time
	var endedAt *time.Time
	var durationMs *int
	err := w.pool.QueryRow(ctx, `
		SELECT path, started_at, ended_at, duration_ms
		FROM segments
		WHERE camera_id = $1
		  AND started_at <= $2
		ORDER BY started_at DESC
		LIMIT 1`, cameraID, ts).Scan(&path, &startedAt, &endedAt, &durationMs)
	if errors.Is(err, pgx.ErrNoRows) {
		return segmentRow{}, false
	}
	if err != nil {
		slog.Warn("sidecar: segment lookup", "err", err, "camera", cameraID)
		return segmentRow{}, false
	}
	// Confirm ts falls within the segment's window.
	var effectiveEnd time.Time
	if endedAt != nil {
		effectiveEnd = *endedAt
	} else if durationMs != nil && *durationMs > 0 {
		effectiveEnd = startedAt.Add(time.Duration(*durationMs) * time.Millisecond)
	} else {
		// Open segment — treat as "extends to now + margin".
		effectiveEnd = startedAt.Add(1 * time.Hour)
	}
	if ts.After(effectiveEnd) {
		return segmentRow{}, false
	}
	seg := segmentRow{path: path, startedAt: startedAt, endedAt: effectiveEnd}
	w.segmentCache[cameraID] = seg
	return seg, true
}

// appendLine writes a single JSONL line to the sidecar file for the
// given segment path. Opens the file lazily (O_APPEND so writes are
// atomic for sub-PIPE_BUF lines) and tracks it in openFiles for idle
// cleanup.
func (w *Writer) appendLine(segmentMP4Path string, d Detection) {
	sidecar := SiblingJsonl(segmentMP4Path)
	of, err := w.openFor(sidecar)
	if err != nil {
		slog.Warn("sidecar: open", "path", sidecar, "err", err)
		return
	}
	// Serialise to a single line + newline. Detection bbox is already
	// normalised 0..1 per the pipeline publish.
	line, err := json.Marshal(d)
	if err != nil {
		return
	}
	buf := append(line, '\n')
	if _, err := of.f.Write(buf); err != nil {
		slog.Warn("sidecar: write", "path", sidecar, "err", err)
		// Force-close so a transient error doesn't leave a broken fd.
		_ = of.f.Close()
		delete(w.openFiles, sidecar)
		return
	}
	of.lastUsed = time.Now()
}

func (w *Writer) openFor(path string) (*openFile, error) {
	if of, ok := w.openFiles[path]; ok {
		return of, nil
	}
	// Make sure the directory exists (it should, because the segment
	// is by definition indexed).
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("mkdir: %w", err)
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}
	of := &openFile{f: f, lastUsed: time.Now()}
	w.openFiles[path] = of
	return of, nil
}

func (w *Writer) sweepIdleFiles() {
	cutoff := time.Now().Add(-idleFileClose)
	for path, of := range w.openFiles {
		if of.lastUsed.Before(cutoff) {
			_ = of.f.Close()
			delete(w.openFiles, path)
		}
	}
}

func (w *Writer) closeAll() {
	for path, of := range w.openFiles {
		_ = of.f.Close()
		delete(w.openFiles, path)
	}
}

// SiblingJsonl derives the sidecar path from an mp4 path:
// rec.mp4 → rec.jsonl, seg-00001.mp4 → seg-00001.jsonl, etc.
func SiblingJsonl(mp4Path string) string {
	if !strings.HasSuffix(mp4Path, ".mp4") {
		return mp4Path + ".jsonl"
	}
	return strings.TrimSuffix(mp4Path, ".mp4") + ".jsonl"
}

// bufioScanLines exports a scanner configured for our line lengths.
// Useful for readers (api-server) that vendor this package.
func NewScanner(f *os.File) *bufio.Scanner {
	s := bufio.NewScanner(f)
	s.Buffer(make([]byte, 64*1024), 256*1024)
	s.Split(bufio.ScanLines)
	// Ignore fs.ErrClosed at end-of-read.
	_ = fs.ErrClosed
	return s
}

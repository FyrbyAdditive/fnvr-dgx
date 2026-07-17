package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/jpeg"
	"io"
	"log/slog"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/fnvr/fnvr/apps/api-server/internal/detections"
)

// faceBox is the JSON shape of the normalised bbox stored in the
// detections table. Separate type (not inline) so both the search
// response and the thumbnail crop can share it.
type faceBox struct {
	X float32 `json:"x"`
	Y float32 `json:"y"`
	W float32 `json:"w"`
	H float32 `json:"h"`
}

// recentFaceResponse is the wire shape for the Faces UI: bbox + a
// thumbnail URL + the embedding inline so the client can POST it
// into /persons/{id}/embeddings after labelling.
//
// Members + MemberVectors are populated when the /faces/recent
// call used `collapse=true`. They carry the other detections in
// the same near-duplicate cluster, so the UI can enrol the whole
// cluster with one click and dismiss them all together.
type recentFaceResponse struct {
	DetectionID   int64       `json:"detection_id"`
	EventID       string      `json:"event_id"`
	CameraID      string      `json:"camera_id"`
	TS            time.Time   `json:"ts"`
	Confidence    float32     `json:"confidence"`
	BBox          faceBox     `json:"bbox"`
	Person        string      `json:"person,omitempty"`
	Similarity    float32     `json:"similarity,omitempty"`
	Vector        []float32   `json:"vector,omitempty"`
	Thumbnail     string      `json:"thumbnail_url"`
	Members       []int64     `json:"members,omitempty"`
	MemberVectors [][]float32 `json:"member_vectors,omitempty"`
	Count         int         `json:"count,omitempty"`
}

// handleRecentFaces returns the last N face detections, oldest
// filtered to the requested window. Defaults: last 24h, 50 rows.
//   - unmatched=true drops rows resolved to an enrolled person.
//   - collapse=true greedily clusters rows with cosine ≥ 0.9 into a
//     single representative, so a single face captured across 30
//     frames shows up once.
//
// Dismissed detections are always filtered out.
func (s *Server) handleRecentFaces(w http.ResponseWriter, r *http.Request) {
	hours, _ := strconv.Atoi(r.URL.Query().Get("hours"))
	if hours <= 0 || hours > 24*7 {
		hours = 24
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	onlyUnmatched := r.URL.Query().Get("unmatched") == "true"
	collapse := r.URL.Query().Get("collapse") == "true"
	camera := r.URL.Query().Get("camera")

	to := time.Now()
	from := to.Add(-time.Duration(hours) * time.Hour)

	// Over-fetch more when collapsing — clusters of size N reduce N
	// rows to 1 tile, and we want enough raw input to still hit limit.
	fetchMult := 3
	if collapse {
		fetchMult = 10
	}
	rows, err := s.detections.List(r.Context(), detections.ListArgs{
		CameraID: camera,
		From:     from,
		To:       to,
		Kind:     "face",
		Limit:    limit * fetchMult,
	})
	if err != nil {
		slog.Error("recent faces", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	dismissed, err := s.persons.ListDismissedIDs(r.Context())
	if err != nil {
		slog.Warn("face dismissals load", "err", err)
		dismissed = map[string]struct{}{}
	}

	// First pass: shape into intermediate records, skipping dismissed.
	type rec struct {
		resp recentFaceResponse
		vec  []float32
	}
	recs := make([]rec, 0, len(rows))
	for _, d := range rows {
		if _, skip := dismissed[strconv.FormatInt(d.ID, 10)]; skip {
			continue
		}
		attrs := map[string]string{}
		if len(d.Attributes) > 0 {
			_ = json.Unmarshal(d.Attributes, &attrs)
		}
		person := attrs["person"]
		if onlyUnmatched && person != "" {
			continue
		}
		var sim float32
		if sv := attrs["similarity"]; sv != "" {
			if f, err := strconv.ParseFloat(sv, 32); err == nil {
				sim = float32(f)
			}
		}
		var vec []float32
		if raw := attrs["embedding"]; raw != "" {
			if b, err := base64.StdEncoding.DecodeString(raw); err == nil && len(b) == 512*4 {
				vec = decodeFloat32Slice(b)
			}
		}
		var bb faceBox
		if len(d.BBox) > 0 {
			_ = json.Unmarshal(d.BBox, &bb)
		}
		thumbURL := ""
		if d.ID > 0 {
			thumbURL = "/api/v1/faces/thumbnail/" + strconv.FormatInt(d.ID, 10) + ".jpg"
		}
		recs = append(recs, rec{
			resp: recentFaceResponse{
				DetectionID: d.ID,
				EventID:     d.EventID,
				CameraID:    d.CameraID,
				TS:          d.TS,
				Confidence:  d.Confidence,
				BBox:        bb,
				Person:      person,
				Similarity:  sim,
				Vector:      vec,
				Thumbnail:   thumbURL,
				Count:       1,
			},
			vec: vec,
		})
	}

	// Second pass: either flat list, or greedy single-link cluster at
	// cosine ≥ 0.9. Greedy O(N·K) where K is #clusters — plenty for
	// the ~500 row cap we allow on this endpoint.
	out := make([]recentFaceResponse, 0, limit)
	if !collapse {
		for _, r := range recs {
			if len(out) >= limit {
				break
			}
			out = append(out, r.resp)
		}
	} else {
		const collapseThresh = 0.9
		type cluster struct {
			rep    *recentFaceResponse
			repVec []float32
			norm   float32
		}
		clusters := make([]cluster, 0, 16)
		// Pre-norm reps so each comparison is cheap. Embeddings are
		// already L2-normalised by ArcFace but the text round-trip
		// can introduce tiny drift; renormalise for safety.
		normalise := func(v []float32) (float32, []float32) {
			if len(v) == 0 {
				return 0, v
			}
			var s float64
			for _, x := range v {
				s += float64(x) * float64(x)
			}
			n := float32(1)
			if s > 0 {
				n = float32(1.0 / (math.Sqrt(s)))
			}
			out := make([]float32, len(v))
			for i, x := range v {
				out[i] = x * n
			}
			return n, out
		}
		cosine := func(a, b []float32) float32 {
			if len(a) != len(b) || len(a) == 0 {
				return 0
			}
			var s float32
			for i := range a {
				s += a[i] * b[i]
			}
			return s
		}
		for _, r := range recs {
			if len(r.vec) == 0 {
				// No embedding — can't cluster; emit on its own.
				out = append(out, r.resp)
				continue
			}
			_, rn := normalise(r.vec)
			best := -1
			bestSim := float32(0)
			for i := range clusters {
				sim := cosine(rn, clusters[i].repVec)
				if sim > bestSim {
					bestSim = sim
					best = i
				}
			}
			if best >= 0 && bestSim >= collapseThresh {
				c := &clusters[best]
				c.rep.Members = append(c.rep.Members, r.resp.DetectionID)
				c.rep.MemberVectors = append(c.rep.MemberVectors, r.vec)
				c.rep.Count++
				continue
			}
			if len(clusters)+len(out) >= limit {
				continue
			}
			rr := r.resp
			clusters = append(clusters, cluster{rep: &rr, repVec: rn})
		}
		for i := range clusters {
			out = append(out, *clusters[i].rep)
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// handleDismissFaces hides one or more face detections from the
// /faces grid. Reason drives whether the matcher learns from it:
//   not_a_face / duplicate — stored as a negative; similar future
//     detections get a penalty at scoring time.
//   deleted / enrolled     — UI-only hide; no scoring impact.
// Admin-only.
func (s *Server) handleDismissFaces(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Items []struct {
			DetectionID int64     `json:"detection_id"`
			Vector      []float32 `json:"vector"`
			Reason      string    `json:"reason"`
		} `json:"items"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if len(body.Items) == 0 {
		http.Error(w, "empty items", http.StatusBadRequest)
		return
	}
	n := 0
	for _, it := range body.Items {
		if it.DetectionID <= 0 || len(it.Vector) != 512 {
			continue
		}
		reason := it.Reason
		if reason == "" {
			reason = "not_a_face"
		}
		if err := s.persons.Dismiss(r.Context(), strconv.FormatInt(it.DetectionID, 10),
			it.Vector, reason); err != nil {
			slog.Warn("face dismiss", "err", err, "detection_id", it.DetectionID)
			continue
		}
		n++
	}
	writeJSON(w, http.StatusOK, map[string]int{"dismissed": n})
}

// handlePersonMatches returns recent face detections that matched
// this person — used by the "click a name, see their face log" UI
// path. Same response shape as /faces/recent so the client can
// render with the existing FaceTile component. Dismissed detections
// are filtered out.
func (s *Server) handlePersonMatches(w http.ResponseWriter, r *http.Request) {
	personID := r.PathValue("id")
	hours, _ := strconv.Atoi(r.URL.Query().Get("hours"))
	if hours <= 0 || hours > 24*30 {
		hours = 24
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 500 {
		limit = 100
	}

	// Direct SQL: detections.List doesn't take an attributes JSONB
	// filter and adding one would ripple through the Timeline path.
	// Query is read-only, no hot-path concern. person_id lives in the
	// attributes JSONB as a string UUID.
	rows, err := s.pool.Query(r.Context(), `
		SELECT id, COALESCE(event_id,''), camera_id, ts, confidence,
		       bbox::text, attributes::text
		FROM detections
		WHERE kind = 'face'
		  AND attributes->>'person_id' = $1
		  AND ts > NOW() - ($2 || ' hours')::interval
		ORDER BY ts DESC
		LIMIT $3`, personID, strconv.Itoa(hours), limit)
	if err != nil {
		slog.Error("person matches", "err", err, "person_id", personID)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	dismissed, err := s.persons.ListDismissedIDs(r.Context())
	if err != nil {
		slog.Warn("face dismissals load", "err", err)
		dismissed = map[string]struct{}{}
	}

	out := make([]recentFaceResponse, 0, limit)
	for rows.Next() {
		var id int64
		var eventID, cameraID, bboxStr, attrStr string
		var ts time.Time
		var conf float32
		if err := rows.Scan(&id, &eventID, &cameraID, &ts, &conf, &bboxStr, &attrStr); err != nil {
			continue
		}
		if _, skip := dismissed[strconv.FormatInt(id, 10)]; skip {
			continue
		}
		var bb faceBox
		_ = json.Unmarshal([]byte(bboxStr), &bb)
		attrs := map[string]string{}
		_ = json.Unmarshal([]byte(attrStr), &attrs)
		var sim float32
		if sv := attrs["similarity"]; sv != "" {
			if f, err := strconv.ParseFloat(sv, 32); err == nil {
				sim = float32(f)
			}
		}
		var vec []float32
		if raw := attrs["embedding"]; raw != "" {
			if b, err := base64.StdEncoding.DecodeString(raw); err == nil && len(b) == 512*4 {
				vec = decodeFloat32Slice(b)
			}
		}
		thumbURL := "/api/v1/faces/thumbnail/" + strconv.FormatInt(id, 10) + ".jpg"
		out = append(out, recentFaceResponse{
			DetectionID: id,
			EventID:     eventID,
			CameraID:    cameraID,
			TS:          ts,
			Confidence:  conf,
			BBox:        bb,
			Person:      attrs["person"],
			Similarity:  sim,
			Vector:      vec,
			Thumbnail:   thumbURL,
			Count:       1,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// handleAddPersonEmbeddingsBulk enrols multiple embeddings against a
// single person in one transactional call. Used by the "enrol this
// cluster" path — the UI submits the representative vector plus all
// near-duplicate member vectors so the enrolment captures pose
// variation from the first go.
func (s *Server) handleAddPersonEmbeddingsBulk(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var body struct {
		Items []struct {
			Vector      []float32 `json:"vector"`
			Source      string    `json:"source"`
			DetectionID int64     `json:"detection_id"`
		} `json:"items"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	items := make([]struct {
		Vector      []float32
		Source      string
		DetectionID int64
	}, 0, len(body.Items))
	for _, it := range body.Items {
		if len(it.Vector) != 512 {
			continue
		}
		src := it.Source
		if src == "" {
			src = "api-bulk"
		}
		items = append(items, struct {
			Vector      []float32
			Source      string
			DetectionID int64
		}{Vector: it.Vector, Source: src, DetectionID: it.DetectionID})
	}
	n, err := s.persons.AddEmbeddingsBulk(r.Context(), id, items)
	if err != nil {
		slog.Warn("bulk add embeddings", "err", err, "person_id", id)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]int{"added": n})
}

// handleFaceThumbnail returns a JPEG cropped to the face bbox of a
// detection row. On first hit within the ~1 minute live-snapshot
// ring window we crop from the live snapshot and cache the result
// to {DataDir}/thumbs/faces/{id}.jpg so subsequent hits (and later
// dismiss/enrol review by an operator who comes back hours later)
// still resolve without a valid live frame.
func (s *Server) handleFaceThumbnail(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("detection_id")
	// Strip ".jpg" suffix if present.
	if i := len(idStr) - 4; i > 0 && idStr[i:] == ".jpg" {
		idStr = idStr[:i]
	}

	// Uploaded-photo embeddings don't have a detection row; their
	// crop is cached at upload time under "upload-{sha256[:8]}.jpg".
	// Treat any id starting with "upload-" as cache-only — no PG
	// detection lookup, no live-snapshot fallback.
	if strings.HasPrefix(idStr, "upload-") {
		if s.cfg == nil || s.cfg.DataDir == "" {
			http.Error(w, "no data dir", http.StatusNotFound)
			return
		}
		path := filepath.Join(s.cfg.DataDir, "thumbs", "faces", idStr+".jpg")
		fd, err := os.Open(path)
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		defer fd.Close()
		w.Header().Set("Content-Type", "image/jpeg")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		_, _ = io.Copy(w, fd)
		return
	}

	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}

	// Cache hit path: serve the persisted crop directly.
	cachePath := ""
	if s.cfg != nil && s.cfg.DataDir != "" {
		cachePath = filepath.Join(s.cfg.DataDir, "thumbs", "faces", idStr+".jpg")
		if fd, err := os.Open(cachePath); err == nil {
			defer fd.Close()
			w.Header().Set("Content-Type", "image/jpeg")
			w.Header().Set("Cache-Control", "public, max-age=86400")
			_, _ = io.Copy(w, fd)
			return
		}
	}

	// Cache miss: look up the detection row to get camera_id + bbox.
	// No recency filter — if there's a live snapshot we may still be
	// able to crop; if not, 404 and the UI tile will show "no preview".
	var cameraID string
	var bboxRaw []byte
	err = s.pool.QueryRow(r.Context(), `
		SELECT camera_id, bbox
		FROM detections
		WHERE id = $1 AND kind = 'face'`, id).Scan(&cameraID, &bboxRaw)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	var bb faceBox
	_ = json.Unmarshal(bboxRaw, &bb)

	// Fetch the current live snapshot for that camera (cached ~1s
	// by the snapshot service — same path Live tiles use).
	jpg, err := s.snaps.Snapshot(r.Context(), cameraID)
	if err != nil {
		http.Error(w, "snapshot unavailable", http.StatusServiceUnavailable)
		return
	}
	cropped, err := cropBBoxJPEG(jpg, bb, 1.4)
	if err != nil {
		slog.Warn("face thumbnail crop", "err", err, "detection_id", id)
		// Fall back to the full frame so the user still sees
		// *something* while debugging. Don't cache the fallback —
		// a retry once nvinfer produces a proper bbox is preferable.
		w.Header().Set("Content-Type", "image/jpeg")
		w.Header().Set("Cache-Control", "public, max-age=60")
		_, _ = w.Write(jpg)
		return
	}
	// Persist the crop so later review works after the live snapshot
	// has rolled past this face. Ignore write errors (serve from
	// memory anyway) — best-effort cache, not a correctness tier.
	if cachePath != "" {
		if err := os.MkdirAll(filepath.Dir(cachePath), 0o755); err == nil {
			_ = os.WriteFile(cachePath, cropped, 0o644)
		}
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write(cropped)
}

// cropBBoxJPEG decodes a JPEG, crops to the normalised bbox expanded
// by `pad` (1.0 = exact, 1.4 = +20% margin on each side), and
// re-encodes as JPEG. Uses stdlib image/jpeg — no extra deps.
func cropBBoxJPEG(jpgBytes []byte, bb faceBox, pad float32) ([]byte, error) {
	img, err := jpeg.Decode(bytes.NewReader(jpgBytes))
	if err != nil {
		return nil, err
	}
	b := img.Bounds()
	W, H := float32(b.Dx()), float32(b.Dy())

	// Expand bbox by pad factor around its centre.
	cx := bb.X + bb.W/2
	cy := bb.Y + bb.H/2
	w := bb.W * pad
	h := bb.H * pad
	x0 := cx - w/2
	y0 := cy - h/2
	x1 := cx + w/2
	y1 := cy + h/2
	if x0 < 0 {
		x0 = 0
	}
	if y0 < 0 {
		y0 = 0
	}
	if x1 > 1 {
		x1 = 1
	}
	if y1 > 1 {
		y1 = 1
	}

	rect := image.Rect(
		int(x0*W), int(y0*H),
		int(x1*W), int(y1*H),
	)
	if !rect.In(b) {
		rect = rect.Intersect(b)
	}
	if rect.Dx() <= 0 || rect.Dy() <= 0 {
		return nil, errors.New("empty crop")
	}
	type subImager interface {
		SubImage(r image.Rectangle) image.Image
	}
	si, ok := img.(subImager)
	if !ok {
		return nil, errors.New("subimage unsupported")
	}
	cropped := si.SubImage(rect)
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, cropped, &jpeg.Options{Quality: 80}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// decodeFloat32Slice turns a byte slice (len=2048) into 512 float32s
// assuming little-endian IEEE754 — the pipeline's memcpy order.
func decodeFloat32Slice(b []byte) []float32 {
	if len(b)%4 != 0 {
		return nil
	}
	out := make([]float32, len(b)/4)
	for i := range out {
		u := uint32(b[i*4]) | uint32(b[i*4+1])<<8 | uint32(b[i*4+2])<<16 | uint32(b[i*4+3])<<24
		out[i] = math.Float32frombits(u)
	}
	return out
}
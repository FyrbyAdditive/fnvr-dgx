// Package mlworker is a thin HTTP client for the CPU-only Python
// sidecar at http://ml-worker:8090. api-server proxies photo-upload
// enrolment and on-demand clustering requests to it; the sidecar
// owns onnxruntime + HDBSCAN so api-server stays Go-only.
package mlworker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"time"
)

// Client is safe for concurrent use.
type Client struct {
	baseURL string
	http    *http.Client
}

// Face is one returned-from-/detect-and-embed row. Bbox is
// normalised to the source image.
type Face struct {
	BBox struct {
		X, Y, W, H float32
	} `json:"bbox"`
	Score     float32   `json:"score"`
	Embedding []float32 `json:"embedding"`
}

// DetectResponse mirrors the FastAPI endpoint's shape.
type DetectResponse struct {
	Faces []Face `json:"faces"`
}

// BatchClusterReport is what /batch-cluster returns.
type BatchClusterReport map[string]any

// internalAuthRT stamps the shared-secret header on every ml-worker
// request so the sidecar's internal endpoints can reject callers
// without it. No-op when the secret is unset (dev).
type internalAuthRT struct {
	secret string
	base   http.RoundTripper
}

func (t internalAuthRT) RoundTrip(r *http.Request) (*http.Response, error) {
	if t.secret == "" {
		return t.base.RoundTrip(r)
	}
	r2 := r.Clone(r.Context())
	r2.Header.Set("X-FNVR-Internal", t.secret)
	return t.base.RoundTrip(r2)
}

// NewClient resolves the base URL from FNVR_ML_WORKER_URL, falling
// back to the docker-internal DNS name.
func NewClient() *Client {
	base := os.Getenv("FNVR_ML_WORKER_URL")
	if base == "" {
		base = "http://ml-worker:8090"
	}
	return &Client{
		baseURL: base,
		// 60s timeout: /detect-and-embed runs onnxruntime on CPU
		// which can be slow on first-request cold start (model
		// load). /batch-cluster over ≤50k embeddings also fits.
		http: &http.Client{
			Timeout: 60 * time.Second,
			Transport: internalAuthRT{
				secret: os.Getenv("FNVR_ML_SHARED_SECRET"),
				base:   http.DefaultTransport,
			},
		},
	}
}

// Healthz lets the caller surface ml-worker availability in
// /healthz responses without a hard crash if the sidecar is down.
func (c *Client) Healthz(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, "GET", c.baseURL+"/healthz", nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("ml-worker /healthz: %s", resp.Status)
	}
	return nil
}

// DetectAndEmbed uploads a single JPEG/PNG and returns all faces
// the detector found, with per-face L2-normalised 512-d embeddings.
// Sorted by confidence descending by the worker.
func (c *Client) DetectAndEmbed(ctx context.Context, filename string, jpg []byte) ([]Face, error) {
	if len(jpg) == 0 {
		return nil, errors.New("empty image")
	}
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	// Use a minimal MIME part so we don't depend on the client's
	// original Content-Type header to be correct.
	hdr := textproto.MIMEHeader{}
	hdr.Set("Content-Disposition",
		fmt.Sprintf(`form-data; name="file"; filename="%s"`, filename))
	hdr.Set("Content-Type", sniffContentType(jpg))
	part, err := mw.CreatePart(hdr)
	if err != nil {
		return nil, err
	}
	if _, err := part.Write(jpg); err != nil {
		return nil, err
	}
	if err := mw.Close(); err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(
		ctx, "POST", c.baseURL+"/detect-and-embed", &buf,
	)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return nil, fmt.Errorf(
			"ml-worker /detect-and-embed: %s (%s)", resp.Status, string(body),
		)
	}
	var dr DetectResponse
	if err := json.NewDecoder(resp.Body).Decode(&dr); err != nil {
		return nil, err
	}
	return dr.Faces, nil
}

// Cluster runs HDBSCAN on a list of embeddings. Labels are aligned
// to the input order; -1 indicates noise.
func (c *Client) Cluster(ctx context.Context, embeddings [][]float32, minCluster int) ([]int, error) {
	payload := map[string]any{
		"embeddings":       embeddings,
		"min_cluster_size": minCluster,
	}
	buf, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(
		ctx, "POST", c.baseURL+"/cluster", bytes.NewReader(buf),
	)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return nil, fmt.Errorf(
			"ml-worker /cluster: %s (%s)", resp.Status, string(body),
		)
	}
	var r struct {
		Labels []int `json:"labels"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return nil, err
	}
	return r.Labels, nil
}

// BatchCluster triggers the ml-worker's unmatched-faces batch job.
// Idempotent: the worker handles preserving cluster IDs across
// runs. api-server calls this from its "run now" handler.
func (c *Client) BatchCluster(ctx context.Context) (BatchClusterReport, error) {
	req, err := http.NewRequestWithContext(
		ctx, "POST", c.baseURL+"/batch-cluster", nil,
	)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf(
			"ml-worker /batch-cluster: %s (%s)", resp.Status, string(body),
		)
	}
	var r BatchClusterReport
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return nil, err
	}
	return r, nil
}

// DriftCheck triggers the weekly self-match comparison and alert.
// Usually the cron path runs this; exposed here for manual trigger.
func (c *Client) DriftCheck(ctx context.Context) (map[string]any, error) {
	req, err := http.NewRequestWithContext(
		ctx, "POST", c.baseURL+"/drift-check", nil,
	)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return nil, fmt.Errorf(
			"ml-worker /drift-check: %s (%s)", resp.Status, string(body),
		)
	}
	var r map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return nil, err
	}
	return r, nil
}

// sniffContentType returns a best-effort MIME type for uploaded
// bytes; falls back to image/jpeg which every modern decoder
// accepts via content sniffing anyway.
func sniffContentType(b []byte) string {
	if len(b) >= 8 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47 {
		return "image/png"
	}
	return "image/jpeg"
}

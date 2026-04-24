// Package mtxproxy is a tiny client for MediaMTX's runtime config HTTP
// API. We use it to add/remove re-muxer paths on the fly so broken-
// source cameras can route through MediaMTX without restarting the
// container. api-server owns the camera → path mapping; MediaMTX API
// paths don't persist across MediaMTX restarts so the reconciler re-
// primes on api-server boot and after MediaMTX recovers.
package mtxproxy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type Client struct {
	baseURL string
	http    *http.Client
}

// New builds a client pointing at baseURL (e.g. http://mediamtx:9997).
// Short timeout — the API is on the same docker network; anything slow
// is a symptom of a larger problem and we don't want to stall PATCH
// handlers on it.
func New(baseURL string) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		http:    &http.Client{Timeout: 3 * time.Second},
	}
}

// PathConfig is the subset of MediaMTX's path config we care about for
// proxied sources. Many other fields exist (record, authentication,
// publishUser, etc.); we leave them at defaults.
type PathConfig struct {
	Source           string `json:"source"`
	SourceProtocol   string `json:"sourceProtocol,omitempty"`
	SourceOnDemand   bool   `json:"sourceOnDemand"`
}

// Add creates or replaces a path in MediaMTX's live config. Uses
// add (create) then patch (update) fallback so callers don't have to
// track whether the path already exists. Safe to call repeatedly with
// the same args — idempotent.
func (c *Client) Add(ctx context.Context, name string, cfg PathConfig) error {
	// Try create first; if the path exists already, MediaMTX returns
	// 400; fall through to patch.
	body, _ := json.Marshal(cfg)
	addURL := c.baseURL + "/v3/config/paths/add/" + name
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, addURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("mediamtx add: %w", err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode < 300 {
		return nil
	}
	// 400 typically = path already exists. Patch it to converge.
	patchURL := c.baseURL + "/v3/config/paths/patch/" + name
	req2, err := http.NewRequestWithContext(ctx, http.MethodPatch, patchURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req2.Header.Set("Content-Type", "application/json")
	resp2, err := c.http.Do(req2)
	if err != nil {
		return fmt.Errorf("mediamtx patch: %w", err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode >= 300 {
		msg, _ := io.ReadAll(resp2.Body)
		return fmt.Errorf("mediamtx patch %s: %d %s", name, resp2.StatusCode, string(msg))
	}
	return nil
}

// Delete removes a path from MediaMTX's live config. Treating a 4xx on
// delete as success — if the path is already gone the caller's intent
// is satisfied.
func (c *Client) Delete(ctx context.Context, name string) error {
	delURL := c.baseURL + "/v3/config/paths/delete/" + name
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, delURL, nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("mediamtx delete: %w", err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode >= 500 {
		return fmt.Errorf("mediamtx delete %s: %d", name, resp.StatusCode)
	}
	return nil
}

// List returns the current set of configured path names.
func (c *Client) List(ctx context.Context) ([]string, error) {
	url := c.baseURL + "/v3/config/paths/list"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("mediamtx list: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("mediamtx list: %d", resp.StatusCode)
	}
	var body struct {
		Items []struct {
			Name string `json:"name"`
		} `json:"items"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("mediamtx list decode: %w", err)
	}
	out := make([]string, 0, len(body.Items))
	for _, it := range body.Items {
		out = append(out, it.Name)
	}
	return out, nil
}

// Package channels fans incidents out to configured notification channels.
// Subscribes to fnvr.events.incident.> on NATS, reads channel + subscription
// rows from Postgres per incident, and POSTs to webhook / ntfy endpoints.
package channels

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"

	"github.com/fnvr/fnvr/apps/notification-dispatcher/internal/mqtthub"
)

type Config struct {
	DatabaseURL string
	NATSURL     string
}

type Dispatcher struct {
	cfg   Config
	pool  *pgxpool.Pool
	nc    *nats.Conn
	httpc *http.Client
	hub   *mqtthub.Hub // shared MQTT connection pool
}

func New(ctx context.Context, cfg Config) (*Dispatcher, error) {
	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, fmt.Errorf("pg: %w", err)
	}
	nc, err := nats.Connect(cfg.NATSURL,
		nats.Name("fnvr-notification-dispatcher"),
		nats.MaxReconnects(-1),
		nats.ReconnectWait(2*time.Second),
	)
	if err != nil {
		pool.Close()
		return nil, fmt.Errorf("nats: %w", err)
	}
	return &Dispatcher{
		cfg:   cfg,
		pool:  pool,
		nc:    nc,
		httpc: &http.Client{Timeout: 10 * time.Second},
		hub:   mqtthub.New(),
	}, nil
}

// Hub exposes the shared MQTT connection pool so main.go can hand it
// to the HA bridge, which wants to share one TCP session with any
// matching mqtt-kind channels.
func (d *Dispatcher) Hub() *mqtthub.Hub { return d.hub }

// Pool and NATS accessors so main.go can plumb the HA bridge without
// opening parallel connections.
func (d *Dispatcher) Pool() *pgxpool.Pool { return d.pool }
func (d *Dispatcher) NATS() *nats.Conn    { return d.nc }

func (d *Dispatcher) Close() {
	if d.hub != nil {
		d.hub.Close()
	}
	if d.nc != nil {
		_ = d.nc.Drain()
	}
	if d.pool != nil {
		d.pool.Close()
	}
}

// Incident is the payload shape published by event-processor. Kept as a
// loose struct because rules.Fire() may grow fields over time.
type Incident struct {
	ID        string    `json:"id"`
	RuleID    string    `json:"rule_id"`
	CameraID  string    `json:"camera_id"`
	StartedAt time.Time `json:"started_at"`
	Severity  string    `json:"severity"`
	Summary   string    `json:"summary"`
}

func (d *Dispatcher) Run(ctx context.Context) error {
	sub, err := d.nc.Subscribe("fnvr.events.incident.>", func(m *nats.Msg) {
		var inc Incident
		if err := json.Unmarshal(m.Data, &inc); err != nil {
			slog.Warn("dispatcher: bad incident payload", "err", err)
			return
		}
		d.handle(ctx, inc)
	})
	if err != nil {
		return fmt.Errorf("subscribe: %w", err)
	}
	defer sub.Unsubscribe()
	<-ctx.Done()
	return nil
}

// handle resolves subscriptions → channels for this incident and dispatches.
// Dispatch runs inline (per-incident goroutine) — channel volume is low
// enough that a worker pool would be overengineering.
func (d *Dispatcher) handle(ctx context.Context, inc Incident) {
	// Candidate channels: matching subscription rule_id/camera_id filters.
	// Severity gate runs in Go so we don't need a stored function on top
	// of a trivial 3-valued ordering.
	rows, err := d.pool.Query(ctx, `
		SELECT DISTINCT c.id, c.kind, c.config, s.min_severity
		FROM notification_channels c
		JOIN notification_subscriptions s ON s.channel_id = c.id
		WHERE c.enabled = TRUE
		  AND (s.rule_id IS NULL OR s.rule_id::text = $1)
		  AND (s.camera_id IS NULL OR s.camera_id = $2)`,
		inc.RuleID, inc.CameraID)
	if err != nil {
		slog.Error("dispatcher: channel lookup", "err", err, "incident", inc.ID)
		return
	}
	defer rows.Close()

	type target struct {
		id     string
		kind   string
		config json.RawMessage
	}
	seen := map[string]bool{}
	var targets []target
	incRank := severityRank(inc.Severity)
	for rows.Next() {
		var t target
		var minSev string
		if err := rows.Scan(&t.id, &t.kind, &t.config, &minSev); err != nil {
			continue
		}
		if incRank < severityRank(minSev) {
			continue
		}
		if seen[t.id] {
			continue
		}
		seen[t.id] = true
		targets = append(targets, t)
	}
	rows.Close()

	for _, t := range targets {
		go d.deliver(ctx, inc, t.id, t.kind, t.config)
	}
}

func (d *Dispatcher) deliver(ctx context.Context, inc Incident, channelID, kind string, config json.RawMessage) {
	var (
		status int
		delErr error
	)
	switch kind {
	case "webhook":
		status, delErr = d.sendWebhook(ctx, inc, config)
	case "ntfy":
		status, delErr = d.sendNtfy(ctx, inc, config)
	case "mqtt":
		status, delErr = d.sendMQTT(ctx, inc, config)
	default:
		delErr = fmt.Errorf("unknown channel kind %q", kind)
	}

	errText := ""
	if delErr != nil {
		errText = delErr.Error()
	}
	_, logErr := d.pool.Exec(ctx, `
		INSERT INTO notification_deliveries
		  (incident_id, channel_id, succeeded, status_code, error)
		VALUES ($1, $2, $3, $4, NULLIF($5,''))`,
		inc.ID, channelID, delErr == nil, nullIfZero(status), errText)
	if logErr != nil {
		slog.Warn("dispatcher: log write failed", "err", logErr)
	}
	if delErr != nil {
		slog.Warn("dispatcher: delivery failed", "channel", channelID, "kind", kind, "err", delErr)
	} else {
		slog.Info("dispatcher: delivered", "channel", channelID, "kind", kind, "incident", inc.ID)
	}
}

// --- webhook ---

type webhookConfig struct {
	URL     string            `json:"url"`
	Method  string            `json:"method"`  // default POST
	Headers map[string]string `json:"headers"` // optional
}

func (d *Dispatcher) sendWebhook(ctx context.Context, inc Incident, raw json.RawMessage) (int, error) {
	var cfg webhookConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return 0, fmt.Errorf("config: %w", err)
	}
	if cfg.URL == "" {
		return 0, errors.New("webhook url empty")
	}
	method := cfg.Method
	if method == "" {
		method = "POST"
	}
	body, _ := json.Marshal(inc)
	req, err := http.NewRequestWithContext(ctx, method, cfg.URL, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "fnvr-notification-dispatcher/1.0")
	for k, v := range cfg.Headers {
		req.Header.Set(k, v)
	}
	resp, err := d.httpc.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode >= 400 {
		return resp.StatusCode, fmt.Errorf("http %d", resp.StatusCode)
	}
	return resp.StatusCode, nil
}

// --- ntfy ---

type ntfyConfig struct {
	Server string `json:"server"` // e.g. https://ntfy.sh
	Topic  string `json:"topic"`
	Token  string `json:"token"` // optional access token
}

func (d *Dispatcher) sendNtfy(ctx context.Context, inc Incident, raw json.RawMessage) (int, error) {
	var cfg ntfyConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return 0, fmt.Errorf("config: %w", err)
	}
	if cfg.Topic == "" {
		return 0, errors.New("ntfy topic empty")
	}
	server := cfg.Server
	if server == "" {
		server = "https://ntfy.sh"
	}
	url := server + "/" + cfg.Topic
	req, err := http.NewRequestWithContext(ctx, "POST", url,
		bytes.NewReader([]byte(inc.Summary)))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Title", fmt.Sprintf("fnvr — %s", inc.CameraID))
	req.Header.Set("Priority", severityToNtfy(inc.Severity))
	req.Header.Set("Tags", "video_camera")
	if cfg.Token != "" {
		req.Header.Set("Authorization", "Bearer "+cfg.Token)
	}
	resp, err := d.httpc.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode >= 400 {
		return resp.StatusCode, fmt.Errorf("http %d", resp.StatusCode)
	}
	return resp.StatusCode, nil
}

// --- mqtt ---

type mqttConfig struct {
	BrokerURL string `json:"broker_url"`
	Username  string `json:"username"`
	Password  string `json:"password"`
	Topic     string `json:"topic"`
	QOS       int    `json:"qos"`
	Retain    bool   `json:"retain"`
}

// sendMQTT publishes the incident JSON to the configured broker. The
// topic template supports three substitutions: {camera_id},
// {severity}, {rule_id}. Returns the MQTT connect-return-code shape
// (0 success; wrapped errors on failure) so the deliveries log stays
// consistent with the HTTP channels.
func (d *Dispatcher) sendMQTT(ctx context.Context, inc Incident, raw json.RawMessage) (int, error) {
	var cfg mqttConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return 0, fmt.Errorf("config: %w", err)
	}
	if cfg.BrokerURL == "" {
		return 0, errors.New("mqtt broker_url empty")
	}
	if cfg.Topic == "" {
		return 0, errors.New("mqtt topic empty")
	}
	topic := renderMQTTTopic(cfg.Topic, inc)
	body, _ := json.Marshal(inc)
	client, release, err := d.hub.Acquire(cfg.BrokerURL, cfg.Username, cfg.Password)
	if err != nil {
		return 0, err
	}
	defer release()
	qos := byte(cfg.QOS)
	if qos > 2 {
		qos = 1
	}
	token := client.Publish(topic, qos, cfg.Retain, body)
	// Bound the wait so a broker hang doesn't stall the goroutine.
	if !token.WaitTimeout(5 * time.Second) {
		_ = ctx
		return 0, errors.New("mqtt publish timeout")
	}
	if perr := token.Error(); perr != nil {
		return 0, perr
	}
	return 0, nil // 0 = success for the deliveries log
}

// renderMQTTTopic fills in {camera_id}, {severity}, {rule_id} in the
// configured topic template. Missing fields become empty strings —
// the operator can always see the rendered topic in their broker
// logs if something looks off.
func renderMQTTTopic(tpl string, inc Incident) string {
	r := strings.NewReplacer(
		"{camera_id}", inc.CameraID,
		"{severity}", inc.Severity,
		"{rule_id}", inc.RuleID,
	)
	return r.Replace(tpl)
}

func severityToNtfy(s string) string {
	switch s {
	case "critical":
		return "5"
	case "warning":
		return "4"
	default:
		return "3"
	}
}

func nullIfZero(n int) any {
	if n == 0 {
		return nil
	}
	return n
}

func severityRank(s string) int {
	switch s {
	case "critical":
		return 3
	case "warning":
		return 2
	case "info":
		return 1
	}
	return 0
}

// Unused helper kept for future severity-ranked filtering; suppresses the
// unused-import warning if other helpers shrink.
var _ = pgx.ErrNoRows

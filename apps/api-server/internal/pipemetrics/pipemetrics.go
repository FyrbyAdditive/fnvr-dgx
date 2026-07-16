// Package pipemetrics re-exports the pipeline workers' NATS metrics
// blobs as Prometheus gauges on api-server's existing /metrics
// endpoint — no extra scrape target.
//
// Workers publish one JSON per group every 15 s on
// fnvr.metrics.pipeline.<group_id> (see pipeline-supervisor main.cpp):
//
//	{"group_id":"all-0","dead_members":0,"members":[
//	  {"camera_id":"cam-x","input_fps":19.9,"push_fps":19.9,
//	   "infer_fps":19.8,"dead":false}]}
//
// Gauges carry {group,camera} labels. A janitor drops label sets not
// refreshed for 90 s so a replanned/retired group's cameras don't
// linger with stale rates (three missed publishes = gone).
package pipemetrics

import (
	"encoding/json"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/prometheus/client_golang/prometheus"
)

var (
	inputFPS = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "fnvr_pipeline_member_input_fps",
		Help: "Encoded frames/s arriving from the camera (depay probe).",
	}, []string{"group", "camera"})
	pushFPS = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "fnvr_pipeline_member_push_fps",
		Help: "Frames/s actually relayed to MediaMTX (push-leg probe).",
	}, []string{"group", "camera"})
	inferFPS = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "fnvr_pipeline_member_infer_fps",
		Help: "Frames/s seen by the detection probe for this camera.",
	}, []string{"group", "camera"})
	memberDead = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "fnvr_pipeline_member_dead",
		Help: "1 when the member's source chain is marked dead.",
	}, []string{"group", "camera"})
	groupDead = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "fnvr_pipeline_group_dead_members",
		Help: "Dead member count the group is carrying (pre self-heal).",
	}, []string{"group"})
)

func init() {
	prometheus.MustRegister(inputFPS, pushFPS, inferFPS, memberDead, groupDead)
}

type blob struct {
	GroupID     string `json:"group_id"`
	DeadMembers int    `json:"dead_members"`
	Members     []struct {
		CameraID string  `json:"camera_id"`
		InputFPS float64 `json:"input_fps"`
		PushFPS  float64 `json:"push_fps"`
		InferFPS float64 `json:"infer_fps"`
		Dead     bool    `json:"dead"`
	} `json:"members"`
}

type key struct{ group, camera string }

// Exporter owns the subscription and the staleness janitor.
type Exporter struct {
	nc         *nats.Conn
	mu         sync.Mutex
	seen       map[key]time.Time
	groupsSeen map[string]time.Time
	done       chan struct{}
}

const (
	subject  = "fnvr.metrics.pipeline.>"
	staleAge = 90 * time.Second
)

func New(natsURL string) (*Exporter, error) {
	nc, err := nats.Connect(natsURL,
		nats.Name("fnvr-api-pipemetrics"),
		nats.MaxReconnects(-1),
		nats.ReconnectWait(2*time.Second))
	if err != nil {
		return nil, err
	}
	e := &Exporter{nc: nc, seen: make(map[key]time.Time),
		groupsSeen: make(map[string]time.Time), done: make(chan struct{})}
	if _, err := nc.Subscribe(subject, e.handle); err != nil {
		nc.Close()
		return nil, err
	}
	go e.janitor()
	return e, nil
}

func (e *Exporter) handle(msg *nats.Msg) {
	var b blob
	if err := json.Unmarshal(msg.Data, &b); err != nil {
		slog.Warn("pipemetrics: bad blob", "subject", msg.Subject, "err", err)
		return
	}
	if b.GroupID == "" {
		// Fall back to the subject suffix so a hand-published blob
		// without the field still lands somewhere sensible.
		b.GroupID = strings.TrimPrefix(msg.Subject, "fnvr.metrics.pipeline.")
	}
	now := time.Now()
	e.mu.Lock()
	defer e.mu.Unlock()
	groupDead.WithLabelValues(b.GroupID).Set(float64(b.DeadMembers))
	e.groupsSeen[b.GroupID] = now
	for _, m := range b.Members {
		inputFPS.WithLabelValues(b.GroupID, m.CameraID).Set(m.InputFPS)
		pushFPS.WithLabelValues(b.GroupID, m.CameraID).Set(m.PushFPS)
		inferFPS.WithLabelValues(b.GroupID, m.CameraID).Set(m.InferFPS)
		d := 0.0
		if m.Dead {
			d = 1
		}
		memberDead.WithLabelValues(b.GroupID, m.CameraID).Set(d)
		e.seen[key{b.GroupID, m.CameraID}] = now
	}
}

func (e *Exporter) janitor() {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-e.done:
			return
		case <-t.C:
		}
		cutoff := time.Now().Add(-staleAge)
		e.mu.Lock()
		for k, at := range e.seen {
			if at.After(cutoff) {
				continue
			}
			inputFPS.DeleteLabelValues(k.group, k.camera)
			pushFPS.DeleteLabelValues(k.group, k.camera)
			inferFPS.DeleteLabelValues(k.group, k.camera)
			memberDead.DeleteLabelValues(k.group, k.camera)
			delete(e.seen, k)
		}
		for g, at := range e.groupsSeen {
			if at.After(cutoff) {
				continue
			}
			groupDead.DeleteLabelValues(g)
			delete(e.groupsSeen, g)
		}
		e.mu.Unlock()
	}
}

func (e *Exporter) Close() {
	close(e.done)
	e.nc.Close()
}

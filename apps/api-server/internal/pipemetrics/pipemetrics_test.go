package pipemetrics

import (
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

func testExporter() *Exporter {
	return &Exporter{
		seen:       make(map[key]time.Time),
		groupsSeen: make(map[string]time.Time),
		members:    make(map[string]MemberMetrics),
	}
}

func TestHandleAndSnapshot(t *testing.T) {
	e := testExporter()
	e.handle(&nats.Msg{
		Subject: "fnvr.metrics.pipeline.all-0",
		Data: []byte(`{"group_id":"all-0","dead_members":1,"members":[
			{"camera_id":"cam-x","input_fps":19.9,"push_fps":19.8,"infer_fps":18.7,"dead":false},
			{"camera_id":"cam-y","input_fps":0,"push_fps":0,"infer_fps":0,"dead":true}]}`),
	})
	snap := e.Snapshot()
	m, ok := snap["cam-x"]
	if !ok {
		t.Fatal("cam-x missing from snapshot")
	}
	if m.Group != "all-0" || m.InputFPS != 19.9 || m.PushFPS != 19.8 || m.InferFPS != 18.7 || m.Dead {
		t.Errorf("cam-x snapshot wrong: %+v", m)
	}
	if !snap["cam-y"].Dead {
		t.Error("cam-y dead flag lost")
	}
	if m.UpdatedAt.IsZero() {
		t.Error("UpdatedAt not stamped")
	}
	// Snapshot is a copy — mutating it must not affect the exporter.
	snap["cam-x"] = MemberMetrics{}
	if e.Snapshot()["cam-x"].InputFPS != 19.9 {
		t.Error("Snapshot returned a shared reference")
	}
}

func TestPrune(t *testing.T) {
	e := testExporter()
	e.handle(&nats.Msg{
		Subject: "fnvr.metrics.pipeline.solo-a",
		Data:    []byte(`{"group_id":"solo-a","members":[{"camera_id":"cam-z","input_fps":5}]}`),
	})
	if len(e.Snapshot()) != 1 {
		t.Fatal("expected one row before prune")
	}
	// Cutoff in the future → everything is stale.
	e.prune(time.Now().Add(time.Hour))
	if len(e.Snapshot()) != 0 {
		t.Errorf("expected empty snapshot after prune, got %v", e.Snapshot())
	}
}

func TestHandleBadBlobIgnored(t *testing.T) {
	e := testExporter()
	e.handle(&nats.Msg{Subject: "fnvr.metrics.pipeline.x", Data: []byte(`{nope`)})
	if len(e.Snapshot()) != 0 {
		t.Error("bad blob must not create rows")
	}
}

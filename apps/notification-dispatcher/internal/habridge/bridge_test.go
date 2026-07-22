package habridge

import (
	"fmt"
	"sync"
	"testing"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

// fakeClient records publishes. Every other mqtt.Client method panics
// via the nil embedded interface — these tests only publish.
type fakeClient struct {
	mqtt.Client
	mu   sync.Mutex
	pubs map[string][]string // topic → payloads
}

func (f *fakeClient) Publish(topic string, qos byte, retained bool, payload interface{}) mqtt.Token {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.pubs == nil {
		f.pubs = map[string][]string{}
	}
	f.pubs[topic] = append(f.pubs[topic], fmt.Sprintf("%s", payload))
	return nil
}

func (f *fakeClient) counts(topic string) (on, off int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, p := range f.pubs[topic] {
		switch p {
		case "ON":
			on++
		case "OFF":
			off++
		}
	}
	return on, off
}

func bridgeForTest() *Bridge {
	return &Bridge{
		cfg:            Config{TopicPrefix: "fnvr", DiscoveryPrefix: "homeassistant"},
		motionTimers:   map[string]*time.Timer{},
		incidentTimers: map[string]*time.Timer{},
		announcedCams:  map[string]struct{}{},
	}
}

func stopTimers(b *Bridge) {
	b.motionMu.Lock()
	defer b.motionMu.Unlock()
	for _, t := range b.motionTimers {
		t.Stop()
	}
	for _, t := range b.incidentTimers {
		t.Stop()
	}
}

// Run with -race. Pins the setMotion contract under concurrency: one
// ON edge per camera per quiet-period, and never an OFF while a newer
// timer is armed.
func TestSetMotionConcurrentSingleEdge(t *testing.T) {
	b := bridgeForTest()
	client := &fakeClient{}
	defer stopTimers(b)

	cams := []string{"door", "drive", "shed"}
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 200; i++ {
				b.setMotion(client, cams[i%len(cams)], true)
			}
		}()
	}
	wg.Wait()

	for _, cam := range cams {
		on, off := client.counts("fnvr/" + cam + "/motion")
		if on != 1 {
			t.Errorf("%s: want exactly one ON edge, got %d", cam, on)
		}
		if off != 0 {
			t.Errorf("%s: got %d OFF publishes while re-armed", cam, off)
		}
	}
}

// A second incident on the same camera must re-arm (not race) the
// auto-clear timer, and never publish an early OFF.
func TestIncidentTimerResets(t *testing.T) {
	b := bridgeForTest()
	client := &fakeClient{}
	defer stopTimers(b)

	b.onIncident(client, incident{CameraID: "door"})
	b.motionMu.Lock()
	first := b.incidentTimers["door"]
	b.motionMu.Unlock()

	b.onIncident(client, incident{CameraID: "door"})
	b.motionMu.Lock()
	second := b.incidentTimers["door"]
	b.motionMu.Unlock()

	if first == nil || second == nil || first == second {
		t.Fatal("second incident did not re-arm the auto-clear timer")
	}
	on, off := client.counts("fnvr/door/incident")
	if on != 2 || off != 0 {
		t.Errorf("want 2 ON / 0 OFF, got %d ON / %d OFF", on, off)
	}
}

// Package mqtthub holds a ref-counted pool of MQTT broker connections
// shared between the MQTT notification channel (per-incident publishes)
// and the Home Assistant bridge (long-lived discovery + state). One TCP
// session per (broker_url, username) pair, torn down when the last
// caller releases.
package mqtthub

import (
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

// StatusOnline / StatusOffline are the retained LWT payloads published
// on each entry's availability topic so Home Assistant can grey out
// entities when the dispatcher dies.
const (
	StatusOnline       = "online"
	StatusOffline      = "offline"
	availabilityTopic  = "fnvr/bridge/status"
	defaultConnectWait = 8 * time.Second
)

type entryKey struct {
	brokerURL string
	username  string
}

type entry struct {
	client   mqtt.Client
	refcount int
}

// Hub is goroutine-safe; both the dispatcher's per-incident goroutines
// and the HA bridge reach into it concurrently.
type Hub struct {
	mu      sync.Mutex
	entries map[entryKey]*entry
}

func New() *Hub {
	return &Hub{entries: map[entryKey]*entry{}}
}

// Acquire returns a ready client for (brokerURL, username, password).
// Subsequent callers with the same (brokerURL, username) share the same
// connection. Release() must be called when the caller is done; on the
// last release the connection disconnects.
func (h *Hub) Acquire(brokerURL, username, password string) (mqtt.Client, func(), error) {
	if brokerURL == "" {
		return nil, nil, errors.New("broker_url required")
	}
	key := entryKey{brokerURL: brokerURL, username: username}
	h.mu.Lock()
	defer h.mu.Unlock()
	if e, ok := h.entries[key]; ok {
		e.refcount++
		return e.client, h.releaser(key), nil
	}
	opts := mqtt.NewClientOptions().
		AddBroker(brokerURL).
		SetClientID(fmt.Sprintf("fnvr-%d", time.Now().UnixNano())).
		SetCleanSession(true).
		SetAutoReconnect(true).
		SetConnectRetry(true).
		SetConnectRetryInterval(2 * time.Second).
		SetMaxReconnectInterval(30 * time.Second).
		SetKeepAlive(30 * time.Second).
		SetOrderMatters(false).
		SetWill(availabilityTopic, StatusOffline, 1, true).
		SetOnConnectHandler(func(c mqtt.Client) {
			// Publish "online" each time we (re)connect so the LWT-
			// produced "offline" from a previous crash gets cleared.
			c.Publish(availabilityTopic, 1, true, StatusOnline)
			slog.Info("mqtt: connected", "broker", brokerURL)
		}).
		SetConnectionLostHandler(func(_ mqtt.Client, err error) {
			slog.Warn("mqtt: connection lost", "broker", brokerURL, "err", err)
		})
	if username != "" {
		opts.SetUsername(username)
		opts.SetPassword(password)
	}
	client := mqtt.NewClient(opts)
	token := client.Connect()
	if !token.WaitTimeout(defaultConnectWait) {
		return nil, nil, fmt.Errorf("mqtt: connect timeout to %s", brokerURL)
	}
	if err := token.Error(); err != nil {
		return nil, nil, fmt.Errorf("mqtt: %w", err)
	}
	h.entries[key] = &entry{client: client, refcount: 1}
	return client, h.releaser(key), nil
}

func (h *Hub) releaser(key entryKey) func() {
	var once sync.Once
	return func() {
		once.Do(func() {
			h.mu.Lock()
			defer h.mu.Unlock()
			e, ok := h.entries[key]
			if !ok {
				return
			}
			e.refcount--
			if e.refcount <= 0 {
				// Publish availability="offline" retained before we
				// disconnect so HA sees it even without the LWT path.
				token := e.client.Publish(availabilityTopic, 1, true, StatusOffline)
				token.WaitTimeout(2 * time.Second)
				e.client.Disconnect(500)
				delete(h.entries, key)
			}
		})
	}
}

// Close tears down every connection. Called on dispatcher shutdown.
func (h *Hub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for key, e := range h.entries {
		token := e.client.Publish(availabilityTopic, 1, true, StatusOffline)
		token.WaitTimeout(2 * time.Second)
		e.client.Disconnect(500)
		delete(h.entries, key)
	}
}

// AvailabilityTopic returns the topic the LWT + ON/OFF messages are
// published on. HA bridge wires it into each discovery config so HA
// can grey out the whole device on dispatcher failure.
func AvailabilityTopic() string { return availabilityTopic }

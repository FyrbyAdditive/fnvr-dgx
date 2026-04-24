package mtxproxy

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"fmt"
	"net"
	"net/url"
	"strings"
	"time"
)

// ProbeFingerprint dials the host+port from an RTSPS URL and returns
// the SHA256 fingerprint of the leaf TLS certificate, formatted like
// "AA:BB:CC:...". Used by the "Ignore certificate" UI affordance to
// auto-fill the fingerprint rather than making the operator copy-paste.
//
// The URL may use any scheme; only the host:port is used. Defaults to
// port 322 if no port is present (Bambu's convention); the caller
// should pass a URL with an explicit port for other devices.
func ProbeFingerprint(ctx context.Context, rawURL string) (string, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return "", fmt.Errorf("parse url: %w", err)
	}
	host := u.Hostname()
	port := u.Port()
	if port == "" {
		port = "322"
	}
	if host == "" {
		return "", fmt.Errorf("url has no host: %s", rawURL)
	}
	addr := net.JoinHostPort(host, port)

	dctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	dialer := &tls.Dialer{
		NetDialer: &net.Dialer{Timeout: 5 * time.Second},
		Config: &tls.Config{
			// We're probing *to compute the fingerprint* — any cert
			// goes. This is fine: the probe result is immediately
			// shown to a human who must confirm the pin.
			InsecureSkipVerify: true,
			ServerName:         host,
		},
	}
	conn, err := dialer.DialContext(dctx, "tcp", addr)
	if err != nil {
		return "", fmt.Errorf("tls dial %s: %w", addr, err)
	}
	defer conn.Close()
	tlsConn, ok := conn.(*tls.Conn)
	if !ok {
		return "", fmt.Errorf("not a tls conn")
	}
	state := tlsConn.ConnectionState()
	if len(state.PeerCertificates) == 0 {
		return "", fmt.Errorf("no peer certificates")
	}
	leaf := state.PeerCertificates[0]
	sum := sha256.Sum256(leaf.Raw)
	// MediaMTX expects lowercase hex with no separators (matches the
	// format its RTSP client computes from the observed cert). Earlier
	// we stored "AA:BB:..." and MediaMTX's equality check rejected it
	// with `source fingerprint does not match`.
	var sb strings.Builder
	sb.Grow(len(sum) * 2)
	for _, b := range sum {
		sb.WriteString(fmt.Sprintf("%02x", b))
	}
	return sb.String(), nil
}

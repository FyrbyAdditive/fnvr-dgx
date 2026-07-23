// Package pipeline wraps the gRPC client to pipeline-supervisor.
//
// The real generated stubs land once `buf generate` runs (see libs/proto/).
// Until then, this file defines a narrow interface that the rest of the server
// calls through — so when the generated stubs arrive we only swap the impl.
package pipeline

import (
	"context"
	"log/slog"
	"net/url"
)

// redactURL strips embedded credentials so RTSP passwords aren't logged.
func redactURL(raw string) string {
	if u, err := url.Parse(raw); err == nil && u.User != nil {
		u.User = url.User("***")
		return u.String()
	}
	return raw
}

type AddCameraArgs struct {
	ID            string
	URL           string
	SubstreamURL  string
	RecordingMode string
}

type CameraStatus struct {
	ID    string
	State string // connecting | running | reconnecting | error
	Error string
}

type Client interface {
	AddCamera(ctx context.Context, args AddCameraArgs) (CameraStatus, error)
	RemoveCamera(ctx context.Context, id string) (CameraStatus, error)
	SetRecordingMode(ctx context.Context, id, mode string) (CameraStatus, error)
}

// LoggingClient is a no-op impl used until the generated gRPC stubs land.
// It lets the rest of api-server exercise the control-plane code path on a
// dev box without pipeline-supervisor running.
type LoggingClient struct{}

func (LoggingClient) AddCamera(_ context.Context, args AddCameraArgs) (CameraStatus, error) {
	slog.Info("pipeline(stub): AddCamera", "id", args.ID, "url", redactURL(args.URL))
	return CameraStatus{ID: args.ID, State: "connecting"}, nil
}
func (LoggingClient) RemoveCamera(_ context.Context, id string) (CameraStatus, error) {
	slog.Info("pipeline(stub): RemoveCamera", "id", id)
	return CameraStatus{ID: id, State: "removed"}, nil
}
func (LoggingClient) SetRecordingMode(_ context.Context, id, mode string) (CameraStatus, error) {
	slog.Info("pipeline(stub): SetRecordingMode", "id", id, "mode", mode)
	return CameraStatus{ID: id, State: "running"}, nil
}

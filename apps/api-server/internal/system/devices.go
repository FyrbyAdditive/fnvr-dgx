// Package system surfaces read-only information about the host for the
// setup/discovery flows: local video devices, disk capacity, GPU health.
// M2: local V4L2 devices only; the rest lands in M3.
package system

import (
	"bufio"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type LocalDevice struct {
	Path         string   `json:"path"`
	Label        string   `json:"label"`
	Capabilities []string `json:"capabilities"`
}

// ListLocalVideoDevices inspects /sys/class/video4linux/videoN/ for each
// /dev/videoN node and pulls the product name + (if reachable) capability
// bits. When running in a container we typically only have the `name` file
// readable; `device_caps` is at the symlink target which may be unreachable.
// In that case we return the device anyway and let the operator pick.
//
// Special cases filtered out: the Tegra /dev/v4l2-nvdec / /dev/v4l2-nvenc
// stubs — they aren't capture devices and show up in v4l2 enumeration on
// Jetson but should never appear as a pickable camera.
func ListLocalVideoDevices() ([]LocalDevice, error) {
	matches, err := filepath.Glob("/sys/class/video4linux/video*")
	if err != nil {
		return nil, err
	}
	out := make([]LocalDevice, 0, len(matches))
	for _, sys := range matches {
		base := filepath.Base(sys) // "videoN"
		dev := "/dev/" + base

		caps := readDeviceCaps(sys)
		// If we can read caps, filter to capture-only. If we can't, include
		// the device — user + pipeline probe is the fallback.
		if len(caps) > 0 && !hasCap(caps, "video_capture") {
			continue
		}

		label := readTrim(filepath.Join(sys, "name"))
		if label == "" {
			label = base
		}
		// Filter the Tegra v4l2-nvdec/nvenc stubs that sometimes register
		// a /dev/video* alias. Match by label since their paths may vary.
		lower := strings.ToLower(label)
		if strings.Contains(lower, "nvdec") || strings.Contains(lower, "nvenc") {
			continue
		}
		out = append(out, LocalDevice{Path: dev, Label: label, Capabilities: caps})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, nil
}

func readTrim(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// readDeviceCaps parses /sys/class/video4linux/videoN/device_caps — a
// comma-separated list on newer kernels, or the older format on older ones.
func readDeviceCaps(sys string) []string {
	f, err := os.Open(filepath.Join(sys, "device_caps"))
	if err != nil {
		return nil
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Scan()
	line := strings.TrimSpace(sc.Text())
	if line == "" {
		return nil
	}
	parts := strings.FieldsFunc(line, func(r rune) bool { return r == ',' || r == ' ' })
	for i, p := range parts {
		parts[i] = strings.ToLower(strings.TrimSpace(p))
	}
	return parts
}

func hasCap(caps []string, want string) bool {
	for _, c := range caps {
		if c == want {
			return true
		}
	}
	return false
}

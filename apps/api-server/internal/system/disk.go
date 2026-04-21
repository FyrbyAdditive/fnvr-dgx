package system

import (
	"fmt"
	"syscall"
)

// DiskUsage is the snapshot returned for a single filesystem path.
type DiskUsage struct {
	Path       string  `json:"path"`
	TotalBytes uint64  `json:"total_bytes"`
	FreeBytes  uint64  `json:"free_bytes"`
	FreePct    float64 `json:"free_pct"`
}

// StatDisk returns total + free bytes for the filesystem containing path.
// Mirrors the storage-manager's freeSpacePercent but returns absolute
// byte counts as well so the UI can render "420 GB free of 2.0 TB".
func StatDisk(path string) (DiskUsage, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return DiskUsage{}, err
	}
	total := st.Blocks * uint64(st.Bsize)
	avail := st.Bavail * uint64(st.Bsize)
	if total == 0 {
		return DiskUsage{}, fmt.Errorf("total blocks == 0 at %s", path)
	}
	return DiskUsage{
		Path:       path,
		TotalBytes: total,
		FreeBytes:  avail,
		FreePct:    100.0 * float64(avail) / float64(total),
	}, nil
}

# Jetson AGX Orin host setup (notes)

Before `docker compose up`:

1. **JetPack 6.x** flashed. Confirm with `cat /etc/nv_tegra_release`.
2. **nvidia-container-toolkit** installed and `docker info` shows `Default Runtime: nvidia`.
3. **Power mode:** `sudo nvpmodel -m 0 && sudo jetson_clocks` for MAXN (adjust to your thermal/power envelope).
4. **Recording disk:** mount 2TB NVMe at `/var/lib/fnvr`. Recommend XFS + `noatime`:
   ```
   sudo mkfs.xfs /dev/nvme1n1
   sudo mkdir -p /var/lib/fnvr
   sudo mount -o noatime /dev/nvme1n1 /var/lib/fnvr
   # Add to /etc/fstab for persistence.
   ```
5. **NTP** synced (`timedatectl`) — segment filenames and event timestamps are evidence.
6. **UPS** via `nut-client` recommended for graceful shutdown.

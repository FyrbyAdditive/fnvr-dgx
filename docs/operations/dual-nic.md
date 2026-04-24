# Dual-NIC deployment

Optional topology where the Jetson has **two host interfaces** — one that
reaches the cameras on an isolated VLAN, one that serves the web UI to
end users. A compromised camera then can't talk to the user LAN through
the NVR, and a compromised user-LAN host can't pivot to cameras.

Single-NIC users should skip this doc entirely — the default
[docker-compose.yml](../../deploy/docker/docker-compose.yml) does the
right thing on one interface.

## Topology

```
            trusted LAN (users)        isolated cameras VLAN
            192.168.1.0/24             10.50.0.0/24
                   |                          |
                   |  enp1s0            enp3s0  |
                   +------------+     +--------+
                                |     |
                              +----------+
                              |  Jetson  |   FNVR_USER_NIC_IP = 192.168.1.10
                              |   (fnvr) |   cam-NIC IP       = 10.50.0.1
                              +----------+
```

Cameras are configured in the UI with their cam-VLAN URLs, e.g.
`rtsp://admin:pw@10.50.0.42:554/...`. No code change knows or cares
which NIC is which — that's determined entirely by the host routing
table and by which NIC we bind the user-facing ports to.

## 1. Host routing: force outbound RTSP onto the cam NIC

**Minimal** — works as long as no other default/longer-prefix route wins:

```sh
sudo ip route replace 10.50.0.0/24 dev enp3s0 src 10.50.0.1
```

**Stronger isolation** using a dedicated routing table + ingress rule,
so traffic arriving on the cam NIC can only egress back out the cam
NIC (even if `ip_forward` is on for docker):

```sh
echo "200 fnvr_cam" | sudo tee -a /etc/iproute2/rt_tables
sudo ip rule  add iif enp3s0 table fnvr_cam priority 1000
sudo ip route add 10.50.0.0/24 dev enp3s0 table fnvr_cam
sudo ip route add unreachable default      table fnvr_cam
```

Persist via NetworkManager keyfile or `/etc/systemd/network/` — see
[jetson-host-setup.md](./jetson-host-setup.md) for the house style.

## 2. Block inter-NIC forwarding through the docker bridge

Docker bypasses the regular `FORWARD` chain and installs its own rules.
The supported injection point is the `DOCKER-USER` chain — rules there
run before docker's. Add drops in both directions:

```sh
sudo iptables -I DOCKER-USER -i enp3s0 -o enp1s0 -j DROP
sudo iptables -I DOCKER-USER -i enp1s0 -o enp3s0 -j DROP
```

Persist with `iptables-save > /etc/iptables/rules.v4` and
`apt install iptables-persistent` (or `netfilter-persistent`).

Optionally also `sysctl net.ipv4.ip_forward=0` — Docker flips this on
at start, so it won't stick, but the `DOCKER-USER` drops are the real
guard.

## 3. Bind inbound ports to the user NIC only

Use the override file:

```sh
export FNVR_USER_NIC_IP=192.168.1.10
docker compose \
  -f deploy/docker/docker-compose.yml \
  -f deploy/docker/docker-compose.dual-nic.yml \
  up -d
```

What the override does:

| Service    | Default ports        | With override                       |
| ---------- | -------------------- | ----------------------------------- |
| `web`      | `0.0.0.0:8080:80`    | `FNVR_USER_NIC_IP:8080:80`          |
| `api`      | `0.0.0.0:8081:8081`  | `FNVR_USER_NIC_IP:8081:8081`        |
| `nats`     | `0.0.0.0:4222`, `0.0.0.0:8222` | `4222` withdrawn · `8222` on user NIC |
| `mediamtx` | `0.0.0.0:8554`, `0.0.0.0:8889` | withdrawn (both) — usb-bridge + pipeline reach it via docker DNS |

`postgres`, `events`, `storage`, `notifications`, `pipeline`, and
`usb-bridge` were never host-exposed; the override doesn't need to
touch them.

## 4. Verify

Host side:

```sh
# Cameras go via enp3s0:
ip route get 10.50.0.42
# → ... dev enp3s0 src 10.50.0.1 ...

# Default (and everything else) still goes via the user NIC:
ip route get 8.8.8.8
# → ... dev enp1s0 ...
```

Listener bindings (every row should name the user NIC IP, never
`0.0.0.0`):

```sh
sudo ss -tlpn | grep -E ':(8080|8081|8222) '
```

NATS client port should not appear at all:

```sh
sudo ss -tlpn | grep ':4222 '   # → no output
```

From a cam-VLAN host:

```sh
curl -m 2 http://10.50.0.1:8080/   # → connection refused / timeout
```

From a user-LAN host:

```sh
curl http://192.168.1.10:8080/     # → serves the UI
```

Inside the pipeline container, inter-service DNS must still resolve
(the overlay changes host binds only, not the internal `fnvr_default`
bridge):

```sh
sudo docker exec fnvr-pipeline-1 getent hosts postgres
# → <docker-bridge-ip>  postgres
```

## Known risks

**WebRTC ICE on dual NICs.** `webrtcbin` inside the pipeline container
advertises SDP candidates using the container's docker-bridge address
(typically `172.x.x.x`). Browsers on the user LAN reach those via
docker's NAT today, which works in single-NIC setups and should still
work here since the docker bridge is the same. If ICE negotiation
fails in your environment, fixing it properly means either exposing
WHEP viewer ports through the api proxy (already the case) plus
candidate rewriting, or running the pipeline with `network_mode: host`
(heavier, see non-goals). File an issue with your topology if you hit
it.

## Non-goals

- No attempt to bind `rtspsrc`'s outbound socket to a specific interface
  inside the pipeline container — interface selection comes from the
  host routing table set up in section 1.
- No firewall rule blocking NATS `4222` on the host — the override
  simply doesn't publish it, which is sufficient.
- No changes to the default single-NIC path. Omit
  `docker-compose.dual-nic.yml` from your compose command and you're
  back to the shipped defaults.
- No new docker networks. `fnvr_default` is unchanged, so
  service-to-service DNS (`postgres`, `nats`, `mediamtx`) still works.

## IPv6

`FNVR_USER_NIC_IP` is IPv4. If your user NIC has a reachable IPv6
address you want the UI on too, extend the override's `ports:` lists
with a second literal line using the `[v6]:hostport:containerport`
syntax, e.g.:

```yaml
services:
  web:
    ports:
      - "${FNVR_USER_NIC_IP}:8080:80"
      - "[2001:db8::10]:8080:80"
```

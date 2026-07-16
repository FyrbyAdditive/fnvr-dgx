#!/usr/bin/env python3
"""fnvr playback transcoder — on-demand H.265→H.264 for browsers.

Runs from the pipeline image (same GStreamer + NVDEC/NVENC stack) as
the `transcoder` compose service. The web timeline calls this instead
of MediaMTX's playback endpoint when the browser can't decode H.265
in MSE (Firefox, some remote clients):

    GET /get?path=live_<cam>&start=<RFC3339>&duration=<sec>

The handler proxies the SAME query to MediaMTX playback
(http://mediamtx:9996/get?...&format=fmp4), decodes on NVDEC,
re-encodes H.264 on NVENC (both units are otherwise idle during
scrubbing) and streams fragmented MP4 straight to the client — no
temp files, ~0 CPU. A dead client kills its pipeline within a write
timeout. Concurrency is bounded to protect the live fleet's encoder
sessions.

Deliberately boring: stdlib http.server + one gst-launch subprocess
per request.
"""
from __future__ import annotations

import http.server
import os
import shlex
import signal
import socketserver
import subprocess
import threading
import urllib.parse

MTX = os.environ.get("FNVR_MTX_PLAYBACK", "http://mediamtx:9996")
PORT = int(os.environ.get("FNVR_TRANSCODER_PORT", "9995"))
# NVENC also carries the live-proxy streams; cap concurrent transcodes.
MAX_CONCURRENT = int(os.environ.get("FNVR_TRANSCODER_MAX", "3"))
BITRATE = os.environ.get("FNVR_TRANSCODER_BITRATE", "4000000")

_sem = threading.Semaphore(MAX_CONCURRENT)


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quieter default log line
        print(f"transcoder: {self.address_string()} {fmt % args}", flush=True)

    def do_GET(self):  # noqa: N802 (stdlib naming)
        u = urllib.parse.urlparse(self.path)
        if u.path != "/get":
            self.send_error(404)
            return
        q = urllib.parse.parse_qs(u.query)
        path = q.get("path", [""])[0]
        start = q.get("start", [""])[0]
        duration = q.get("duration", [""])[0]
        if not path.replace("_", "").replace("-", "").isalnum() or not start:
            self.send_error(400, "bad path/start")
            return

        src_q = urllib.parse.urlencode(
            {"path": path, "start": start, "duration": duration,
             "format": "fmp4"})
        src = f"{MTX}/get?{src_q}"

        if not _sem.acquire(timeout=10):
            self.send_error(503, "transcoder busy")
            return
        try:
            self._stream(src)
        finally:
            _sem.release()

    def _stream(self, src: str):
        # decodebin picks nvv4l2decoder (top-ranked) for H.264/H.265
        # alike; NVMM caps keep decode→convert→encode zero-copy.
        pipeline = (
            f"souphttpsrc location={shlex.quote(src)} ! "
            "qtdemux ! parsebin ! nvv4l2decoder name=dec ! "
            "nvvideoconvert compute-hw=1 ! "
            "video/x-raw(memory:NVMM),format=NV12 ! "
            f"nvv4l2h264enc bitrate={BITRATE} insert-sps-pps=1 "
            "iframeinterval=30 idrinterval=30 ! h264parse ! "
            "mp4mux streamable=true fragment-duration=1000 ! "
            "fdsink fd=1 sync=false"
        )
        proc = subprocess.Popen(
            ["gst-launch-1.0", "-q"] + shlex.split(pipeline),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            preexec_fn=os.setsid,
        )
        try:
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Access-Control-Allow-Origin", "*")
            # Streamed fMP4 — no length; close delimits.
            self.send_header("Connection", "close")
            self.end_headers()
            while True:
                chunk = proc.stdout.read(64 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass  # client went away — normal during scrubbing
        finally:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait()


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    print(f"transcoder: listening :{PORT} → {MTX} "
          f"(max {MAX_CONCURRENT} concurrent)", flush=True)
    Server(("", PORT), Handler).serve_forever()

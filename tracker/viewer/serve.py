#!/usr/bin/env python3
"""Tiny static server for the tracker viewer. Pure stdlib, like the tracker.

    python viewer/serve.py          # -> http://127.0.0.1:8080/viewer/

Serves the whole tracker folder, so the page is at /viewer/ and the CSVs it reads
are at /data/ -- which is why the viewer's default data path is "../data".

You could point any static file server at this folder instead, but this one adds
the two things the viewer actually benefits from:

  * Range requests. Live mode tails the CSVs by asking for only the bytes
    appended since the last poll. http.server does not implement Range, so
    without this every poll would re-download a growing file (already ~1 MB
    after a day). With it, a poll transfers a few hundred bytes.

  * GET /api/images. Historical tile replay needs to know WHICH tile snapshots
    exist in data/chunks/, and plain HTTP offers no directory listing. This
    returns the filenames as JSON; the viewer falls back to the server's current
    tiles when it is absent.
"""

import argparse
import json
import os
import posixpath
import re
import sys
import webbrowser
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent      # the tracker/ folder
RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"                  # keep-alive; Range needs it to be worth it

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/images":
            return self.api_images()
        if path == "/":
            self.send_response(HTTPStatus.FOUND)
            self.send_header("Location", "/viewer/")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.headers.get("Range"):
            return self.send_range()
        return super().do_GET()

    # ---- Range support ---------------------------------------------------

    def send_range(self):
        """Serve a byte range so live mode can tail an appending CSV cheaply."""
        local = Path(self.translate_path(self.path))
        if not local.is_file():
            return super().do_GET()                # let the base class 404/list it

        match = RANGE_RE.match(self.headers["Range"].strip())
        if not match:
            return super().do_GET()                # unsatisfiable syntax: just send it all

        size = local.stat().st_size
        start_s, end_s = match.group(1), match.group(2)
        if start_s == "":
            # "bytes=-N" means the LAST n bytes.
            if end_s == "":
                return super().do_GET()
            length = min(int(end_s), size)
            start, end = size - length, size - 1
        else:
            start = int(start_s)
            end = int(end_s) if end_s else size - 1
        end = min(end, size - 1)

        if start > end or start >= size:
            # The viewer treats this as "nothing new", and uses the total to spot
            # a file that was truncated or rotated out from under it.
            self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            self.send_header("Content-Range", "bytes */%d" % size)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        length = end - start + 1
        self.send_response(HTTPStatus.PARTIAL_CONTENT)
        self.send_header("Content-Type", self.guess_type(str(local)))
        self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        with local.open("rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(65536, remaining))
                if not chunk:
                    # The file shrank after we stat()ed it (rotation, truncation, a
                    # fresh CSV copied over it) so we cannot deliver the
                    # Content-Length we already promised. On a keep-alive
                    # connection a short body desyncs the stream and the client
                    # reads the next response's status line as this body. Force the
                    # connection shut so the client sees a clean transport error it
                    # can retry instead of silently corrupt data.
                    self.close_connection = True
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    # ---- saved tile images ----------------------------------------------

    def api_images(self):
        """Filenames in data/chunks/, so the viewer can prefer real snapshots.

        tracker.py names them "<tile_ts>_<map>_<regX>_<regZ>_<tileX>_<tileZ>.png";
        the viewer rebuilds that name from a CSV row and checks membership.
        """
        out = []
        chunks = ROOT / "data" / "chunks"
        try:
            with os.scandir(chunks) as it:
                for entry in it:
                    if entry.is_file() and entry.name.lower().endswith(".png"):
                        out.append(entry.name)
        except FileNotFoundError:
            pass                                   # SAVE_IMAGES was never on: empty list
        body = json.dumps(out).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ---- headers ---------------------------------------------------------

    def end_headers(self):
        # Nothing here is worth caching. The CSVs are appended to while the page
        # is open, so a cached copy is always the wrong answer; and the viewer's
        # own JS/CSS are edited in place, where a stale cached copy silently
        # serves you the previous version and makes you debug code you already
        # fixed. This is a localhost tool -- caching buys nothing.
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def log_message(self, fmt, *args):
        # One tidy line, and skip the live-mode poll spam.
        #
        # getattr, not self.path: BaseHTTPRequestHandler has no class-level "path"
        # and does not set one when a request fails to parse, yet it logs through
        # here from send_error() on exactly that path. Touching self.path directly
        # raised AttributeError out of the handler, so a malformed request line got
        # no response at all instead of the intended 400.
        path = getattr(self, "path", "")
        if "/data/" in path and "206" in str(args):
            return
        sys.stderr.write("[serve] %s\n" % (fmt % args))


def main():
    ap = argparse.ArgumentParser(description="Serve the tracker folder for the viewer.")
    ap.add_argument("-p", "--port", type=int, default=int(os.environ.get("VIEWER_PORT", "8080")))
    ap.add_argument("--host", default=os.environ.get("VIEWER_HOST", "127.0.0.1"),
                    help="bind address (default 127.0.0.1; use 0.0.0.0 to expose on your LAN)")
    ap.add_argument("--no-browser", action="store_true", help="do not open a browser window")
    args = ap.parse_args()

    handler = partial(Handler, directory=str(ROOT))
    server = ThreadingHTTPServer((args.host, args.port), handler)
    url = "http://%s:%d/viewer/" % ("127.0.0.1" if args.host in ("0.0.0.0", "") else args.host, args.port)

    data = ROOT / "data"
    print("[serve] root   %s" % ROOT)
    print("[serve] data   %s" % ("found" if data.is_dir() else "MISSING -- run tracker.py first"))
    print("[serve] viewer %s" % url)
    if not args.no_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[serve] stopped")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

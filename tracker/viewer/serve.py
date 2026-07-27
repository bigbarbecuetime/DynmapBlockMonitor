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
import csv
import json
import os
import posixpath
import re
import sys
import urllib.error
import urllib.request
import webbrowser
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# The folder served as "/". Defaults to tracker/, so the page is at /viewer/ and
# the CSVs at /data/. main() can point it elsewhere with --root.
ROOT = Path(__file__).resolve().parent.parent
RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")


WORLD_RE = re.compile(r"^[A-Za-z0-9_.\-]{1,64}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
STAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
NAME_RE = re.compile(r"^[A-Za-z0-9_]{1,32}$")

# Ground truth, typed in by a human: "at this instant this player was standing
# HERE". It is the only thing in the system that knows a real position, so it is
# what any fit or accuracy claim has to be scored against.
#
# Kept in its own directory rather than data/, because the viewer mounts data/
# READ-ONLY on purpose -- it should never be able to corrupt what the tracker
# recorded. Calibration is the one thing the page legitimately writes, so it gets
# a separate writable mount and that guarantee survives.
CAL_DIR = ROOT / "calibration"
CAL_FILE = CAL_DIR / "calibration.csv"
CAL_FIELDS = ["time", "player", "x", "y", "z", "activity", "radius", "note"]
# What the player was doing matters as much as where. Standing still and mining
# produce completely different render signatures -- ambient growth around a
# stationary disc versus blockbreak at the player -- so a fit that ignores the
# activity is averaging two different physical processes.
CAL_ACTIVITIES = ("standing", "walking", "running", "mining", "building",
                  "boat", "horse", "elytra", "portal", "unknown")
CAL_MAX_ROWS = 20000
CAL_MAX_BODY = 4096

# Outside data the viewer overlays, each pinned to one host and one shape of path.
# Nothing here takes a caller-supplied host: these are proxied only because the
# upstreams send no Access-Control-Allow-Origin, not to be a general fetcher.
CRAFTIX = "https://craftix.cx"            # historical political maps, 1px = 1 block
NELT = "https://nelt.chipthrasher.com"    # nether highway + public portals


def _truthy(value):
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def dynmap_url():
    """The Dynmap base URL, from the environment or the tracker's own .env.

    Deliberately NOT taken from the request: /api/markers builds a server-side
    request out of this, and accepting a caller-supplied host would turn the
    viewer into an open relay that can be pointed at anything the host can reach.
    """
    url = os.environ.get("DYNMAP_URL", "").strip()
    if not url:
        envf = ROOT / ".env"
        try:
            for line in envf.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line.startswith("DYNMAP_URL="):
                    url = line.split("=", 1)[1].strip()
                    break
        except OSError:
            pass
    return url.rstrip("/")


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"                  # keep-alive; Range needs it to be worth it

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/images":
            return self.api_images()
        if path == "/api/markers":
            return self.api_markers()
        if path.startswith("/api/political/"):
            return self.api_political(path[len("/api/political/"):])
        if path.startswith("/api/nelt/"):
            return self.api_nelt(path[len("/api/nelt/"):])
        if path == "/api/calibration":
            return self.api_calibration_list()
        if path == "/api/config":
            # Same CORS problem as the markers, same fixed-host mitigation. This
            # carries each map type's worldtomap matrix, which is what lets the
            # viewer combine a flat tile with an isometric one to recover height.
            return self.api_proxy("/up/configuration")
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

    # ---- marker layer ----------------------------------------------------

    def api_markers(self):
        """Proxy Dynmap's marker layer, which carries the world border.

        Dynmap serves /tiles/_markers_/marker_<world>.json with no
        Access-Control-Allow-Origin, so the page cannot fetch() it directly from
        a different origin -- tile <img> loads work because images need no CORS,
        but JSON does. Hence this hop.

        The world name is the only caller-supplied part, and it is pattern-checked
        before being pasted into a path; the host comes from DYNMAP_URL.
        """
        from urllib.parse import parse_qs, urlparse as _urlparse
        world = (parse_qs(_urlparse(self.path).query).get("world") or [""])[0]
        if not WORLD_RE.match(world):
            return self._json_error(HTTPStatus.BAD_REQUEST, "bad or missing 'world'")

        return self.api_proxy("/tiles/_markers_/marker_%s.json" % world)

    def api_proxy(self, suffix):
        """Fetch a fixed path from the configured Dynmap and pass it through.

        The caller never supplies the host -- only whatever the calling method has
        already validated goes into `suffix` -- so this cannot be aimed elsewhere.
        """
        base = dynmap_url()
        if not base:
            return self._json_error(HTTPStatus.SERVICE_UNAVAILABLE,
                                    "DYNMAP_URL is not set (env or tracker/.env)")
        url = base + suffix
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "dynmap-viewer"})
            with urllib.request.urlopen(req, timeout=8) as r:
                body = r.read()
        except urllib.error.HTTPError as e:
            return self._json_error(HTTPStatus.BAD_GATEWAY, "dynmap returned %d for %s" % (e.code, url))
        except Exception as e:
            return self._json_error(HTTPStatus.BAD_GATEWAY, "could not reach dynmap: %s" % e)

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ---- calibration: the only thing the page is allowed to write ---------

    def do_POST(self):
        path = getattr(self, "path", "").split("?", 1)[0]
        if path == "/api/calibration":
            return self.api_calibration_add()
        return self._json_error(HTTPStatus.NOT_FOUND, "no such endpoint")

    @staticmethod
    def _roster_at(stamp):
        """Who the game server reported online at `stamp`, or None if unknown.

        players.csv is a step function -- a row is written only when the roster
        CHANGES -- so the answer is the last snapshot at or before the instant,
        and every row sharing that timestamp is one name in it. Returns None
        rather than an empty list when the log cannot be read or the instant
        predates it, so "we do not know" never reads as "nobody was on".
        """
        path = ROOT / "data" / "players.csv"
        try:
            best_time, names, seen_any = None, [], False
            with path.open("r", encoding="utf-8", newline="") as f:
                for row in csv.DictReader(f):
                    t = (row.get("time") or "").strip()
                    if not t or not (row.get("count") or "").strip():
                        continue
                    seen_any = True
                    if t > stamp:
                        break
                    if t != best_time:
                        best_time, names = t, []
                    who = (row.get("player") or "").strip()
                    if who:
                        names.append(who)
            return names if (seen_any and best_time is not None) else None
        except OSError:
            return None

    def api_calibration_list(self):
        rows = []
        try:
            with CAL_FILE.open("r", encoding="utf-8", newline="") as f:
                for row in csv.DictReader(f):
                    rows.append({k: row.get(k, "") for k in CAL_FIELDS})
        except FileNotFoundError:
            pass
        except OSError as e:
            return self._json_error(HTTPStatus.INTERNAL_SERVER_ERROR, "could not read calibration: %s" % e)
        return self._send_json({"records": rows})

    def api_calibration_add(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._json_error(HTTPStatus.BAD_REQUEST, "bad Content-Length")
        if length <= 0 or length > CAL_MAX_BODY:
            return self._json_error(HTTPStatus.BAD_REQUEST,
                                    "body must be 1..%d bytes" % CAL_MAX_BODY)
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception as e:
            return self._json_error(HTTPStatus.BAD_REQUEST, "body is not JSON: %s" % e)
        if not isinstance(payload, dict):
            return self._json_error(HTTPStatus.BAD_REQUEST, "expected a JSON object")

        # Validate every field before touching the file: a calibration record is
        # ground truth, and a malformed one is worse than a missing one because
        # everything downstream trusts it.
        stamp = str(payload.get("time", "")).strip()
        if not STAMP_RE.match(stamp):
            return self._json_error(HTTPStatus.BAD_REQUEST, "time must be YYYY-MM-DDTHH:MM:SSZ")
        player = str(payload.get("player", "")).strip()
        if not NAME_RE.match(player):
            return self._json_error(HTTPStatus.BAD_REQUEST, "player must be 1-32 chars of [A-Za-z0-9_]")
        coords = {}
        for axis in ("x", "y", "z"):
            try:
                coords[axis] = float(payload.get(axis))
            except (TypeError, ValueError):
                return self._json_error(HTTPStatus.BAD_REQUEST, "%s must be a number" % axis)
            if not -30e6 <= coords[axis] <= 30e6:
                return self._json_error(HTTPStatus.BAD_REQUEST, "%s is outside the world border" % axis)
        activity = str(payload.get("activity", "unknown")).strip().lower() or "unknown"
        if activity not in CAL_ACTIVITIES:
            return self._json_error(HTTPStatus.BAD_REQUEST,
                                    "activity must be one of: %s" % ", ".join(CAL_ACTIVITIES))
        try:
            radius = float(payload.get("radius", 0) or 0)
        except (TypeError, ValueError):
            return self._json_error(HTTPStatus.BAD_REQUEST, "radius must be a number")
        if not 0 <= radius <= 4096:
            return self._json_error(HTTPStatus.BAD_REQUEST, "radius must be 0..4096 blocks")
        note = str(payload.get("note", ""))[:200].replace("\n", " ").replace("\r", " ")

        # A player who was not online cannot have been standing anywhere, so a
        # record saying otherwise is a mistake worth refusing rather than
        # storing. This is not hypothetical: a break was once timed from the
        # render burst alone and landed in a window where the player was offline
        # and the tiles belonged to somebody else walking past. Ground truth is
        # trusted absolutely downstream, so it is the one place to be strict.
        online = self._roster_at(stamp)
        if online is not None and player not in online:
            return self._json_error(
                HTTPStatus.CONFLICT,
                "%s was not online at %s (roster: %s). Check the time -- renders lag "
                "the event by the render delay, so a burst is later than the act."
                % (player, stamp, ", ".join(online) or "nobody"))

        try:
            CAL_DIR.mkdir(parents=True, exist_ok=True)
            is_new = not CAL_FILE.exists() or CAL_FILE.stat().st_size == 0
            if not is_new:
                with CAL_FILE.open("r", encoding="utf-8", newline="") as f:
                    if sum(1 for _ in f) - 1 >= CAL_MAX_ROWS:
                        return self._json_error(HTTPStatus.INSUFFICIENT_STORAGE,
                                                "calibration file is at its %d row cap" % CAL_MAX_ROWS)
            with CAL_FILE.open("a", encoding="utf-8", newline="") as f:
                w = csv.DictWriter(f, fieldnames=CAL_FIELDS)
                if is_new:
                    w.writeheader()
                w.writerow({"time": stamp, "player": player,
                            "x": coords["x"], "y": coords["y"], "z": coords["z"],
                            "activity": activity, "radius": radius, "note": note})
        except OSError as e:
            return self._json_error(HTTPStatus.INTERNAL_SERVER_ERROR,
                                    "could not write calibration: %s" % e)
        return self._send_json({"ok": True})

    def _send_json(self, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.end_headers()
        self.wfile.write(body)

    def _json_error(self, status, message):
        body = json.dumps({"error": message}).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ---- outside map data -------------------------------------------------

    def api_political(self, rest):
        """Historical political maps from craftix (mccivmap).

        metadata.json reports topLeft {-5504,-5504}, 11008x11008, scale 1 -- one
        pixel per block -- so these overlay the tile grid directly with no
        projection. Only the two small index files come through here; the PNG
        tiles are loaded straight by the page, which needs no CORS for an <img>.
        """
        if rest == "dates":
            return self.remote_json(CRAFTIX + "/elgeis/political/config.js", extract_dates=True)
        parts = rest.split("/")
        if len(parts) != 2 or not DATE_RE.match(parts[0]) or parts[1] not in ("metadata.json", "tile_list.txt"):
            return self._json_error(HTTPStatus.BAD_REQUEST, "expected /api/political/<YYYY-MM-DD>/<metadata.json|tile_list.txt>")
        return self.remote_json("%s/mccivmap/elgeis/political/%s/%s" % (CRAFTIX, parts[0], parts[1]), raw=True)

    def api_nelt(self, rest):
        """The Nelt: the server's nether highway and its public portals.

        Coordinates in these tables are NETHER coordinates, so overworld = x8.
        """
        if rest not in ("map", "lines", "colors"):
            return self._json_error(HTTPStatus.BAD_REQUEST, "expected /api/nelt/<map|lines|colors>")
        return self.remote_json("%s/data/%s.tsv" % (NELT, rest), raw=True)

    def remote_json(self, url, raw=False, extract_dates=False):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "phantom-viewer"})
            with urllib.request.urlopen(req, timeout=15) as r:
                body = r.read()
        except Exception as e:
            return self._json_error(HTTPStatus.BAD_GATEWAY, "could not reach %s: %s" % (url, e))
        ctype = "application/json"
        if extract_dates:
            found = re.findall(rb"'/mccivmap/elgeis/political/(\d{4}-\d{2}-\d{2})'", body)
            body = json.dumps(sorted(set(d.decode() for d in found))).encode("utf-8")
        elif raw:
            ctype = "text/plain; charset=utf-8"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
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
    global ROOT

    ap = argparse.ArgumentParser(description="Serve the tracker folder for the viewer.")
    ap.add_argument("-p", "--port", type=int, default=int(os.environ.get("VIEWER_PORT", "8080")))
    ap.add_argument("--host", default=os.environ.get("VIEWER_HOST", "127.0.0.1"),
                    help="bind address (default 127.0.0.1; use 0.0.0.0 to expose on your LAN)")
    ap.add_argument("--root", default=os.environ.get("VIEWER_ROOT", ""),
                    help="folder to serve as '/' (default: the tracker folder next to this script)")
    ap.add_argument("--no-browser", action="store_true", help="do not open a browser window")
    ap.add_argument("--headless", action="store_true",
                    help="do not serve anything and exit 0; also set by HEADLESS=true")
    args = ap.parse_args()

    # Headless: exit cleanly WITHOUT binding a port. This is how docker-compose
    # turns the viewer off -- the container starts, sees the flag, exits 0, and its
    # on-failure restart policy leaves it stopped. Exiting 0 (not 1) is the point:
    # a non-zero exit would be restarted forever.
    if args.headless or _truthy(os.environ.get("HEADLESS", "")):
        print("[serve] headless: not serving the viewer (set HEADLESS=false to enable it). "
              "The tracker is unaffected.")
        return

    if args.root:
        ROOT = Path(args.root).resolve()

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

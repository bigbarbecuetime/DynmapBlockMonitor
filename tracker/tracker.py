#!/usr/bin/env python3
"""Ultra small Minecraft tracker to get something runnable for now.

Logs two things to a local folder from two sources:

  players.csv    - online player count from the Minecraft server itself (Server List
                   Ping), logged only when it changes. Dynmap can hide players, so this
                   is read straight from the game server instead. Normalized to one row
                   per online player at a given "time" (same count/time repeated per
                   row) rather than one row holding a name list -- simple tools/Excel
                   can filter/pivot on "player" directly with no list-parsing. A
                   snapshot with nobody online is still one row with count=0 and player
                   blank, so it isn't silently dropped.
  chunks.csv     - every changed map tile (chunk) from Dynmap's /up/world feed, as a
                   full tile URL, plus poll errors and start/stop events -- one CSV so
                   it can be opened straight in Excel/Sheets and sorted there. "time" is
                   when we observed the row (poll time for tiles and errors, occurrence
                   time for events). "tile_ts"/"tile_time" is when a tile actually
                   re-rendered on the server (can lag "time" by up to ~10 minutes) --
                   sort by tile_time for real historical ordering of chunk changes.
                   Errors/events deliberately leave tile_time blank: they aren't tile
                   renders, and a tile stamped mid error could still show up later, so
                   folding them into the tile_time ordering would be misleading.
  chunks/        - PNG image of each changed tile (only when SAVE_IMAGES=true, these could get quite large)
"""

import csv
import json
import os
import signal
import socket
import struct
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse


def _env(key, default):
    return os.environ.get(key, default)

# Your server's Dynmap URL, e.g. "http://dynmap.example.com:8123"
DYNMAP_URL  = _env("DYNMAP_URL", "http://your-server:8123").rstrip("/")
# The world name to track, e.g. "world"
WORLD_NAME  = _env("WORLD_NAME", "world")
# Dynmap can provide multiple map types, you can filter to just one, or use "" to log all map types.
MAP_TYPE    = _env("MAP_TYPE", "flat2")
# The actual Minecraft server, queried directly for player count (Dynmap can hide players).
# Defaults to the Dynmap host; set MC_HOST if the game server is on a different address.
MC_HOST     = _env("MC_HOST", "") or (urlparse(DYNMAP_URL).hostname or "your-server")
MC_PORT     = int(_env("MC_PORT", "25565"))
# How often to poll for updates (seconds)
POLL        = float(_env("POLL_INTERVAL", "10"))
# Where to store the logs and images
OUT         = Path(_env("OUT_DIR", "./data"))
# If saving images or not, since they can be large and take a lot of disk space.
SAVE_IMAGES = _env("SAVE_IMAGES", "false").lower() in ("1", "true", "yes", "on")
# How long to wait for a response from the Dynmap server (seconds)
TIMEOUT     = float(_env("HTTP_TIMEOUT", "8"))

# Name of the log files and directories
PLAYERS_LOG = OUT / "players.csv"
CHUNKS_LOG  = OUT / "chunks.csv"
CHUNKS_DIR  = OUT / "chunks"

# chunks.csv columns. tile_time/tile_ts/tile are populated only for tile-change rows;
# event/error rows carry just "time" (when we observed them) and their own column.
CHUNK_FIELDS = ["time", "tile_time", "tile_ts", "tile", "event", "error"]
# players.csv columns. count/player are populated only for snapshot rows (one row per
# online player, or one blank-player row when count is 0); event/error rows carry just
# "time" and their own column.
PLAYERS_FIELDS = ["time", "count", "player", "event", "error"]

def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def tile_time(tile_ts):
    # Dynmap's tile_ts (epoch ms) is when the tile actually re-rendered, which can lag
    # up to ~10 minutes behind the request that surfaced it. Convert it so chunks.csv
    # carries the real change time, not just the poll time we happened to see it at.
    if not isinstance(tile_ts, (int, float)):
        return None
    return datetime.fromtimestamp(tile_ts / 1000.0, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def log(msg):
    print(f"[tracker] {msg}", flush=True)

def append_csv(path, fieldnames, row):
    # CSV (not JSONL) so the logs can be opened straight in Excel/Sheets and sorted
    # there. newline="" is required by the csv module to avoid extra blank rows.
    is_new = not path.exists() or path.stat().st_size == 0
    with path.open("a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        if is_new:
            writer.writeheader()
        writer.writerow(row)

def append_chunk(row):
    append_csv(CHUNKS_LOG, CHUNK_FIELDS, row)

def record_players(count, players):
    # One row per online player, all sharing the same capture time -- normalized so a
    # spreadsheet or simple script never has to parse a name list out of one cell. An
    # empty roster still gets a single row (player blank) so "nobody online" isn't lost.
    t = now()
    for name in players or [""]:
        append_csv(PLAYERS_LOG, PLAYERS_FIELDS, {"time": t, "count": count, "player": name})

def error_reason(e):
    # Collapse an exception into a short, log-friendly reason string.
    if isinstance(e, (TimeoutError, socket.timeout)):
        return "timeout"
    if isinstance(e, urllib.error.URLError):
        if isinstance(e.reason, (TimeoutError, socket.timeout)):
            return "timeout"
        return str(e.reason)
    return str(e) or type(e).__name__

def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "dynmap-tracker"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8"))

def save_chunk_image(url, name, tile_ts):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "dynmap-tracker"})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            data = r.read()
    except Exception as e:
        log(f"image fetch failed {name}: {e}")
        return
    CHUNKS_DIR.mkdir(parents=True, exist_ok=True)
    prefix = tile_ts if tile_ts is not None else int(time.time())
    (CHUNKS_DIR / f"{prefix}_{name.replace('/', '_')}").write_bytes(data)

# ---- Minecraft Server List Ping (status) -- pure stdlib, no plugin needed ----

def _pack_varint(value):
    value &= 0xFFFFFFFF  # encode as unsigned 32-bit (also handles -1 protocol version)
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)

def _recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("server closed the connection")
        buf += chunk
    return buf

def _read_varint(sock):
    num = 0
    for i in range(5):
        byte = _recv_exact(sock, 1)[0]
        num |= (byte & 0x7F) << (7 * i)
        if not byte & 0x80:
            return num
    raise ValueError("VarInt too long")

def ping_players(host, port):
    # The game server reports its player list via Server List Ping even when Dynmap
    # has player display turned off. Returns (online_count, sorted_name_list).
    # Note: the name list is the server's "sample" -- some servers cap or hide it.
    host_bytes = host.encode("utf-8")
    handshake = (_pack_varint(0x00)                       # packet id: handshake
                 + _pack_varint(-1)                       # protocol version (-1 = unspecified)
                 + _pack_varint(len(host_bytes)) + host_bytes
                 + struct.pack(">H", port)
                 + _pack_varint(1))                       # next state: status
    with socket.create_connection((host, port), timeout=TIMEOUT) as s:
        s.settimeout(TIMEOUT)
        s.sendall(_pack_varint(len(handshake)) + handshake)
        request = _pack_varint(0x00)                      # packet id: status request
        s.sendall(_pack_varint(len(request)) + request)
        _read_varint(s)                                   # response length (ignored)
        _read_varint(s)                                   # packet id (0x00)
        raw = _recv_exact(s, _read_varint(s))             # JSON status payload
    players = json.loads(raw.decode("utf-8")).get("players", {})
    names = sorted(e["name"] for e in players.get("sample", []) if e.get("name"))
    return int(players.get("online", 0)), names

def record_event(name):
    # Startup/shutdown markers so on/off periods are visible alongside the data.
    # Only "time" is set -- an event has no count/tile_ts, so the rest stays blank.
    t = now()
    append_csv(PLAYERS_LOG, PLAYERS_FIELDS, {"time": t, "event": name})
    append_csv(CHUNKS_LOG, CHUNK_FIELDS, {"time": t, "event": name})

def last_logged_event(path, fieldnames):
    # Return the last CSV row in a log (reading only its tail), as a dict, or None.
    if not path.exists():
        return None
    try:
        with path.open("rb") as f:
            f.seek(0, os.SEEK_END)
            end = f.tell()
            f.seek(max(0, end - 4096))
            lines = f.read().decode("utf-8", "ignore").splitlines()
        for line in reversed(lines):
            if not line.strip():
                continue
            values = next(csv.reader([line]), None)
            if values and values != fieldnames:  # skip the header if it lands in the tail
                return dict(zip(fieldnames, values))
    except Exception:
        pass
    return None

def warn_if_unclean_shutdown():
    # If the previous run never wrote a "tracker stopped" marker it was killed
    # abruptly flag it so the gap is not mistaken
    # for the tracker being off.
    last = last_logged_event(PLAYERS_LOG, PLAYERS_FIELDS)
    if last is not None and last.get("event") != "tracker stopped":
        record_event("warning! tracker closed without warning, end time unknown")
        log("previous run ended without a stop marker (end time unknown)")

def _stop(*_):
    # SIGTERM (docker stop) -> unwind into the try/finally so shutdown is recorded.
    raise KeyboardInterrupt

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    signal.signal(signal.SIGTERM, _stop)

    # If the previous run never recorded a stop, warn before marking this startup.
    warn_if_unclean_shutdown()

    # Mark startup in both lists so on/off gaps are distinguishable from live data.
    record_event("tracker starting")

    last_ts = 0
    last_players = None
    url_base = f"{DYNMAP_URL}/up/world/{WORLD_NAME}/"

    log(f"dynmap={DYNMAP_URL}  server={MC_HOST}:{MC_PORT}  map_type={MAP_TYPE or '(all)'}")
    log(f"polling every {POLL:g}s -> {OUT.resolve()}  save_images={SAVE_IMAGES}")

    try:
        while True:
            # ---- chunk (map tile) changes from Dynmap ----
            try:
                data = fetch_json(url_base + str(last_ts))

                for u in data.get("updates", []):
                    if u.get("type") != "tile":
                        continue
                    name = u.get("name", "")
                    if MAP_TYPE and not name.startswith(MAP_TYPE + "/"):
                        continue
                    if name.rsplit("/", 1)[-1].startswith("z"):
                        continue  # skip zoomed-out duplicates, keep only native tiles
                    tile_ts = u.get("timestamp")
                    tile_url = f"{DYNMAP_URL}/tiles/{WORLD_NAME}/{name}"
                    append_chunk({
                        "time": now(),
                        "tile_time": tile_time(tile_ts),
                        "tile_ts": tile_ts,
                        "tile": tile_url,
                    })
                    if SAVE_IMAGES:
                        save_chunk_image(tile_url, name, tile_ts)

                last_ts = data.get("timestamp", last_ts)  # advance the poll cursor

            except Exception as e:
                reason = error_reason(e)
                log(f"dynmap poll error: {reason}")
                # Only "time" (when we hit the error) is set -- no tile_ts to convert,
                # and a real tile could still land later with a timestamp inside this
                # gap, so this must not be folded into tile_time ordering.
                append_chunk({"time": now(), "error": reason})

            # ---- player count + list from the Minecraft server itself ----
            try:
                count, players = ping_players(MC_HOST, MC_PORT)
                if (count, players) != last_players:
                    record_players(count, players)
                    last_players = (count, players)
            except Exception as e:
                reason = error_reason(e)
                log(f"player ping error: {reason}")
                append_csv(PLAYERS_LOG, PLAYERS_FIELDS, {"time": now(), "error": reason})

            time.sleep(POLL)

    finally:
        # Mark shutdown in both lists so on/off gaps are distinguishable from live data.
        record_event("tracker stopped")
        log("tracker stopped")


if __name__ == "__main__":
    main()

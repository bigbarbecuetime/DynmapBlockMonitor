#!/usr/bin/env python3
"""Phantom -- a very small Dynmap activity tracker.

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
import zlib
import urllib.request
import urllib.error
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
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
# Diff each render of the overhead map against the copy we hold, to tell an edit
# from ambient growth. Set to a map prefix ("flat2"), or empty to switch off.
# Only the overhead map is worth diffing: its 16 px per block gives a clean 8x8
# grid of block cells, while the isometric maps smear a block across tiles.
DIFF_MAP    = _env("DIFF_MAP", "flat2").strip()
# Ceiling on diffs per poll. A busy minute can queue hundreds of renders and each
# diff costs two PNG decodes; past this we log the render and skip the picture
# rather than let the poll loop fall behind.
DIFF_BUDGET = int(_env("DIFF_BUDGET", "40"))
# How long to wait for a response from the Dynmap server (seconds)
TIMEOUT     = float(_env("HTTP_TIMEOUT", "8"))

# Name of the log files and directories
PLAYERS_LOG = OUT / "players.csv"
CHUNKS_LOG  = OUT / "chunks.csv"
WORLD_LOG   = OUT / "world.csv"
CHANGES_LOG = OUT / "changes.csv"
CHUNKS_DIR  = OUT / "chunks"
# One averaged copy of each tile we have seen, so the next render can be diffed
# against it. Bounded by the number of distinct tiles, not by time: 256 bytes a
# tile, so even 30k tiles is under 8MB.
TILE_CACHE  = OUT / "tilecache"

# chunks.csv columns. tile_time/tile_ts/tile are populated only for tile-change rows;
# event/error rows carry just "time" (when we observed them) and their own column.
CHUNK_FIELDS = ["time", "tile_time", "tile_ts", "tile", "event", "error"]
# players.csv columns. count/player are populated only for snapshot rows (one row per
# online player, or one blank-player row when count is 0); event/error rows carry just
# "time" and their own column.
PLAYERS_FIELDS = ["time", "count", "player", "event", "error"]
# world.csv columns. The update feed carries four fields next to "updates" that we
# were throwing away, and they are the context for why tiles render at all.
#
# Dynmap only re-renders a tile when the rendered image actually CHANGES -- see
# IsoHDPerspective.java, which pushes a client update solely inside
# `if (mtile.matchesHashCode(crc) == false)`. So every logged tile is a real
# visual change, driven by one of the configured render-triggers. The default
# set (configuration.txt) is blockplaced, blockbreak, leavesdecay, blockburn,
# chunkgenerated, blockformed, blockfaded, blockspread, pistonmoved, explosion,
# structuregrow and blockgrow -- note there is NO chunkload trigger, which is
# why terrain a player merely walks over never renders.
#
# Of those, blockformed and blockfaded are snow settling and ice freezing or
# thawing: they fire across every loaded cold chunk while it is raining, and
# stop when it clears. storm/thunder therefore set the ambient render rate, and
# servertime does the same through night-time mob activity. Recording them lets
# the model tell weather-driven noise from a player actually doing something.
#
# dyncount is Dynmap's own player count, which is (real count - hidden players):
# this server hides everyone, so it reads 0 while the game server reports three.
# Differencing it against the SLP count gives the hidden headcount for free.
# confighash changes when the admin edits the map config, which invalidates the
# projection matrices the viewer caches.
WORLD_FIELDS = ["time", "servertime", "storm", "thunder", "dyncount", "confighash"]
# changes.csv columns. One row per diffed render, joined to chunks.csv on
# (tile, tile_ts). "kind" is the shape of the change, not a verdict about who
# caused it -- cells/comps/biggest are kept raw so the classifier can be refitted
# later without re-collecting. Activity means a player is present OR a
# chunkloader is holding the area up; both are worth knowing, and which one it is
# is decided downstream from whether anyone was online, not here.
CHANGES_FIELDS = ["time", "tile_ts", "tile", "kind", "cells", "comps", "biggest", "was", "now"]

# ---- clock alignment ------------------------------------------------------
#
# The two timestamps we write come from two different clocks: "time" from this
# host, "tile_ts" from Dynmap. On the reference host those differed by ~14s --
# and checking Dynmap's HTTP Date header against Google's and Cloudflare's showed
# they all agreed with each other, so it was the TRACKER HOST that was slow (its
# Windows Time service was not running). Every tile therefore looked like it had
# rendered in the future relative to the poll that found it.
#
# Rather than leave the consumer to untangle that, anchor our own clock to the
# Dynmap server's at startup and write everything on that one clock. The Date
# header is free -- it comes back on the polls we already make -- and it is what
# tile_ts is stamped against, which is the whole point.
#
# Resolution is 1 second (HTTP dates have no sub-second field) and we halve the
# round trip, so this is good to about +/-1s: far tighter than the 10s poll and
# the multi-second render lag it exists to make sense of.
CLOCK_SYNC  = _env("CLOCK_SYNC", "true").lower() in ("1", "true", "yes", "on")
# Re-anchor if the host drifts this far from the server afterwards (seconds).
CLOCK_REANCHOR = float(_env("CLOCK_REANCHOR", "3"))

_clock_offset = 0.0       # seconds to add to this host's clock
_offset_samples = []      # recent observations, for drift detection


def measure_clock_offset(feed_url, samples=3):
    """Median offset between the server's clock and this host's.

    Reads the feed's own "timestamp" (epoch ms, the same clock as tile_ts) and
    only falls back to the HTTP Date header, which is whole seconds, if that is
    missing. The request is sandwiched between two local readings so the round
    trip cancels rather than biasing the result.
    """
    seen = []
    for _ in range(samples):
        try:
            t0 = time.time()
            req = urllib.request.Request(feed_url, headers={"User-Agent": "dynmap-tracker"})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                date = r.headers.get("Date")
                body = r.read()
            t1 = time.time()
            served = None
            try:
                ts = json.loads(body.decode("utf-8")).get("timestamp")
                if isinstance(ts, (int, float)):
                    served = ts / 1000.0
            except Exception:
                pass
            if served is None and date:
                served = parsedate_to_datetime(date).timestamp()
            if served is not None:
                seen.append(served - (t0 + t1) / 2.0)
        except Exception:
            pass
    if not seen:
        return None
    seen.sort()
    return seen[len(seen) // 2]


def note_server_time(served):
    """Fold an observation of the server's own clock into the drift watch.

    `served` is epoch SECONDS as the server reckons them. Prefer the feed's
    "timestamp" field over the HTTP Date header: it is milliseconds rather than
    whole seconds, and it is stamped by the same clock as tile_ts, which is the
    one we are actually trying to agree with.
    """
    global _clock_offset
    if not CLOCK_SYNC or served is None:
        return None
    _offset_samples.append(served - time.time() - _clock_offset)
    if len(_offset_samples) > 30:
        _offset_samples.pop(0)
    # Only act on a sustained disagreement, never a single sample: Date is
    # second-resolution, so isolated +/-1s readings are expected noise.
    if len(_offset_samples) < 10:
        return None
    ordered = sorted(_offset_samples)
    drift = ordered[len(ordered) // 2]
    if abs(drift) < CLOCK_REANCHOR:
        return None
    _clock_offset += drift
    _offset_samples.clear()
    return drift


def now():
    # Everything the tracker writes goes through here, so one offset puts the
    # whole log -- players.csv included -- on the same clock as tile_ts.
    return datetime.fromtimestamp(time.time() + _clock_offset, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

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

_world_state = None

def record_world(data):
    """Log the feed's world state, but only when it actually moves.

    servertime is a tick-of-day counter that changes every single poll, so
    logging it raw would write a row every 10s forever. What the model cares
    about is the day/night phase (mobs spawn, and with them the block events
    that drive ambient renders), so quantize to Minecraft's own boundaries --
    13000 ticks is dusk, 23000 is dawn -- and let storm, thunder, the hidden
    headcount and the config hash trigger a row on any change.
    """
    global _world_state
    if "servertime" not in data and "hasStorm" not in data:
        return
    st = data.get("servertime")
    phase = None
    if isinstance(st, (int, float)):
        phase = "night" if 13000 <= st < 23000 else "day"
    key = (phase, bool(data.get("hasStorm")), bool(data.get("isThundering")),
           data.get("currentcount"), data.get("confighash"))
    if key == _world_state:
        return
    _world_state = key
    append_csv(WORLD_LOG, WORLD_FIELDS, {
        "time": now(),
        "servertime": st if st is not None else "",
        "storm": "1" if data.get("hasStorm") else "0",
        "thunder": "1" if data.get("isThundering") else "0",
        "dyncount": data.get("currentcount", ""),
        "confighash": data.get("confighash", ""),
    })

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
        body = json.loads(r.read().decode("utf-8"))
    # The response carries the server's own clock in "timestamp" (epoch ms) -- the
    # very clock tile_ts is stamped against. Use that in preference to anything
    # local, and to the Date header, which only has whole-second resolution.
    served = body.get("timestamp")
    drift = note_server_time(served / 1000.0 if isinstance(served, (int, float)) else None)
    if drift is not None:
        log(f"clock drifted {drift:+.1f}s against the server; re-anchored")
        append_chunk({"time": now(), "event": f"clock re-anchored {drift:+.1f}s"})
    return body

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

# ---- what actually changed in a tile ---------------------------------------
#
# The render-triggers split into two populations that mean completely different
# things for tracking, and the feed cannot tell them apart:
#
#   ambient  leavesdecay, blockspread, blockgrow, structuregrow, blockformed,
#            blockfaded -- growth, decay, snow and ice. These fire anywhere in
#            the loaded region, so they locate the DISC (~256 block radius), not
#            the player. Averaging them is what produces 150 blocks of phantom
#            motion a minute.
#   edit     blockplaced, blockbreak, explosion, pistonmoved -- a player doing
#            something. These locate the PLAYER, to the tile: 8 blocks.
#
# The picture separates them. Dynmap only publishes a tile whose image changed,
# so diffing the new image against the one we already hold shows exactly which
# blocks moved. At flat2's 16 px per block a 128px tile is an 8x8 grid of block
# cells, and the shape of the changed set is the signal:
#
#   one lone cell                  a leaf going, a grass block spreading
#   two or more cells touching     something placed or mined in a run
#   many scattered cells at once   weather settling over the whole tile
#
# We record the shape rather than a verdict. The thresholds below are a first
# reading and want re-fitting once there is labelled data; the raw counts stay
# in the log so that can happen without re-collecting.
BLOCK_PX = 16   # flat2 renders 16 px per block; 128px tile = 8x8 block cells

def _png_cells(data):
    """Decode a PNG into an 8x8 grid of averaged block-cell colours.

    Returns None for anything we cannot read (JPEG maps, truncated fetches).
    Averaging each 16x16 cell rather than keeping every pixel makes the compare
    robust to the map's dithering and keeps the cache small.
    """
    if not data[:8] == b"\x89PNG\r\n\x1a\n":
        return None
    pos, idat, w, h, bd, ct, plte, trns = 8, [], None, None, None, None, None, None
    while pos + 8 <= len(data):
        ln = int.from_bytes(data[pos:pos + 4], "big")
        typ = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + ln]
        if typ == b"IHDR":
            w, h, bd, ct = int.from_bytes(chunk[0:4], "big"), int.from_bytes(chunk[4:8], "big"), chunk[8], chunk[9]
        elif typ == b"IDAT":
            idat.append(chunk)
        elif typ == b"PLTE":
            plte = chunk
        elif typ == b"tRNS":
            trns = chunk
        elif typ == b"IEND":
            break
        pos += 12 + ln
    if not idat or not w or bd != 8:
        return None
    try:
        raw = zlib.decompress(b"".join(idat))
    except Exception:
        return None
    ch = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(ct)
    if not ch:
        return None
    bpp, stride = ch, w * ch
    if len(raw) < (stride + 1) * h:
        return None
    # Undo the per-scanline filters in place; this is the only hot loop here.
    out = bytearray(stride * h)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        f = raw[p]; p += 1
        line = bytearray(raw[p:p + stride]); p += stride
        if f == 1:
            for i in range(bpp, stride): line[i] = (line[i] + line[i - bpp]) & 255
        elif f == 2:
            for i in range(stride): line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                c = prev[i - bpp] if i >= bpp else 0
                b = prev[i]
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        out[y * stride:(y + 1) * stride] = line
        prev = line
    n = max(1, w // BLOCK_PX)
    cells = []
    for cy in range(n):
        for cx in range(n):
            r = g = b = a = cnt = 0
            for y in range(cy * BLOCK_PX, min(h, (cy + 1) * BLOCK_PX)):
                base = y * stride
                for x in range(cx * BLOCK_PX, min(w, (cx + 1) * BLOCK_PX)):
                    if ct == 3:
                        idx = out[base + x]
                        if plte and idx * 3 + 2 < len(plte):
                            r += plte[idx * 3]; g += plte[idx * 3 + 1]; b += plte[idx * 3 + 2]
                        a += trns[idx] if (trns and idx < len(trns)) else 255
                    else:
                        o = base + x * ch
                        r += out[o]; g += out[o + 1] if ch >= 3 else out[o]
                        b += out[o + 2] if ch >= 3 else out[o]
                        a += out[o + ch - 1] if ch in (2, 4) else 255
                    cnt += 1
            cells.append((r // cnt, g // cnt, b // cnt, a // cnt))
    return (n, cells)

def _components(changed, n):
    """Largest touching run, and how many separate runs, among changed cells."""
    seen, comps, biggest = set(), 0, 0
    for start in changed:
        if start in seen:
            continue
        comps += 1
        stack, size = [start], 0
        seen.add(start)
        while stack:
            i = stack.pop(); size += 1
            cx, cy = i % n, i // n
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = cx + dx, cy + dy
                j = ny * n + nx
                if 0 <= nx < n and 0 <= ny < n and j in changed and j not in seen:
                    seen.add(j); stack.append(j)
        biggest = max(biggest, size)
    return comps, biggest

def diff_tile(url, name, tile_ts):
    """Fetch a tile, compare against the copy we hold, and log what moved."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "dynmap-tracker"})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            data = r.read()
    except Exception:
        return
    TILE_CACHE.mkdir(parents=True, exist_ok=True)
    cache = TILE_CACHE / (name.replace("/", "_") + ".bin")
    cur = _png_cells(data)
    if cur is None:
        return
    n, cells = cur
    prev_cells = None
    if cache.exists():
        try:
            blob = cache.read_bytes()
            if len(blob) == n * n * 4:
                prev_cells = [tuple(blob[i:i + 4]) for i in range(0, len(blob), 4)]
        except Exception:
            prev_cells = None
    cache.write_bytes(bytes(v for c in cells for v in c))
    if prev_cells is None:
        # Nothing to compare against yet -- this render still happened, so say so
        # rather than silently dropping it.
        append_csv(CHANGES_LOG, CHANGES_FIELDS, {
            "time": now(), "tile_ts": tile_ts, "tile": url, "kind": "first-sight",
            "cells": "", "comps": "", "biggest": "", "was": "", "now": ""})
        return
    changed = set()
    for i in range(min(len(cells), len(prev_cells))):
        pa, pb = prev_cells[i], cells[i]
        # Dithering makes exact equality too strict; 12/255 per channel is well
        # under the gap between any two distinct Minecraft block colours.
        if abs(pa[0] - pb[0]) + abs(pa[1] - pb[1]) + abs(pa[2] - pb[2]) > 36 or abs(pa[3] - pb[3]) > 64:
            changed.add(i)
    if not changed:
        return
    comps, biggest = _components(changed, n)
    total = n * n
    if len(changed) >= total * 0.5:
        kind = "sweep"          # whole tile redrawn: weather, lighting, a re-render
    elif biggest >= 2 and len(changed) <= 12:
        kind = "run"            # touching cells -- placed or mined together
    elif len(changed) == 1:
        kind = "single"         # one cell: decay, spread, a lone block
    elif comps >= 4 and biggest == 1:
        kind = "scattered"      # many lone cells at once: settling over the tile
    else:
        kind = "patch"
    i0 = sorted(changed)[0]
    append_csv(CHANGES_LOG, CHANGES_FIELDS, {
        "time": now(), "tile_ts": tile_ts, "tile": url, "kind": kind,
        "cells": len(changed), "comps": comps, "biggest": biggest,
        "was": "%02x%02x%02x" % prev_cells[i0][:3], "now": "%02x%02x%02x" % cells[i0][:3],
    })

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

    # Put our clock on the server's before writing anything, so "time" and
    # "tile_ts" in the same row are comparable and the log needs no correction
    # after the fact.
    global _clock_offset
    if CLOCK_SYNC:
        measured = measure_clock_offset(f"{DYNMAP_URL}/up/world/{WORLD_NAME}/0")
        if measured is None:
            log("clock sync: could not read a Date header; using this host's clock as-is")
        else:
            _clock_offset = measured
            log(f"clock sync: this host is {-measured:+.1f}s off the Dynmap server; "
                f"timestamps shifted by {measured:+.1f}s")

    # If the previous run never recorded a stop, warn before marking this startup.
    warn_if_unclean_shutdown()

    # Mark startup in both lists so on/off gaps are distinguishable from live data.
    record_event("tracker starting" + (f" (clock {_clock_offset:+.1f}s)" if CLOCK_SYNC and _clock_offset else ""))

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
                record_world(data)
                diffs_left = DIFF_BUDGET

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
                    if DIFF_MAP and name.startswith(DIFF_MAP + "/") and diffs_left > 0:
                        diffs_left -= 1
                        diff_tile(tile_url, name, tile_ts)

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

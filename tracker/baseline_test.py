#!/usr/bin/env python3
"""Baseline labeled-data harness for single-occupancy position tracking tests.

Run this while you are the ONLY player online. It does two things at once:

  1. Streams every changed flat2 *native* (8x8-block) tile from Dynmap's
     /up/world feed into tiles.csv -- the raw activity signal.
  2. Lets you type your true in-game position (read off F3) at the console;
     each entry is timestamped and written to labels.csv -- the ground truth.

Later we align the two on time to (a) calibrate the tile<->world transform and
(b) test whether your movement actually lights up nearby tiles. Because nobody
else is on, essentially every non-background tile render is caused by you.

Enter positions as:
    x z            e.g.  -250 70
    x y z          e.g.  -250 64 70
    x y z  note    e.g.  -250 64 70 standing on the oak
Commands:
    m <note>       timestamped note, no coords (e.g.  m started mining)
    q / quit       stop and flush

Config comes from env or a .env next to this script (same keys the tracker uses):
    DYNMAP_URL, WORLD_NAME, MAP_TYPE (default flat2), OUT_DIR (default ./data)
    MC_HOST/MC_PORT  -> solo-guard: warns if >1 player is online. Defaults to the
                        Dynmap host on 25565, so the guard is on unless the server
                        uses a non-standard port -- in which case it says so at
                        startup rather than staying quietly disabled.
    BASELINE_POLL    -> feed poll interval in seconds (default 2)
"""

import csv
import json
import os
import socket
import struct
import sys
import threading
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
import urllib.request


# ---- config -------------------------------------------------------------

def load_dotenv():
    # Minimal .env loader so `python baseline_test.py` picks up the real
    # addresses without overriding anything already set in the environment.
    envf = Path(__file__).with_name(".env")
    if not envf.exists():
        return
    for line in envf.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        os.environ.setdefault(key.strip(), val.strip())

load_dotenv()

def _env(key, default):
    return os.environ.get(key, default)

DYNMAP_URL = _env("DYNMAP_URL", "http://your-server:8123").rstrip("/")
WORLD_NAME = _env("WORLD_NAME", "world")
MAP_TYPE   = _env("MAP_TYPE", "flat2")
MC_HOST    = _env("MC_HOST", "") or (urlparse(DYNMAP_URL).hostname or "")
MC_PORT    = int(_env("MC_PORT", "25565") or 25565)
POLL       = float(_env("BASELINE_POLL", "2"))
TIMEOUT    = float(_env("HTTP_TIMEOUT", "8"))

SESSION = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
OUT     = Path(_env("OUT_DIR", "./data")) / "baseline" / SESSION
TILES_LOG  = OUT / "tiles.csv"
LABELS_LOG = OUT / "labels.csv"

TILE_FIELDS  = ["wall_time", "tile_time", "tile_ts", "tilex", "tilez", "tile_url"]
LABEL_FIELDS = ["label_time", "label_ts", "x", "y", "z", "note"]

# Shared state between the poll thread and the input thread.
stop_evt   = threading.Event()
recent     = deque(maxlen=400)   # (observed_epoch_s, tilex, tilez) for live feedback
recent_lk  = threading.Lock()
solo_warned = False


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def ms_to_iso(ms):
    if not isinstance(ms, (int, float)):
        return ""
    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def append_csv(path, fields, row):
    is_new = not path.exists() or path.stat().st_size == 0
    with path.open("a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        if is_new:
            w.writeheader()
        w.writerow(row)

def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "baseline-test"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8"))


# ---- Server List Ping: optional solo-guard ------------------------------

def _pack_varint(v):
    v &= 0xFFFFFFFF
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        out.append(b | 0x80 if v else b)
        if not v:
            return bytes(out)

def _recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("closed")
        buf += chunk
    return buf

def _read_varint(sock):
    num = 0
    for i in range(5):
        b = _recv_exact(sock, 1)[0]
        num |= (b & 0x7F) << (7 * i)
        if not b & 0x80:
            return num
    raise ValueError("VarInt too long")

def online_count():
    hb = MC_HOST.encode("utf-8")
    handshake = (_pack_varint(0x00) + _pack_varint(-1)
                 + _pack_varint(len(hb)) + hb + struct.pack(">H", MC_PORT)
                 + _pack_varint(1))
    with socket.create_connection((MC_HOST, MC_PORT), timeout=TIMEOUT) as s:
        s.settimeout(TIMEOUT)
        s.sendall(_pack_varint(len(handshake)) + handshake)
        req = _pack_varint(0x00)
        s.sendall(_pack_varint(len(req)) + req)
        _read_varint(s); _read_varint(s)
        raw = _recv_exact(s, _read_varint(s))
    return int(json.loads(raw.decode("utf-8")).get("players", {}).get("online", 0))


# ---- background: stream native flat2 tile changes -----------------------

def poll_loop():
    global solo_warned
    last_ts = 0
    next_solo = 0.0
    prefix = MAP_TYPE + "/"
    while not stop_evt.is_set():
        try:
            data = fetch_json(f"{DYNMAP_URL}/up/world/{WORLD_NAME}/{last_ts}")
            wall = now_iso()
            for u in data.get("updates", []):
                if u.get("type") != "tile":
                    continue
                name = u.get("name", "")
                if not name.startswith(prefix):
                    continue
                leaf = name.rsplit("/", 1)[-1]
                if leaf.startswith("z"):
                    continue  # zoomed-out LOD duplicate; keep only native 8x8 tiles
                try:
                    tx, tz = (int(p) for p in leaf[:-4].split("_"))
                except ValueError:
                    continue
                ts = u.get("timestamp")
                append_csv(TILES_LOG, TILE_FIELDS, {
                    "wall_time": wall,
                    "tile_time": ms_to_iso(ts),
                    "tile_ts": ts,
                    "tilex": tx,
                    "tilez": tz,
                    "tile_url": f"{DYNMAP_URL}/tiles/{WORLD_NAME}/{MAP_TYPE}/{tx}_{tz}.png",
                })
                with recent_lk:
                    recent.append((time.time(), tx, tz))  # keyed on observation time
            last_ts = data.get("timestamp", last_ts)  # lossless cursor advance
        except Exception as e:
            print(f"\n[poll] error: {e}", flush=True)

        # optional solo-guard: warn once when someone else appears
        if MC_HOST and MC_PORT and time.time() >= next_solo:
            next_solo = time.time() + 15
            try:
                n = online_count()
                if n > 1 and not solo_warned:
                    solo_warned = True
                    print(f"\n[warn] {n} players online -- labels may be contaminated!", flush=True)
                elif n <= 1:
                    solo_warned = False
            except Exception:
                pass

        stop_evt.wait(POLL)


def recent_summary(lookback=25):
    # Tiles that surfaced in the feed within the last `lookback` seconds
    # (keyed on when we observed them, not tile render ts, which can lag).
    cutoff = time.time() - lookback
    with recent_lk:
        hits = [(obs, tx, tz) for (obs, tx, tz) in recent if obs >= cutoff]
    if not hits:
        return "  (no flat2 tiles changed in the last %ds)" % lookback
    counts = {}
    for ts, tx, tz in hits:
        counts[(tx, tz)] = counts.get((tx, tz), 0) + 1
    parts = ", ".join(f"({tx},{tz})x{c}" if c > 1 else f"({tx},{tz})"
                      for (tx, tz), c in sorted(counts.items(), key=lambda kv: -kv[1]))
    return f"  {len(hits)} changes over {len(counts)} tiles (last {lookback}s): {parts}"


# ---- foreground: read labels from stdin ---------------------------------

def parse_label(line):
    # "x z" | "x y z" | "x y z note...".  Returns (x, y, z, note) or None.
    toks = line.split()
    nums, note_start = [], len(toks)
    for i, t in enumerate(toks):
        try:
            nums.append(float(t))
        except ValueError:
            note_start = i
            break
    if len(nums) < 2:
        return None
    note = " ".join(toks[note_start:])
    if len(nums) == 2:
        return nums[0], "", nums[1], note        # x z
    return nums[0], nums[1], nums[2], note        # x y z (+extra nums fold into note-less)


def main():
    if DYNMAP_URL.startswith("http://your-server"):
        print("Set DYNMAP_URL/WORLD_NAME (env or tracker/.env) before running.")
        sys.exit(1)

    OUT.mkdir(parents=True, exist_ok=True)
    print(f"baseline test -> {OUT.resolve()}")
    print(f"dynmap={DYNMAP_URL} world={WORLD_NAME} map={MAP_TYPE} poll={POLL:g}s")
    if MC_HOST and MC_PORT:
        try:
            print(f"solo-guard: {online_count()} player(s) online now ({MC_HOST}:{MC_PORT})")
        except Exception as e:
            print(f"solo-guard: SLP check failed ({e}) -- continuing without it")
    print("Type 'x z' or 'x y z [note]' to log a position, 'm <note>' for a note, 'q' to quit.\n")

    t = threading.Thread(target=poll_loop, daemon=True)
    t.start()

    try:
        while True:
            try:
                line = input("pos> ").strip()
            except EOFError:
                break
            if not line:
                continue
            low = line.lower()
            if low in ("q", "quit", "exit"):
                break
            if low.startswith("m ") or low == "m":
                note = line[1:].strip()
                append_csv(LABELS_LOG, LABEL_FIELDS,
                           {"label_time": now_iso(), "label_ts": int(time.time() * 1000), "note": note})
                print(f"  noted @ {now_iso()}")
                continue
            parsed = parse_label(line)
            if not parsed:
                print("  ? expected 'x z' or 'x y z [note]'")
                continue
            x, y, z, note = parsed
            append_csv(LABELS_LOG, LABEL_FIELDS, {
                "label_time": now_iso(), "label_ts": int(time.time() * 1000),
                "x": x, "y": y, "z": z, "note": note,
            })
            print(f"  logged x={x} y={y} z={z} @ {now_iso()}")
            print(recent_summary())
    except KeyboardInterrupt:
        pass
    finally:
        stop_evt.set()
        t.join(timeout=POLL + 2)
        # count what we captured
        n_tiles = max(0, sum(1 for _ in TILES_LOG.open()) - 1) if TILES_LOG.exists() else 0
        n_labels = max(0, sum(1 for _ in LABELS_LOG.open()) - 1) if LABELS_LOG.exists() else 0
        print(f"\nstopped. {n_labels} labels, {n_tiles} tile changes -> {OUT.resolve()}")


if __name__ == "__main__":
    main()

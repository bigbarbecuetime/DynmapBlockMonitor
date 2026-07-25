# Tracker viewer

A static page that reads the tracker's `chunks.csv` and `players.csv` and shows
**which map tiles changed, when, and who was online at the time**. No build step,
no dependencies — plain HTML/CSS/JS plus one optional stdlib Python server.

```bash
python viewer/serve.py
```

Opens <http://127.0.0.1:8080/viewer/>. You can also open `index.html` straight
from disk and drag the two CSVs onto the page, but live follow needs HTTP.

### With Docker

`docker compose up -d` from the `tracker` folder runs the viewer next to the
tracker out of the same image, at <http://127.0.0.1:8080/viewer/>. The data
directory is mounted read-only — the viewer never writes.

| Variable | Default | Effect |
|---|---|---|
| `HEADLESS` | `false` | `true` runs the tracker only; `serve.py` exits 0 without binding a port and, because the service restarts `on-failure`, stays stopped |
| `VIEWER_PORT` | `8080` | Host port |
| `VIEWER_BIND` | `127.0.0.1` | Loopback by default: there is no authentication and the CSVs contain player names. `0.0.0.0` exposes it to your LAN |

---

## What it shows

**Map stage** — a pan/zoom grid of Dynmap tiles in world coordinates.

- **Heat** colours each tile by how much it changed, **Tiles** draws the actual
  tile art, **Both** overlays them.
- Heat can measure the change count in the window, a decaying recency, or just
  how recently each tile last changed.
- Tile art prefers a **saved snapshot** from the run (`data/chunks/`, written when
  the tracker runs with `SAVE_IMAGES=true`) so a replay shows the map as it looked
  *then*. With no snapshot it falls back to the server's **current** tile and says
  so, rather than quietly mixing the two.

**Timeline** — tile changes and player count as two stacked bands sharing one
time axis, over an overview strip of the whole file. Tracker-off periods are
hatched (absent data, not a quiet server) and poll outages are marked.

**Panels** — the roster and count at the cursor, a join/leave feed, every polled
sample as a table, the tile/player correlation, the busiest tiles, and a data
quality report.

**Timestamps** are shown in your own timezone, date first, 12-hour
(`Jul 24, 3:44:39 PM`). **Click any of them** to switch the whole UI to the exact
UTC string the CSV stores (`2026-07-24T03:44:39Z`) — useful when matching a row
in the file — and click again to switch back. The choice persists.

**World border and markers** come from Dynmap's own marker layer, drawn in the
server's colours. Note the border is usually larger than the logged area, so
"Fit all" frames the tiles, not the border — zoom out to see it.

## Playback

| | |
|---|---|
| <kbd>&larr;</kbd> <kbd>&rarr;</kbd> | step to the previous / next logged data point |
| <kbd>Shift</kbd> + <kbd>&larr;&rarr;</kbd> | step 25 at a time |
| <kbd>Alt</kbd> + <kbd>&larr;&rarr;</kbd> | step player joins / leaves only |
| <kbd>Space</kbd> | play / pause |
| <kbd>&uarr;</kbd> <kbd>&darr;</kbd> | faster / slower |
| <kbd>R</kbd> | reverse direction |
| <kbd>Home</kbd> <kbd>End</kbd> | window start / end |
| <kbd>[</kbd> <kbd>]</kbd> | set window start / end to the cursor |
| <kbd>L</kbd> <kbd>H</kbd> <kbd>0</kbd> | live · heat mode · fit map |

Speed is in **data seconds per real second** (1× to 3600×, forwards or
backwards) — the only unit that means anything for a file spanning a day.
Fast-forwarding off the end of a window that reaches the newest data **hands over
to live mode** rather than looping, which is usually why you were fast-forwarding.
Playing to the end of a deliberately earlier window still loops or stops.

**Live mode** follows the CSVs as the tracker appends to them, using HTTP Range
requests so each poll transfers the newly appended bytes rather than re-reading a
file that is already ~1 MB after a day. A row caught half-written is held back
until its newline arrives; a truncated or rotated file forces a clean re-read.

---

## The part that matters: two clocks

This is the whole reason the viewer exists rather than a spreadsheet.

`chunks.csv` carries two timestamps per tile, **and they are on different
clocks**:

- `time` — the tracker host's clock, when we polled and saw the tile.
- `tile_ts` / `tile_time` — the **Dynmap server's** clock, when the tile actually
  re-rendered.

`players.csv` is entirely on the host clock. On the reference server Dynmap's
clock runs **~17 s ahead**, so 99.9 % of tiles look like they rendered *in the
future* relative to the poll that found them. Plot both columns naively and
player activity and tile activity are offset by that much — and the ordering
across the two sources is simply wrong.

A tile can only be observed *after* it renders, so on a common clock
`capture − render ≥ 0` always. However negative that gets on the raw numbers is
the clock offset, and the least-delayed tile in the file pins it:

```
skew = −min(capture − tile_ts)
```

The viewer estimates that, shifts every tile onto the host clock, and shows you
the check: after correction the reference data has **no** negative lag, with a
median render lag of 7 s and a max of 25 s — consistent with a 10 s poll. You can
override the offset or switch to raw times under **Time base & correlation**.

Everything — the heatmap, the timeline histogram, the attribution — uses the
corrected tile time, never the capture time.

## Errors it will tell you about

`players.csv` is a **step function**, not a sample series: rows are written only
when the value changes, so a value holds until the next row. Joins and leaves are
derived by diffing adjacent snapshots, and anything that makes that diff a lie is
marked uncertain rather than presented as fact:

- **Tracker off** between samples (from the start/stop/unclean-shutdown markers).
- **Ping errored** between samples — player state is a point sample, so an
  errored ping can hide a whole join/leave.
- **Sample capped** — Server List Ping returns only a *sample* of names, so a
  roster can be incomplete while the count stays right.
- **Roster contradicts the count** — the server listing more names than its own
  count admits. This happens on ~15 % of samples in the reference data, right at
  disconnects, and it manufactures phantom leaves if you trust it.

For tile data, a poll outage only loses data if it outlasts the feed's ~28 s
retention buffer, because `tracker.py` does not advance its cursor on a failed
poll. Outage length is counted as **consecutive failed polls** — it cannot be read
off the gaps between logged tiles, since a poll that succeeds with nothing changed
writes no row at all.

## Tiles are not chunks

Despite the filename, `chunks.csv` logs Dynmap **tiles**. From the server's own
`/up/configuration` and the Dynmap source (`webbukkit/dynmap`):

- `HDMap.getTileSize()` returns `128 << tilescale`, and `flat2` has `tilescale=0`
  → a native tile image is **128 px**.
- `flat2`'s `worldtomap` scale is **16 px per block** → **8 blocks per tile**.
- So a 16×16 Minecraft chunk is a **2×2 group of four tiles**.
- `worldtomap` maps `mapX = 16·x`, `mapY = −16·z`, so tile Y is inverted against
  world Z and **higher tile Y is further north**.
- Tile paths are `{world}/{prefix}/{x>>5}_{y>>5}/{x}_{y}.png`
  (`FileTreeMapStorage`), with zoomed levels prefixed `z_`, `zz_` — which is what
  `tracker.py` filters out to keep only native tiles.

A tile named `256_600.png` therefore covers world X `2048…2055`, Z `−4808…−4801`.
The **Blocks per tile** setting is there if your map uses a different scale.

Tile numbers are only unique *within* one map type. If the tracker ran with
`MAP_TYPE=""` it logs every type, and `flat2/8_18/256_600.png` and
`t/8_18/256_600.png` are different projections of different places that happen to
share a coordinate. The viewer therefore plots **one map type at a time** — it
defaults to whichever has the most rows, shows a **Map type** picker, and says so
in the quality report. Merging them would multiply-count every change and paint
neighbouring cells from different projections.

## Files

| | |
|---|---|
| `index.html` | layout |
| `css/viewer.css` | theme tokens; both light and dark are explicit |
| `js/csv.js` | CSV parse + the byte-range tailer |
| `js/model.js` | **the interesting one** — clock skew, coverage, error windows, joins/leaves, coordinates |
| `js/tiles.js` | map stage: pan/zoom, tile images, heatmap |
| `js/timeline.js` | timeline bands + the playback clock |
| `js/panels.js` | read-out panels |
| `js/app.js` | wiring, loading, live mode, keyboard |
| `serve.py` | static server with Range support and `/api/images` |

`serve.py` adds three things over any static server, all of which degrade
gracefully if absent:

- **Range requests**, so live mode tails only the appended bytes.
- **`GET /api/images`** — lists the saved tile snapshots in `data/chunks/`, since
  plain HTTP offers no directory listing and historical tile art can't otherwise
  be found.
- **`GET /api/markers?world=…`** — proxies Dynmap's marker layer. That endpoint
  sends no `Access-Control-Allow-Origin`, so the page cannot fetch it
  cross-origin itself (tile *images* are fine — `<img>` needs no CORS). The host
  comes from `DYNMAP_URL` (env, or the tracker's `.env`), never from the request,
  and the world name is pattern-checked, so this cannot be used as an open relay.

`window.DV.app` is exposed in the console for poking at the model.

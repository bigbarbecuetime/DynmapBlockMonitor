# Phantom — viewer

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

## Beyond plotting

**Tracks** are a checkbox, not a view mode, so they overlay whichever map you are
looking at. Their points are stored in WORLD coordinates and projected through
the active map's matrix, so the same track draws correctly on the flat map and
on a skewed isometric one. A leg is
labelled by its measured speed, cut at the game's own numbers: `stationary`
(<1 b/s), `walking` (<5, the game's walk is 4.3), `sprinting` (<8), `horse/boat`
(<15), `fast` (<80, ice boat or elytra), and above that nothing on foot can
explain it. A gap in loading is `unobserved` — we did not see how they got
there — never a straight line drawn across the map.

**Events** are the jumps between tracks, not legs inside them: the linker refuses
to join two points further apart than a player could travel, so a teleport ends
one track and starts the next. Each is checked against the nether's 8:1 (a 7,771
block jump in 60s is 971 nether blocks at 16 b/s — an ice boat) and against the
Nelt's public portals. Drawn **dashed** when accounted for, **dotted** when not,
so an unexplained hop never reads as a route.

**Layers.** Historical political maps come from craftix (339 snapshots,
2018-09-08 to 2026-07-20), which publish at one pixel per block with
`topLeft {-5504,-5504}` — the same frame as the world border — so they underlay
the tile grid with no projection at all. The pyramid is small (484 tiles at lod0
down to **4** at lod4, where 2×2 covers the whole 11008-block world), so the
overlay draws at every zoom, stepping up a level as you zoom out rather than
switching off — between 4 and 15 tiles on screen at any zoom. Note lod0 is
published as `.png` and every zoomed-out level as `.jpg`; the extension is taken
from `tile_list.txt` rather than assumed. It follows the cursor: the snapshot shown is the
latest one taken on or before the moment you are looking at, so scrubbing back
through the log moves the borders with it.

The Nelt's 244 public portals and 61 highway segments overlay on top; those
tables are in **nether** coordinates, so overworld position is ×8. A portal is
only *named* in an event when the player was within **16 blocks** of it and our
position estimate is itself good to 16 blocks — which, with a load-disc radius
of ~86 blocks, currently almost never holds. At the 256 blocks this first used,
92 events got a portal name; at 16, none do. Those attributions were coincidence,
and confirming portal use needs better positional precision than chunk loads
alone can give.

**Isometric map types** are drawn through their own projection, not flattened:
the world grid and the markers go through that map's `worldtomap`, so the world
border comes out as the rotated diamond Dynmap shows rather than a square, and
the block-numbered ruler is replaced by the projected world grid (screen axes are
not world axes once the view is skewed).

**Player tracks** link chunk loads into paths. Dynmap redraws a chunk when it is
loaded, which is what happens as someone walks into new terrain, so loads are the
movement signal — and the load/edit split above separates them from building.
**Tile times are shifted back by the render-queue delay.** `tile_ts` is when
Dynmap *finished redrawing* a tile, not when the chunk loaded — its queue runs
over a minute deep on this server, so uncorrected, every track drags past the
session that caused it and tracks appear in windows with nobody online. The
delay is estimated as the backward shift that leaves the fewest tiles
attributable to nobody (~60–80s here). On the calibration session that moves the
first tile from join +51s to −29s and the last from leave +84s to +4s, with 98%
of the session's tiles falling inside the session.

Each player keeps **one colour across all their tracks**, so separate visits to
the same place are legible as the same person; unattributed tracks share a muted
slot. Click a track for its details and events, and filter to one player by name.

**A re-render does not mean a block changed.** Tiles were diffed live as they
re-rendered and every one came back byte-identical — same picture, new
timestamp. The trigger is a block changing anywhere in a chunk that happens to
be *loaded*, and under a forest canopy the top-down map sees leaves either way.
Loading is player-driven; changing is mob- and terrain-driven. So renders pile
up wherever tickable terrain sits inside the loaded disc and stop dead where it
does not.

That is why the position estimate is the **centre of the extent** the renders
cover, not their centre of mass. A calibration session (standing at a known
spot, then a 52-block sprint, then a 64-block walk) sat beside a dark-oak forest
to the north; the open stone the player actually stood on has not re-rendered
since January. Averaging the renders walks the estimate into the forest —
102/112/143 blocks off the three known positions — while the extent centre gives
63/64/101, landing X within 2 blocks twice. Trimming the extent to 5–95% is
worse (106), because the extreme points are exactly what pin the disc edge.

The residual is nearly all Z, from the south half of the disc being clipped by
ground too barren to ever report. Adding the disc radius to the northern edge
scores 2 and 4 blocks on two legs — but that edge is a **fixed landmark**, not a
disc boundary: the player moved 54 blocks between two legs and it moved 8, and
across 13 independent windows over three days it varies by only 96 blocks. It is
the treeline. Fitting to it would encode this one location into every track, so
it is deliberately not used.

Movements smaller than the combined position error (~85 blocks) are **below the
noise floor** and are reported as `stationary` rather than invented as walking.
Tracks are built from 60-second slices because the same session showed
20-second estimates hopping 100–200 blocks between disc fragments (phantom
"sprinting" for a standing player) while 60-second ones wander only 12–36.

A loaded tile is **not** the player's position. Measured over 42.9h of
single-player stretches, the tiles loading in any 30s window sit a median 10.8
tiles (86 blocks, ~5.4 chunks) from the centre of the group — a view-distance
disc around the player — and one 8×8 tile stands in for its whole 16×16 chunk
(793 chunks contributed one tile; only 12 contributed all four). So a track is
the chain of per-slice **position estimates**, not of individual tiles. That
matters: tile linking hops across the disc and inflated speed to 3.8–8.5
blocks/s, while per-slice estimates give 2.2 median / 3.3 p90 — matching the 2.2
measured directly from the solo stretches.

Attribution has two tiers. A track whose every moment had exactly one player
online is **confidently** theirs. Otherwise, a track that starts within a few
minutes of exactly one join is tagged with that joiner — measured on the
calibration session, loads first appeared 51s and 73s after the two joins — with
each join spawning at most one track, the name checked against the roster, and
the result marked uncertain.

Linking is by proximity in space and time, never by the order tiles arrive: tiles
come off the feed sorted by ascending x (perfectly ascending in **92%** of polls
*within a single second*, where time cannot explain it), so emission order
measures Dynmap's render loop, not player heading.

The check is the roster: the number of live tracks should match the number of
people online. It agrees exactly **55%** of the time (59% at a 30s slice), mean error 0.75
players, and errs low — a player standing still loads nothing and is invisible
here.

**Height** comes from crossing the maps. A flat tile fixes X and Z but not Y; the
isometric maps are shot at inclination 30, folding height into their vertical
axis. With `worldtomap` from `/up/configuration`:

```
mapY = -5.6569·x + 13.8564·y - 5.6569·z      →  y is the only unknown
```

The grid draws both units at once: the fine lines are the 8×8 **tile** Dynmap
publishes, the heavier ones every second line are the 16×16 **chunk** the game
actually loads (chunk boundaries fall on even tile coordinates). Zoomed out the
tile grid drops away and the chunk grid stays.

Pairing a flat tile with an isometric tile changed at the same moment pins Y to
about **16 blocks** — verified against spawn, whose published height (88) lands
inside the recovered band [77.7, 93.5]. Needs `MAP_TYPE=` (empty) so the
isometric maps are logged too. Bands outside the world's build range are dropped
rather than reported, since a coincidence in time is not proof of the same event.

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

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

Live is a **clock, not a bookmark**. The tracker writes nothing when a poll finds
nothing changed, so the newest row can be an hour behind the present — this server
went 90 minutes with a player online and not one tile rendered. The cursor
therefore tracks *now*, not the last row: pressing Live jumps to the present and
stays there, and each poll moves the leading edge even when no bytes arrived. The
status pill says `nothing new for 1h 4m` instead of quoting a stale row as if it
were current, and the open run's coverage extends with the edge so the present
does not read as "tracker not running" (a run with a `stopped` marker is never
extended; if the tracker died in the silence, its next start writes `closed
without warning` and retro-closes the run at its last real row).

Dragging the cursor to the leading edge — or past it, which clamps — means
*follow*; anywhere else parks it, so inspecting an outage from an hour ago is
never yanked forward by an append. <kbd>End</kbd> re-pins to the edge.

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

**So does coverage.** The start/stop markers are host-clock facts about the
tracker *process*, but a tile is drawn at `render − queue delay`, which is
earlier than the poll that found it. Compare the two directly and a run's own
first tiles land before its own start marker: the viewer drew them as bars on top
of its "tracker not running" hatch and called them changes outside any run. The
observation window really does open before the marker — Dynmap's since-feed hands
the first poll its whole ~28 s buffer, and the chunk load behind a render happened
a render-delay earlier — so each run is extended back by
`retention + render delay` (~84 s here) before anything is asked whether it was
recorded. Runs whose lookbacks overlap merge, which is what this log's 2–4 s
restart pairs physically were.

The rule that falls out of it: **nothing claims a moment was unrecorded while
showing data from it.** "Tracker not running" is only said about a span that is
unrecorded end to end; a timeline bucket, correlation window, or map window that
was watched for part of its length says how much of it was off instead.

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
- **A placeholder instead of a name** — this server answered once with
  `Anonymous Player`, which cannot be a username (Mojang allows 3–16 characters
  of `[A-Za-z0-9_]`). Someone was online under it, so the head-count keeps them
  and the roster does not: a placeholder that collects sessions would eventually
  be handed a track that a real person walked.

**A name is evidence; the count is not.** If the server named an account, that
account was connected — it has no reason to invent one. A count is the side that
can be made to understate: a vanish plugin drops the hidden player from it, and
this server already hides everyone from Dynmap's own `currentcount`. So the
roster is a **floor** under the head-count (`snapshot.online = max(count, named)`)
and never a competitor to it. In the reference data the count comes up short 61
times, always by exactly one and never for longer than a single poll. Reading only
the count column called those moments empty, handed the tiles rendered in them to
nobody, and produced feed rows like `leave 0→0` — a departure from a server that
claimed to be empty. That accounted for 61 of the 62 uncertain transitions; 19
remain, all from a tracker restart, a failed ping, or a withheld name.

The **?** on a join or leave is about the *server's answer*, never about our
polling. We ask every 10 s and the poll either works or is logged as an error;
the `?` means the two snapshots either side of that transition could not be
diffed honestly — the tracker restarted in between, the ping errored, the sample
was capped, or a name was withheld. 19 of 515 transitions in the reference data
carry one. Hover it for the specific reason.

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

**Calibration** records ground truth: "at this instant this player was exactly
here". The instant always comes from the cursor, never a typed timestamp — you
scrub to the moment you remember. The position can be typed from F3 or picked
off the map with **Pick X/Z**, which arms the next click (Escape or a second
press disarms; the map shows a crosshair while armed). A pick is only as good as
the zoom, so the blocks-per-pixel is measured at the moment of the click and
reported next to the button — 4 blocks zoomed in, 20 at the zoom floor, which is
still well inside the model's own ~100-block error. **Y is never filled in**: an
overhead tile is a top-down projection, a change at y=8 and one at y=200 land on
the same pixel, and writing a plausible 64 would put a fabricated number into
the one file everything downstream trusts.

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

**A render means the map image changed, and nothing else.** Dynmap pushes a
client update only inside `if (mtile.matchesHashCode(crc) == false)`
(`IsoHDPerspective.java`), so an unchanged re-render is never announced. What
triggers one is a configured render-trigger; the default set in
`configuration.txt` is blockplaced, blockbreak, leavesdecay, blockburn,
chunkgenerated, blockformed, blockfaded, blockspread, pistonmoved, explosion,
structuregrow and blockgrow. **There is no chunkload trigger** — `playermove`
and `playerjoin` exist but ship commented out — which is why terrain a player
merely walks over never renders.

Block events only fire in loaded chunks, so a player's contribution is to hold
chunks loaded; what changes inside them is mob- and terrain-driven. Renders
therefore pile up wherever something growing or decaying sits inside the loaded
disc, and stop dead where nothing does.

That is why the position estimate is the **centre of the extent** the renders
cover, not their centre of mass. A calibration session (standing at a known
spot, then a 52-block sprint, then a 64-block walk) sat beside a dark-oak forest
to the north, where `structuregrow`, `blockgrow` and `leavesdecay` keep altering
the canopy the flat map looks straight down on; the open stone the player
actually stood on grows nothing and has not re-rendered since January. Averaging the renders walks the estimate into the forest —
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

**The path only moves when it can be shown to have moved.** A slice's estimate
is the centre of whatever rendered in that minute, which is a sparse, lopsided
sample of an 86-block disc — and half of all slices carry one or two renders.
A single render was being reported as a 12-block fix when the tile it came from
sits a median 86 blocks from the player, so two overconfident single-tile
estimates 200 blocks apart cleared the noise floor and got drawn as walking.
The error floor is now the disc radius shrunk by √n. On top of that, a step
smaller than the combined error of its endpoints is not a step (hold position
and average the estimates, which are independent draws), and **a move must
stick**: someone who went 400 blocks is still 400 blocks away a minute later,
so if the next estimate falls back toward where they were, the excursion was a
stray render and not a leg. Raw estimates survive on `rx`/`rz`.

Together these cut tracks travelling more than 4× their own extent from **20%
to 1%** and median track travel from 788 to 341 blocks, with the ground-truth
error unchanged at ~92 blocks mean.

**A chunk loader reads as a player standing still, and that is now left
standing.** A loader, a farm someone left running, or spawn chunks keep a patch
of world loaded with nobody near it, and it renders forever from a fixed spot —
locally indistinguishable from a stationary player, because a render says a
chunk was loaded and never says what loaded it.

There was a pass here that tried to tell the two apart from the roster: if a
60-second slice held more separated places (>512 blocks apart) than the server
had people, the surplus was not people, and the surplus was taken to be whichever
place was re-drawing ground it already had. It is **removed**. Every gate added
to make it safe — renders per chunk, a minimum vote count, a 60% loss rate,
per-visit episodes rather than per-site verdicts — was tuning the odds of a coin
toss rather than deciding it, and the failure mode was not a graceful one: when
it called a player's base a machine it deleted that person's real movement from
the record, turning a visit into a dashed ring nobody could argue with. A wrong
track is visible; a deleted one is not.

So held ground is gone from the model, the map and the track list, and with it
the **stasis-chamber detector**, which was built entirely on top of it — a parked
pearl is an entity in a loaded chunk, so every chamber in use was already in the
held-site list. That inference was only ever as good as the held-site list, and
the held-site list was a guess. Jumps that used to be labelled `stasis` are now
reported as the unexplained jumps they are. The attribution geometry loses its
matching exemption too: arriving faster than 80 blocks/s is refused outright,
which refuses a few genuine pearl pulls along with everything else.

What this costs, measured on the 7-day log (2026-07-23 to 07-30): tracks that
travel more than 4× their own extent sit at **15 of 628 (2.4%)** — the path
settling below is what holds that down, not the loader pass — and the ground
truth is unchanged at **18 of 20 records placed, median 125 blocks**, the same
figure the loader pass scored.

Attribution is by **elimination, worked backwards over the finished window**.
Candidates are the players online for the *whole* span a track covers (compared
against each player's online interval, not the roster attached to each point —
a slice midpoint routinely lands seconds before the join it belongs to). Then,
in rounds to a fixed point:

1. a single remaining candidate is assigned, and confidently;
2. a track that stops right at someone's leave, or starts right after their
   join, when only one candidate matches that edge;
3. a player who could only have made one unclaimed track gets it.

Every assignment removes that name from every track overlapping it in time —
one person is in one place — which is what lets a busy evening resolve inward
from whoever left first.

Every rule also has to answer for the geometry, because two overlapping tracks
compete for the same names and whichever is assigned first takes one out of play
for the other: arriving faster than **80 blocks/s** is refused. This is a real
speed limit and it is known to be slightly wrong — a pearl parked in a stasis
chamber crosses any distance instantly, so some of what it refuses is ordinary
play. The exemption that used to cover it (arriving on ground the loader pass
called *held* was allowed at any speed) went with that pass, because it rested
on a classification that was never established. The calibration case is
unaffected: nothing puts a player in the middle of the pale-oak forest ninety
seconds after they were 11,000 blocks away.

Linking is by proximity in space and time, **never by the order tiles arrive**.
The feed is strictly sorted by render-completion time: across 27,812 polls
(243,426 tiles), the `tile_ts` of consecutive rows within a poll increases 96.3%
of the time, ties 3.7%, and *never* decreases — every batch of four or more
tiles is perfectly monotone. Nothing in that ordering carries who joined when.

The left-to-right sweep visible on the map is Dynmap's renderer draining its
dirty-tile set column-major, not a player heading east. Within a burst (four or
more consecutive tiles inside 4 tiles of each other, n=9,061 bursts) the order is
**97.0% monotone in x** and 95.2% monotone in (x, z); adjacent steps run east
9.85:1 over west, and whole bursts end east of where they started 4,525 times
against 45 west. Two players online simply interleave two such sweeps by
whichever tile finished rendering first.

The check is the roster: the number of live tracks should match the number of
people online. It agrees exactly **52%** of the time over the whole log (86% over
the 2026-07-27 morning), errs low, and overcounts only **1%** of the time — a
player standing still loads nothing and is invisible here, which is the failure
worth having. `node tools/tracks.js [from] [to]` prints the tracks and this
score; `STEADY=0` turns the path settling off for a before/after on one dataset.

**Tracks are always built from the whole log**, in the tools and in the viewer
alike, and the time window only chooses what is shown. This is not a
performance detail: attribution resolves by elimination across every track in
the build, and a track is only a track because of what came before and after
it. Building inside
a window did not show a slice of the answer, it computed a different one — the
same evening named fewer players through a narrower window, and every track was
cut at the window edge with its ends reading as arrivals and departures that
never happened.

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

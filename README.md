# Dynmap Block Monitor

Tools for tracking a Minecraft server through its [Dynmap](https://github.com/webbukkit/dynmap).
Currently two versions depending on your need:

- **Tracker** *(Quickstart below)* An ultra small Python poller that logs online player
  count and every chunk (map tile) change to a local folder.
- **Block Monitor** *([Unfinished WIP](#wip-edition--block-monitor-web-app))* A full web app that
  watches specific block coordinates and sends Discord alerts. Still work in progress.

---

## Quickstart: Tracker

Runs from a prebuilt image on GitHub Container Registry. It logs two sources to a local `./data` folder:

- `players.csv` Online player count from the Minecraft server directly (Server List Ping),
  logged only when it changes. Dynmap can hide players, so this is read from the game server
  instead of Dynmap. One row per online player (same time/count repeated per row) rather than
  a name list, so it opens cleanly in Excel/Sheets; a snapshot with nobody online is still one
  row with count 0.
- `chunks.csv` Every changed map tile from Dynmap, as a full tile URL. Includes both
  `time` (when we polled and saw it) and `tile_time` (when the tile actually re-rendered on the
  server, converted from Dynmap's `tile_ts`). Sort by
  `tile_time` for the real order changes happened in. Only native (full-detailed 8x8 block) tiles are
  logged; Dynmap's zoomed-out duplicates are skipped.
- `chunks/` PNG of each changed tile, only if `SAVE_IMAGES=true` (off by default)

### Run with Docker

(Make sure docker is on your system first, for windows download and start [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/#advanced-system-configuration-and-installation-options))

Make an empty folder and drop in two new files:

`docker-compose.yml`
```yaml
name: dynmap-tracker

services:
  tracker:
    image: ghcr.io/bigbarbecuetime/dynmap-tracker:latest
    container_name: dynmap-tracker
    restart: unless-stopped
    env_file: .env
    volumes:
      - ./data:/data
```

`.env` (fill in your server; full option list in the table below)
```
DYNMAP_URL=http://your-server:8123
WORLD_NAME=world
MAP_TYPE=flat2
MC_HOST=your-server
MC_PORT=25565
```

Then open a terminal and start it with the following command:
```bash
docker compose up -d
```

Logs land in `./data`. Update later with `docker compose pull && docker compose up -d`.

### Run without Docker

It is a single standard-library file (Python 3.8+), so there is nothing to install:
```bash
DYNMAP_URL=http://your-server:8123 WORLD_NAME=world MC_HOST=your-server MC_PORT=25565 python tracker.py
```

### Configuration

Set in `.env` (see [`tracker/.env.example`](tracker/.env.example)) or as environment variables:

| Variable        | Default                            | Description                                     |
| --------------- | ---------------------------------- | ----------------------------------------------- |
| `DYNMAP_URL`    | `http://your-server:8123`          | Base URL of the target server's Dynmap          |
| `WORLD_NAME`    | `world`                            | Dynmap world name                               |
| `MAP_TYPE`      | `flat2`                            | Map/tile type to track (empty = every map)      |
| `MC_HOST`       | (the Dynmap host)                  | Minecraft server address for player count       |
| `MC_PORT`       | `25565`                            | Minecraft server port                           |
| `POLL_INTERVAL` | `10`                               | Seconds between polls                           |
| `OUT_DIR`       | `./data` (`/data` in Docker)       | Output folder                                   |
| `SAVE_IMAGES`   | `false`                            | Also download a PNG of each changed tile        |
| `HTTP_TIMEOUT`  | `8`                                | Per request timeout (seconds)                   |

Find `WORLD_NAME` and `MAP_TYPE` from the Dynmap in a browser, or `{DYNMAP_URL}/up/configuration`.
`MC_HOST`/`MC_PORT` are the Minecraft server's real host and port. Many servers hide a
non-standard port behind an SRV record, so the joinable name alone isn't enough: look up
`_minecraft._tcp.<host>` (e.g. `nslookup -type=SRV _minecraft._tcp.mc.examplename.com`) to get the
actual port. The tracker does not resolve SRV records itself.

### Local development

Edit
[`tracker/tracker.py`](tracker/tracker.py) and run it directly (plain Python reads its config
from shell env vars, not `.env`):

```bash
cd tracker
DYNMAP_URL=http://your-server:8123 WORLD_NAME=world MC_HOST=your-server MC_PORT=25565 python tracker.py
```

To test the Docker image built from your local code instead of pulling from GHCR, uncomment
`build: .` in [`tracker/docker-compose.yml`](tracker/docker-compose.yml), then:

```bash
cd tracker
cp .env.example .env    # then fill it in
docker compose up --build
```

### Phantom viewer

The CSVs open in Excel/Sheets, but **Phantom** ([`tracker/viewer/`](tracker/viewer/README.md)) is a
dependency-free static page that plots them properly. `docker compose up -d` serves it
alongside the tracker at <http://127.0.0.1:8080/viewer/> — same image, no extra build.

To run the tracker without it, set `HEADLESS=true` (in `.env`, or for one run):

```bash
HEADLESS=true docker compose up -d
```

The viewer container then exits cleanly and stays stopped; the tracker is unaffected.
It binds to loopback only, because it has no authentication and the CSVs contain player
names — set `VIEWER_BIND=0.0.0.0` (and `VIEWER_PORT`) to reach it from your LAN.

Without Docker, run it directly from the `tracker` folder:

```bash
python viewer/serve.py
```

A pan/zoom map of which tiles changed (heatmap or real tile art), the player count and
join/leave feed on a shared timeline, arrow-key stepping through individual data points,
replay at 1x-3600x forwards or backwards, and a live mode that follows the CSVs as the
tracker appends to them. Desktop and mobile layouts.

Its main job is to make the two sources comparable: tile timestamps come from **Dynmap's**
clock and player timestamps from the **tracker host's**, and on the reference server those
are ~17 s apart, so plotting both raw columns misaligns them and mis-orders events across
sources. The viewer estimates the offset, corrects it, and flags the things that can make
the picture lie — tracker downtime, poll outages that outlasted the feed's retention
buffer, capped player-name samples, and snapshots whose roster contradicts their own count.
See its [README](tracker/viewer/README.md) for the details.

---

## WIP Block Monitor

> Work in progress. Watches Minecraft block coordinates via Dynmap and sends Discord alerts
> when tracked areas change. Node/Express + SQLite backend, React + Tailwind frontend, served
> together as a single container.

### Quick start (Docker)

```bash
docker compose up --build
```

The client is built inside the image (multi-stage Dockerfile), so you do not need to run
`npm run build:client` first (but ofc can). Once it's up, open http://localhost:3000.

Data (SQLite DB + alert images) persists to the `./data` directory via a bind mount.

### Configuration

Settings are passed as environment variables in [`docker-compose.yml`](docker-compose.yml):

| Variable                 | Default                              | Description                                        |
| ------------------------ | ------------------------------------ | -------------------------------------------------- |
| `DYNMAP_URL`             | `http://your-server:8123`            | Base URL of the target server's Dynmap             |
| `WORLD_NAME`             | `world`                              | Dynmap world name                                  |
| `MAP_TYPE`               | `flat2`                              | Dynmap map/tile type                               |
| `POLL_INTERVAL`          | `10000`                              | Poll interval (ms)                                 |
| `DB_PATH`                | `/app/data/monitor.db`               | SQLite database path                               |
| `ALERTS_DIR`             | `/app/data/alerts`                   | Directory for saved alert images                   |
| `OFFLINE_THRESHOLD`      | `300000`                             | Mark a POI offline after this long without data (ms) |
| `RESCAN_COOLDOWN`        | `60000`                              | Minimum time between rescans of the same tile (ms) |
| `MAX_CONCURRENT_FETCHES` | `3`                                  | Max simultaneous Dynmap tile fetches               |

Discord webhook URLs and monitored coordinates are managed from the web UI and stored in the DB.

### Local development

Runs the Express server and the Vite dev server together with hot reload:

```bash
npm install
npm run install:client
npm run dev
```

- Server: http://localhost:3000
- Client (Vite, with API proxy): http://localhost:5173

To produce a production build locally without Docker:

```bash
npm run build:client
npm start
```

### Project layout

```
tracker/         Tiny standalone Python poller (player count + chunk changes)
tracker/viewer/  Phantom: static page for exploring the CSVs (map, timeline, replay)
server/          Express API, Dynmap poller, change detector, Discord alerter, SQLite
client/          React + Tailwind + Vite frontend
data/            Persisted SQLite DB and alert images (gitignored)
Dockerfile       Multi-stage build (client build -> runtime image)
docker-compose.yml
```

### Missing Features
- Player tracking
- Ability to globally save all chunk changes across the map if desired.
- Free selection zones vs single point tracking.
- Additional dynmap metadata.
- Explore additional sources of data/plugin support.

### Proposed Additions
- Automatic correlation of players with probable chunk interaction
- Detection of wide scale destruction and assignment of players

---

Both the Tracker and the Block Monitor follow [Semantic Versioning](https://semver.org/).

Licensed under CC BY 4.0 ([https://creativecommons.org/licenses/by/4.0/deed.en](https://creativecommons.org/licenses/by/4.0/deed.en)).

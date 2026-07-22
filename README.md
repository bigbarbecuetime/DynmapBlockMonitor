# Dynmap Block Monitor

Tools for tracking a Minecraft server through its [Dynmap](https://github.com/webbukkit/dynmap).
Currently two versions depending on your need:

- **Tracker** *(Quickstart below)* An ultra small Python poller that logs online player
  count and every chunk (map tile) change to a local folder.
- **Block Monitor** *([Unfinished WIP](#wip-edition--block-monitor-web-app))* A full web app that
  watches specific block coordinates and sends Discord alerts. Still work in progress.

---

## Quickstart: Tracker

Polls two sources and writes to a local `./data` folder:

- `players.jsonl` Online player count from the Minecraft server directly (Server List Ping),
  one line each time it changes. Dynmap can hide players, so the count is read from the game
  server instead of Dynmap.
- `chunks.jsonl` Every changed map tile (chunk) from Dynmap, as a full tile URL with a timestamp
- `chunks/` PNG of each changed tile, only if `SAVE_IMAGES=true` (off by default)

**Docker** (edit the env in [`tracker/docker-compose.yml`](tracker/docker-compose.yml) first):

```bash
cd tracker
docker compose up --build
```

**Python** (Python 3.8+, no dependencies to install):

```bash
cd tracker
DYNMAP_URL=http://your-server:8123 WORLD_NAME=world MAP_TYPE=flat python tracker.py
```

Point `DYNMAP_URL`, `WORLD_NAME`, and `MAP_TYPE` at your target server. Images are off by
default to keep storage tiny, set `SAVE_IMAGES=true` if you want the actual tile pictures.

Set via environment variables (see [`tracker/docker-compose.yml`](tracker/docker-compose.yml)):

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

Licensed under CC BY 4.0 ([https://creativecommons.org/licenses/by/4.0/deed.en](https://creativecommons.org/licenses/by/4.0/deed.en)).

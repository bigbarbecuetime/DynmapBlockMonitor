# Dynmap Block Monitor

Watches Minecraft block coordinates via a server's [Dynmap](https://github.com/webbukkit/dynmap)
and sends Discord alerts when tracked areas change. Node/Express + SQLite backend, React + Tailwind
frontend, served together as a single container.

## Quick start (Docker)

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
| `DYNMAP_URL`             | `http://dynmap.elgeis.com:10102`     | Base URL of the target server's Dynmap             |
| `WORLD_NAME`             | `8302018`                            | Dynmap world name                                  |
| `MAP_TYPE`               | `flat2`                              | Dynmap map/tile type                               |
| `POLL_INTERVAL`          | `10000`                              | Poll interval (ms)                                 |
| `DB_PATH`                | `/app/data/monitor.db`               | SQLite database path                               |
| `ALERTS_DIR`             | `/app/data/alerts`                   | Directory for saved alert images                   |
| `OFFLINE_THRESHOLD`      | `300000`                             | Mark a POI offline after this long without data (ms) |
| `RESCAN_COOLDOWN`        | `60000`                              | Minimum time between rescans of the same tile (ms) |
| `MAX_CONCURRENT_FETCHES` | `3`                                  | Max simultaneous Dynmap tile fetches               |

Discord webhook URLs and monitored coordinates are managed from the web UI and stored in the DB.

## Local development

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

## Project layout

```
server/          Express API, Dynmap poller, change detector, Discord alerter, SQLite
client/          React + Tailwind + Vite frontend
data/            Persisted SQLite DB and alert images (gitignored)
Dockerfile       Multi-stage build (client build -> runtime image)
docker-compose.yml
```



Licensed under CC BY 4.0 ([https://creativecommons.org/licenses/by/4.0/deed.en](https://creativecommons.org/licenses/by/4.0/deed.en)).

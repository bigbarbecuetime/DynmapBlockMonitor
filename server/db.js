'use strict';

const Database = require('better-sqlite3');
const { computeTileKeyForBlock } = require('./coordinator');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/monitor.db');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db);
  }
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      webhook_url TEXT NOT NULL,
      msg_title   TEXT NOT NULL DEFAULT '⚠️ Block Change: {poi_name}',
      msg_body    TEXT NOT NULL DEFAULT '{poi_name} at ({x}, {z}) in **{group_name}** changed from {old_color} → {new_color}',
      msg_mention TEXT NOT NULL DEFAULT '',
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pois (
      id          INTEGER PRIMARY KEY,
      group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      x           INTEGER NOT NULL,
      z           INTEGER NOT NULL,
      tile_key    TEXT NOT NULL,
      pixel_x     INTEGER NOT NULL,
      pixel_z     INTEGER NOT NULL,
      baseline_r  INTEGER,
      baseline_g  INTEGER,
      baseline_b  INTEGER,
      tolerance   INTEGER NOT NULL DEFAULT 0,
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_pois_tile_key ON pois(tile_key);
    CREATE INDEX IF NOT EXISTS idx_pois_group_id ON pois(group_id);

    CREATE TABLE IF NOT EXISTS alerts (
      id          INTEGER PRIMARY KEY,
      poi_id      INTEGER REFERENCES pois(id) ON DELETE SET NULL,
      old_r       INTEGER,
      old_g       INTEGER,
      old_b       INTEGER,
      new_r       INTEGER,
      new_g       INTEGER,
      new_b       INTEGER,
      image_path  TEXT,
      alerted_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_alerts_poi_id ON alerts(poi_id);
    CREATE INDEX IF NOT EXISTS idx_alerts_alerted_at ON alerts(alerted_at);

    CREATE TABLE IF NOT EXISTS system_state (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

// ── Groups ──────────────────────────────────────────────────────────────────

function getAllGroups() {
  const db = getDb();
  return db.prepare(`
    SELECT g.*,
           COUNT(p.id) AS poi_count,
           SUM(CASE WHEN p.active = 1 THEN 1 ELSE 0 END) AS active_poi_count
    FROM groups g
    LEFT JOIN pois p ON p.group_id = g.id
    GROUP BY g.id
    ORDER BY g.name
  `).all();
}

function getGroup(id) {
  return getDb().prepare('SELECT * FROM groups WHERE id = ?').get(id);
}

function createGroup(data) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO groups (name, webhook_url, msg_title, msg_body, msg_mention)
    VALUES (@name, @webhook_url, @msg_title, @msg_body, @msg_mention)
  `);
  const result = stmt.run({
    name: data.name,
    webhook_url: data.webhook_url,
    msg_title: data.msg_title ?? '⚠️ Block Change: {poi_name}',
    msg_body: data.msg_body ?? '{poi_name} at ({x}, {z}) in **{group_name}** changed from {old_color} → {new_color}',
    msg_mention: data.msg_mention ?? '',
  });
  return getGroup(result.lastInsertRowid);
}

function updateGroup(id, data) {
  const db = getDb();
  const fields = [];
  const values = {};
  for (const [k, v] of Object.entries(data)) {
    if (['name', 'webhook_url', 'msg_title', 'msg_body', 'msg_mention'].includes(k)) {
      fields.push(`${k} = @${k}`);
      values[k] = v;
    }
  }
  if (!fields.length) return getGroup(id);
  values.id = id;
  db.prepare(`UPDATE groups SET ${fields.join(', ')} WHERE id = @id`).run(values);
  return getGroup(id);
}

function deleteGroup(id) {
  return getDb().prepare('DELETE FROM groups WHERE id = ?').run(id);
}

// ── POIs ─────────────────────────────────────────────────────────────────────

function getPoisForGroup(groupId) {
  return getDb().prepare('SELECT * FROM pois WHERE group_id = ? ORDER BY name').all(groupId);
}

function getAllActivePois() {
  return getDb().prepare('SELECT * FROM pois WHERE active = 1 AND baseline_r IS NOT NULL').all();
}

function getPoi(id) {
  return getDb().prepare('SELECT * FROM pois WHERE id = ?').get(id);
}

function createPoi(groupId, data) {
  const { tileKey, pixelX, pixelZ } = computeTileCoords(data.x, data.z);
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO pois (group_id, name, x, z, tile_key, pixel_x, pixel_z, tolerance, active)
    VALUES (@group_id, @name, @x, @z, @tile_key, @pixel_x, @pixel_z, @tolerance, @active)
  `).run({
    group_id: groupId,
    name: data.name,
    x: data.x,
    z: data.z,
    tile_key: tileKey,
    pixel_x: pixelX,
    pixel_z: pixelZ,
    tolerance: data.tolerance ?? 0,
    active: data.active !== undefined ? (data.active ? 1 : 0) : 1,
  });
  return getPoi(result.lastInsertRowid);
}

function updatePoi(id, data) {
  const db = getDb();
  const poi = getPoi(id);
  if (!poi) return null;

  const newX = data.x !== undefined ? data.x : poi.x;
  const newZ = data.z !== undefined ? data.z : poi.z;
  const { tileKey, pixelX, pixelZ } = computeTileCoords(newX, newZ);

  db.prepare(`
    UPDATE pois SET
      name = @name,
      x = @x,
      z = @z,
      tile_key = @tile_key,
      pixel_x = @pixel_x,
      pixel_z = @pixel_z,
      baseline_r = @baseline_r,
      baseline_g = @baseline_g,
      baseline_b = @baseline_b,
      tolerance = @tolerance,
      active = @active
    WHERE id = @id
  `).run({
    id,
    name: data.name ?? poi.name,
    x: newX,
    z: newZ,
    tile_key: tileKey,
    pixel_x: pixelX,
    pixel_z: pixelZ,
    baseline_r: data.baseline_r !== undefined ? data.baseline_r : poi.baseline_r,
    baseline_g: data.baseline_g !== undefined ? data.baseline_g : poi.baseline_g,
    baseline_b: data.baseline_b !== undefined ? data.baseline_b : poi.baseline_b,
    tolerance: data.tolerance !== undefined ? data.tolerance : poi.tolerance,
    active: data.active !== undefined ? (data.active ? 1 : 0) : poi.active,
  });
  return getPoi(id);
}

function setPoiBaseline(id, r, g, b) {
  getDb().prepare(
    'UPDATE pois SET baseline_r = ?, baseline_g = ?, baseline_b = ? WHERE id = ?'
  ).run(r, g, b, id);
  return getPoi(id);
}

function deletePoi(id) {
  return getDb().prepare('DELETE FROM pois WHERE id = ?').run(id);
}

// ── Alerts ───────────────────────────────────────────────────────────────────

function createAlert(data) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO alerts (poi_id, old_r, old_g, old_b, new_r, new_g, new_b, image_path)
    VALUES (@poi_id, @old_r, @old_g, @old_b, @new_r, @new_g, @new_b, @image_path)
  `).run(data);
  return getAlert(result.lastInsertRowid);
}

function getAlert(id) {
  return getDb().prepare('SELECT * FROM alerts WHERE id = ?').get(id);
}

function getAlerts({ groupId, poiId, since, limit = 100, offset = 0 } = {}) {
  const db = getDb();
  const conditions = [];
  const params = {};

  if (groupId) { conditions.push('p.group_id = @groupId'); params.groupId = groupId; }
  if (poiId)   { conditions.push('a.poi_id = @poiId');     params.poiId = poiId; }
  if (since)   { conditions.push('a.alerted_at >= @since'); params.since = since; }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.limit = limit;
  params.offset = offset;

  return db.prepare(`
    SELECT a.*, p.name AS poi_name, p.x, p.z, g.name AS group_name
    FROM alerts a
    LEFT JOIN pois p ON p.id = a.poi_id
    LEFT JOIN groups g ON g.id = p.group_id
    ${where}
    ORDER BY a.alerted_at DESC
    LIMIT @limit OFFSET @offset
  `).all(params);
}

function getAlertCount({ groupId, poiId, since } = {}) {
  const db = getDb();
  const conditions = [];
  const params = {};

  if (groupId) { conditions.push('p.group_id = @groupId'); params.groupId = groupId; }
  if (poiId)    { conditions.push('a.poi_id = @poiId');     params.poiId = poiId; }
  if (since)   { conditions.push('a.alerted_at >= @since'); params.since = since; }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  return db.prepare(`
    SELECT COUNT(*) AS count FROM alerts a
    LEFT JOIN pois p ON p.id = a.poi_id
    ${where}
  `).get(params).count;
}

// ── System state ─────────────────────────────────────────────────────────────

function getState(key) {
  const row = getDb().prepare('SELECT value FROM system_state WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setState(key, value) {
  getDb().prepare(`
    INSERT INTO system_state (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, String(value));
}

// ── Settings ─────────────────────────────────────────────────────────────────

const SETTINGS_DEFAULTS = {
  dynmap_url: process.env.DYNMAP_URL || 'http://dynmap.elgeis.com:10102',
  world_name: process.env.WORLD_NAME || '8302018',
  map_type: process.env.MAP_TYPE || 'flat2',
  poll_interval: process.env.POLL_INTERVAL || '10000',
  offline_threshold: process.env.OFFLINE_THRESHOLD || '300000',
  rescan_cooldown: process.env.RESCAN_COOLDOWN || '60000',
};

function getSettings() {
  const settings = { ...SETTINGS_DEFAULTS };
  for (const key of Object.keys(SETTINGS_DEFAULTS)) {
    const val = getState(`setting:${key}`);
    if (val !== null) settings[key] = val;
  }
  return settings;
}

function updateSettings(updates) {
  for (const [key, value] of Object.entries(updates)) {
    if (key in SETTINGS_DEFAULTS) setState(`setting:${key}`, value);
  }
  return getSettings();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function computeTileCoords(x, z) {
  const ZOOM = "zzzz";
  const TILE_BLOCKS = 128; // 8 * 2^4
  const tileKey = computeTileKeyForBlock(x, z, ZOOM);
  // pixelX: block offset within tile along X (floor division remainder)
  const pixelX = ((x % TILE_BLOCKS) + TILE_BLOCKS) % TILE_BLOCKS;
  // pixelZ: Dynmap Z-axis is inverted — pixel 0 is the highest game-Z in the tile.
  // At zzzz zoom the tile's top-left game-Z is (tileStart + 119), decreasing downward.
  const pixelZ = (((119 - z) % TILE_BLOCKS) + TILE_BLOCKS) % TILE_BLOCKS;
  return { tileKey, pixelX, pixelZ };
}

module.exports = {
  getDb,
  // Groups
  getAllGroups, getGroup, createGroup, updateGroup, deleteGroup,
  // POIs
  getPoisForGroup, getAllActivePois, getPoi, createPoi, updatePoi,
  setPoiBaseline, deletePoi,
  // Alerts
  createAlert, getAlert, getAlerts, getAlertCount,
  // State
  getState, setState,
  // Settings
  getSettings, updateSettings,
  // Helpers
  computeTileCoords,
};

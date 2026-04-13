'use strict';

const { getAllActivePois, getSettings, getState, setState, getGroup, createAlert } = require('./db');
const { TileCoordinator, parseTileName } = require('./coordinator');
const { detectChangesInTile } = require('./detector');
const { fireAlert } = require('./alerter');

// Shared coordinator instance (also exported so routes can mutate it)
const coordinator = new TileCoordinator();

// Poller state
let running = false;
let pollTimer = null;
let lastTimestamp = 0;
let lastPollTime = null;
let lastError = null;
let consecutiveErrors = 0;

// Recent-alert cooldown: Map<poiId, timestamp>
const recentAlerts = new Map();

function getCooldown(settings) {
  return parseInt(settings.rescan_cooldown, 10) || 60_000;
}

function getOfflineThreshold(settings) {
  return parseInt(settings.offline_threshold, 10) || 300_000;
}

/** Start the polling loop. Call once on server startup. */
async function startPoller() {
  if (running) return;
  running = true;
  console.log('[poller] Starting...');

  // Rebuild coordinator index from active POIs
  const pois = getAllActivePois();
  coordinator.rebuild(pois);

  // Restore last timestamp from database
  const storedTs = getState('last_timestamp');
  lastTimestamp = storedTs ? parseInt(storedTs, 10) : 0;
  console.log(`[poller] Resuming from timestamp ${lastTimestamp}`);

  // Check for offline gap
  const storedPollTime = getState('last_poll_time');
  if (storedPollTime) {
    const gap = Date.now() - parseInt(storedPollTime, 10);
    const settings = getSettings();
    if (gap > getOfflineThreshold(settings)) {
      console.log(`[poller] Offline gap detected (${Math.round(gap / 1000)}s). Triggering full rescan.`);
      await fullRescan(settings);
    }
  }

  schedulePoll();
}

function stopPoller() {
  running = false;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

function schedulePoll() {
  if (!running) return;
  const settings = getSettings();
  const interval = parseInt(settings.poll_interval, 10) || 10_000;
  pollTimer = setTimeout(pollOnce, interval);
}

async function pollOnce() {
  const settings = getSettings();
  try {
    const url = `${settings.dynmap_url}/up/world/${settings.world_name}/${lastTimestamp}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });

    if (!res.ok) throw new Error(`Update endpoint returned ${res.status}`);

    const json = await res.json();

    // Update timestamp
    if (json.timestamp) {
      lastTimestamp = json.timestamp;
      setState('last_timestamp', lastTimestamp);
    }

    lastPollTime = Date.now();
    setState('last_poll_time', lastPollTime);
    lastError = null;
    consecutiveErrors = 0;

    // Extract zzzz_ tile names for our map type
    const updates = json.updates || [];
    const changedTileKeys = new Set();

    for (const update of updates) {
      if (update.type !== 'tile') continue;
      const parsed = parseTileName(update.name);
      if (!parsed) continue;
      if (parsed.mapType !== settings.map_type) continue;
      if (parsed.zoom !== 'zzzz') continue;
      changedTileKeys.add(parsed.tileKey);
    }

    if (changedTileKeys.size === 0) {
      schedulePoll();
      return;
    }

    // Cross-reference with coordinator
    const matches = coordinator.matchTiles(changedTileKeys);
    if (matches.size === 0) {
      schedulePoll();
      return;
    }

    console.log(`[poller] ${matches.size} relevant tile(s) changed, checking POIs...`);
    await processTileMatches(matches, settings);

  } catch (err) {
    lastError = err.message;
    consecutiveErrors++;
    console.error(`[poller] Poll error (${consecutiveErrors}): ${err.message}`);
  }

  schedulePoll();
}

/**
 * Process a Map<tileKey, poi[]> with limited concurrency.
 */
async function processTileMatches(matches, settings) {
  const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_FETCHES, 10) || 3;
  const entries = Array.from(matches.entries());

  // Process in chunks
  for (let i = 0; i < entries.length; i += MAX_CONCURRENT) {
    const chunk = entries.slice(i, i + MAX_CONCURRENT);
    await Promise.all(chunk.map(([tileKey, pois]) =>
      processChangedPois(tileKey, pois, settings)
    ));
  }
}

async function processChangedPois(tileKey, pois, settings) {
  const changes = await detectChangesInTile(tileKey, pois, settings);
  const cooldown = getCooldown(settings);

  for (const { poi, current } of changes) {
    // Cooldown check
    const lastAlert = recentAlerts.get(poi.id);
    if (lastAlert && Date.now() - lastAlert < cooldown) {
      console.log(`[poller] POI ${poi.id} (${poi.name}) suppressed by cooldown`);
      continue;
    }

    recentAlerts.set(poi.id, Date.now());
    const oldColor = { r: poi.baseline_r, g: poi.baseline_g, b: poi.baseline_b };
    await triggerAlert(poi, oldColor, current, settings);
  }
}

async function triggerAlert(poi, oldColor, newColor, settings) {
  const group = getGroup(poi.group_id);
  if (!group) return;

  console.log(`[poller] ALERT: POI "${poi.name}" (${poi.x},${poi.z}) changed`);

  const imagePath = await fireAlert(group, poi, oldColor, newColor, settings);

  createAlert({
    poi_id:     poi.id,
    old_r:      oldColor.r,
    old_g:      oldColor.g,
    old_b:      oldColor.b,
    new_r:      newColor.r,
    new_g:      newColor.g,
    new_b:      newColor.b,
    image_path: imagePath,
  });
}

/**
 * Full rescan: fetch the zzzz_ tile for every watched tile and compare all POIs.
 * Used on startup after an offline gap.
 */
async function fullRescan(settings) {
  const tileKeys = coordinator.getAllTileKeys();
  console.log(`[poller] Full rescan: checking ${tileKeys.length} tiles...`);

  const summaries = new Map(); // groupId → [poiName, ...]

  const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_FETCHES, 10) || 3;
  for (let i = 0; i < tileKeys.length; i += MAX_CONCURRENT) {
    const chunk = tileKeys.slice(i, i + MAX_CONCURRENT);
    const allPois = getAllActivePois();
    const tilePoiMap = new Map();
    for (const key of chunk) {
      const pois = allPois.filter(p => p.tile_key === key);
      if (pois.length) tilePoiMap.set(key, pois);
    }

    await Promise.all(Array.from(tilePoiMap.entries()).map(async ([tileKey, pois]) => {
      const changes = await detectChangesInTile(tileKey, pois, settings);
      const cooldown = getCooldown(settings);

      for (const { poi, current } of changes) {
        const lastAlert = recentAlerts.get(poi.id);
        if (lastAlert && Date.now() - lastAlert < cooldown) continue;

        recentAlerts.set(poi.id, Date.now());

        const oldColor = { r: poi.baseline_r, g: poi.baseline_g, b: poi.baseline_b };
        const imagePath = await fireAlert(getGroup(poi.group_id), poi, oldColor, current, settings);

        createAlert({ poi_id: poi.id, old_r: oldColor.r, old_g: oldColor.g, old_b: oldColor.b,
                       new_r: current.r, new_g: current.g, new_b: current.b, image_path: imagePath });

        const list = summaries.get(poi.group_id) || [];
        list.push(poi.name);
        summaries.set(poi.group_id, list);
      }
    }));
  }

  const total = Array.from(summaries.values()).reduce((s, a) => s + a.length, 0);
  console.log(`[poller] Full rescan complete. ${total} changes detected.`);
}

/** Expose poller status for the /api/status endpoint. */
function getStatus() {
  return {
    running,
    lastPollTime,
    lastError,
    consecutiveErrors,
    lastTimestamp,
    watchedTiles: coordinator.tileCount,
    watchedPois:  coordinator.poiCount,
  };
}

/** Rebuild the coordinator index (call after POI changes). */
function rebuildIndex() {
  const pois = getAllActivePois();
  coordinator.rebuild(pois);
}

module.exports = { startPoller, stopPoller, getStatus, rebuildIndex, coordinator };

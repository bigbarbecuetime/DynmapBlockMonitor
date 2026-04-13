'use strict';

const sharp = require('sharp');
const { buildTileUrl } = require('./coordinator');

/**
 * Fetch a tile PNG from the Dynmap server and return its raw pixel buffer.
 * Returns { data, info } from sharp, or throws on network/decode failure.
 */
async function fetchTilePixels(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`Tile fetch failed: ${response.status} ${url}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * Sample a single pixel from raw RGBA pixel data.
 * Returns { r, g, b } (alpha ignored since Dynmap tiles are opaque).
 */
function samplePixel(data, width, px, pz) {
  const offset = (pz * width + px) * 4;
  return {
    r: data[offset],
    g: data[offset + 1],
    b: data[offset + 2],
  };
}

/**
 * Compare two colours using Euclidean distance in RGB space.
 * Returns true if the colours differ beyond the given tolerance.
 */
function colorChanged(a, b, tolerance = 0) {
  const dist = Math.sqrt(
    Math.pow(a.r - b.r, 2) +
    Math.pow(a.g - b.g, 2) +
    Math.pow(a.b - b.b, 2)
  );
  return dist > tolerance;
}

/**
 * For a batch of POIs in the same tile, fetch the zzzz_ tile once and sample
 * each POI's pixel. Returns an array of { poi, current } for each POI that
 * has a baseline set and whose colour has changed beyond tolerance.
 *
 * @param {string} tileKey  e.g. "zzzz_-3_2"
 * @param {Object[]} pois   POI rows from the database
 * @param {Object} settings { dynmap_url, world_name, map_type }
 * @returns {Array<{poi, current: {r,g,b}}>}
 */
async function detectChangesInTile(tileKey, pois, settings) {
  const url = buildTileUrl(settings.dynmap_url, settings.world_name, settings.map_type, tileKey);

  let pixels;
  try {
    pixels = await fetchTilePixels(url);
  } catch (err) {
    console.warn(`[detector] Could not fetch tile ${tileKey}: ${err.message}`);
    return [];
  }

  const changed = [];
  for (const poi of pois) {
    // Skip POIs that have no baseline (they're in "learning" state)
    if (poi.baseline_r === null || poi.baseline_r === undefined) continue;

    const current = samplePixel(pixels.data, pixels.width, poi.pixel_x, poi.pixel_z);
    const baseline = { r: poi.baseline_r, g: poi.baseline_g, b: poi.baseline_b };

    if (colorChanged(baseline, current, poi.tolerance ?? 0)) {
      changed.push({ poi, current });
    }
  }
  return changed;
}

/**
 * Sample the current pixel colour for a single POI (used for set-baseline).
 * @returns {{ r, g, b }} or throws
 */
async function samplePoiColor(poi, settings) {
  const url = buildTileUrl(settings.dynmap_url, settings.world_name, settings.map_type, poi.tile_key);
  const pixels = await fetchTilePixels(url);
  return samplePixel(pixels.data, pixels.width, poi.pixel_x, poi.pixel_z);
}

module.exports = { detectChangesInTile, samplePoiColor, fetchTilePixels, samplePixel, colorChanged };

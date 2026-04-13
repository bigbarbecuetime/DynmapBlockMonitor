'use strict';


/**
 * Maintains an in-memory reverse index from tile key → list of POI objects.
 * Rebuilt from the database on startup and updated incrementally via add/remove.
 */
class TileCoordinator {
  constructor() {
    // Map<tileKey, Set<poi>> — the reverse index
    this._index = new Map();
  }

  /** Replace the entire index from a fresh list of POI rows. */
  rebuild(pois) {
    this._index.clear();
    for (const poi of pois) {
      this._addToIndex(poi);
    }
    console.log(`[coordinator] Rebuilt index: ${pois.length} POIs across ${this._index.size} tiles`);
  }

  /** Add a single POI to the index. */
  addPoi(poi) {
    this._addToIndex(poi);
  }

  /** Remove a single POI from the index. */
  removePoi(poi) {
    const bucket = this._index.get(poi.tile_key);
    if (!bucket) return;
    bucket.delete(poi.id);
    if (bucket.size === 0) this._index.delete(poi.tile_key);
  }

  /** Update a POI (remove old entry, add new entry). */
  updatePoi(oldPoi, newPoi) {
    this.removePoi(oldPoi);
    this.addPoi(newPoi);
  }

  /**
   * Given a list of tile keys from the update endpoint, return the POI IDs
   * that live in any of those tiles. Returns a Map<tileKey, poi[]>.
   */
  matchTiles(tileKeys) {
    const matches = new Map();
    for (const key of tileKeys) {
      const bucket = this._index.get(key);
      if (bucket && bucket.size > 0) {
        matches.set(key, Array.from(bucket.values()));
      }
    }
    return matches;
  }

  /** Return all unique tile keys that have active POIs. */
  getAllTileKeys() {
    return Array.from(this._index.keys());
  }

  /** Number of tiles being watched. */
  get tileCount() { return this._index.size; }

  /** Number of POIs in the index. */
  get poiCount() {
    let n = 0;
    for (const bucket of this._index.values()) n += bucket.size;
    return n;
  }

  _addToIndex(poi) {
    if (!this._index.has(poi.tile_key)) {
      this._index.set(poi.tile_key, new Map());
    }
    this._index.get(poi.tile_key).set(poi.id, poi);
  }
}

/**
 * Parse the tile name returned by the Dynmap update endpoint.
 *
 * Flat format (canonical): "{mapType}/{[zPrefix_]tileX_tileZ}.png"
 *   e.g.  "flat2/271_606.png"          (native)
 *   e.g.  "flat2/zzzz_16_37.png"       (4 zoom-outs)
 *
 * Subdirectory format (also accepted by server, but update endpoint uses flat):
 *   "flat2/8_18/271_606.png"
 *
 * Both are handled. Returns { mapType, zoom, tileX, tileZ, tileKey } or null.
 */
function parseTileName(name) {
  const base  = name.replace(/\.png$/, '');
  const parts = base.split('/');

  // Accept 2-segment (flat) or 3-segment (bigTile dir — ignore the middle segment)
  if (parts.length < 2 || parts.length > 3) return null;
  const mapType  = parts[0];
  const tileFile = parts[parts.length - 1]; // last segment is always the tile filename

  const zoomMatch   = tileFile.match(/^(z+)_(-?\d+)_(-?\d+)$/);
  const nativeMatch = tileFile.match(/^(-?\d+)_(-?\d+)$/);

  if (zoomMatch) {
    return {
      mapType,
      zoom:    zoomMatch[1],
      tileX:   parseInt(zoomMatch[2], 10),
      tileZ:   parseInt(zoomMatch[3], 10),
      tileKey: tileFile,
    };
  }
  if (nativeMatch) {
    return {
      mapType,
      zoom:    'native',
      tileX:   parseInt(nativeMatch[1], 10),
      tileZ:   parseInt(nativeMatch[2], 10),
      tileKey: tileFile,
    };
  }
  return null;
}

/**
 * Build the URL to fetch a tile image.
 *
 *   {base}/tiles/{world}/{map}/zzzz_{tileX}_{tileZ}.png
 *
 * tileKey: e.g. "zzzz_16_32" or "0_0"
 */
function buildTileUrl(dynmapUrl, worldName, mapType, tileKey) {
  return `${dynmapUrl}/tiles/${worldName}/${mapType}/${tileKey}.png`;
}

/**
 * Compute the tile key for the tile containing block (x, z) at the given zoom level.
 * zoom_str: e.g. "zzzz" for 4 zoom-outs, or "" for native zoom.
 * Returns e.g. "zzzz_16_32" or "271_606".
 */
function computeTileKeyForBlock(x, z, zoom_str = "") {
  const n = zoom_str.length;
  const S = 1 << n;
  // X tiles align to multiples of S at native size 8 (floor)
  const tx = (x >> (n + 3)) * S;
  // Z tiles have their origin at -1, so we shift ~z by (S-1)*8 before dividing
  // to ensure the same grouping at every zoom level
  const tz = ((~z + (S - 1) * 8) >> (n + 3)) * S;
  return zoom_str ? `${zoom_str}_${tx}_${tz}` : `${tx}_${tz}`;
}

/**
 * Build the URL to fetch the native-zoom tile containing block (x, z).
 */
function buildNativeTileUrl(dynmapUrl, worldName, mapType, x, z) {
  return buildTileUrl(dynmapUrl, worldName, mapType, computeTileKeyForBlock(x, z, ""));
}

/**
 * Return the pixel offset of block (x, z) within its native-zoom tile.
 * For Dynmap flat maps, 1 block = 1 pixel and tiles are 128×128.
 * Returns { nativePixelX, nativePixelZ }.
 */
function nativePixelOffset(x, z) {
  return {
    nativePixelX: x & 127,
    nativePixelZ: ~z & 127,
  };
}

module.exports = {
  TileCoordinator,
  parseTileName,
  buildTileUrl,
  buildNativeTileUrl,
  nativePixelOffset,
  computeTileKeyForBlock,
};

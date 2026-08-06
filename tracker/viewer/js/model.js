/* ============================================================================
   model.js -- turns the two raw CSVs into one correlated timeline.
   ----------------------------------------------------------------------------
   The whole point of this file is that chunks.csv and players.csv are NOT on the
   same clock and NOT the same shape, so naively plotting both against their
   "time" column is wrong:

     * players.csv "time"  -- tracker host clock, written when the SLP result
                              CHANGES (so a row holds until the next one; it is a
                              step function, not a sample series).
     * chunks.csv  "time"  -- tracker host clock, when we happened to poll.
     * chunks.csv  tile_ts -- the DYNMAP SERVER's clock, when the tile actually
                              re-rendered. This is the real event time.

   On the reference server tile_ts runs ~16s AHEAD of the host clock, so 99.9% of
   tiles look like they rendered in the future relative to the poll that found
   them. Sorting or joining on raw timestamps therefore mis-orders events across
   the two sources. We estimate the offset and correct tile times onto the host
   clock, which is the one players.csv already uses -- that corrected value is
   the timeline everything else in the viewer is drawn against.
   ========================================================================= */

window.DV = window.DV || {};

(function (DV) {
  "use strict";

  /* Dynmap's /up/world/{world}/{since} feed keeps roughly a 28-30s buffer of
     recent tile updates. tracker.py does not advance its cursor when a poll
     throws, so a short outage is recovered in full by the next good poll; only a
     gap longer than the buffer actually loses tiles. That distinction is the
     difference between "ignore it" and "there is a hole in your data". */
  var RETENTION_MS = 28000;

  /* What a Mojang username can be: 3-16 characters of letters, digits and
     underscore. Used to tell a name the server gave us from a placeholder it
     substituted for one -- see the roster build. */
  var NAME_RE = /^[A-Za-z0-9_]{3,16}$/;

  /* ==========================================================================
     COORDINATE MODEL -- the one place tiles become world coordinates.
     --------------------------------------------------------------------------
     NOTE ON NAMING: the tracker calls its log "chunks.csv", but a Dynmap tile is
     NOT a Minecraft chunk. A native flat tile is 8x8 blocks, so one 16x16 chunk
     is a 2x2 block of four tiles. We say "tile" everywhere and only convert to
     chunk coordinates where a chunk is actually what you want.

     Derived from the server's own /up/configuration for the flat2 map, not
     guessed at:

       worldtomap = [16, 0, ~0,  ~0, 0, -16,  0, 1, 0]   (row-major 3x3)
       scale = 16, inclination = 90 (true overhead), tilescale = 0

     Applying it row-major gives  mapX = 16*x,  mapY = -16*z,  mapZ = y: 16 image
     pixels per block, with the map's Y axis inverted against world Z.

     Confirmed against the Dynmap source (webbukkit/dynmap, branch v3.0):
       * HDMap.getTileSize()  ->  "return 128 << tilescale;"   so a native tile
         image is 128px, and this map has tilescale = 0.
       * IsoHDPerspective.getTileCoords() takes world_to_map.transform(...) then
         "fastFloor(corner.x/tileSize), fastFloor(corner.y/tileSize)" -- tile
         index is just the map-pixel coordinate floor-divided by the tile size.
       * FileTreeMapStorage builds the path as
         "<world>/<prefix>/" + (x >> 5) + "_" + (y >> 5) + "/" + zoomprefix + x + "_" + y
         which is why the folder is coord>>5 and why zoomed tiles carry a z_/zz_
         prefix that tracker.py drops.

     So BLOCKS_PER_TILE = 128px / 16px-per-block = 8, and a tile named
     "<tileX>_<tileY>.png" covers
       world X: [tileX*8, tileX*8+8)
       world Z: [-(tileY+1)*8, -tileY*8)
     Higher tileY is further NORTH, so screen row = -tileY keeps north up.

     Sanity check against this world's border marker (+/-5504 blocks): the logged
     tile range -374..584 x / -590..668 y maps to -2992..4680 / -5344..4720
     blocks, comfortably inside it. At 16 blocks/tile it would fall outside.
     ======================================================================== */
  var BLOCKS_PER_TILE = 8;

  function tileWorld(tx, tz, bpt) {
    var b = bpt || BLOCKS_PER_TILE;
    return { x0: tx * b, x1: tx * b + b, z0: -(tz + 1) * b, z1: -tz * b, size: b };
  }

  function tileChunk(tx, tz, bpt) {
    // Minecraft chunk = 16 blocks. With 8-block tiles one chunk is a 2x2 tile
    // block, so several tiles can map onto the same chunk coordinate.
    var w = tileWorld(tx, tz, bpt);
    return { cx: Math.floor(w.x0 / 16), cz: Math.floor(w.z0 / 16) };
  }

  /* --------------------------------------------------------------- utilities */

  function parseMs(s) {
    // "2026-07-23T06:29:29Z" -> epoch ms. The tracker always writes this exact
    // shape; anything else is treated as unparseable rather than guessed at.
    if (!s) return NaN;
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(s);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    var t = Date.parse(s);
    return isNaN(t) ? NaN : t;
  }

  function pct(sorted, p) {
    if (!sorted.length) return NaN;
    var i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
    return sorted[i];
  }

  function median(sorted) { return pct(sorted, 0.5); }

  /* Index of the first element whose `key` is >= ms, in an array already sorted by
     that key. The one copy of this: every hot path in the viewer walks a
     time-sorted array (tiles by tileMs, steps/snapshots by ms), and it was
     previously re-implemented four times with two different edge conventions. */
  function lowerBound(arr, ms, key) {
    var k = key || "ms", lo = 0, hi = arr.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (arr[mid][k] < ms) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /* The last element at or before ms, or null. */
  function atOrBefore(arr, ms, key) {
    var i = lowerBound(arr, ms, key);
    var k = key || "ms";
    // lowerBound lands on the first >= ms; an exact hit is still "at or before".
    if (i < arr.length && arr[i][k] === ms) return arr[i];
    return i > 0 ? arr[i - 1] : null;
  }

  /* Elements whose `key` falls in [from, to], as a slice of a sorted array. */
  function sliceRange(arr, from, to, key) {
    var k = key || "ms";
    var i = lowerBound(arr, from, k);
    var j = i;
    while (j < arr.length && arr[j][k] <= to) j++;
    return arr.slice(i, j);
  }

  /* ".../tiles/8302018/flat2/8_18/256_600.png" -> the parts we need. Returns
     null for anything that isn't a native two-coordinate tile name. */
  function parseTileUrl(url) {
    if (!url) return null;
    var q = url.indexOf("?");
    if (q >= 0) url = url.slice(0, q);
    var parts = url.split("/");
    var file = parts.pop();
    if (!/\.png$/i.test(file)) return null;
    var coords = file.replace(/\.png$/i, "").split("_");
    if (coords.length !== 2) return null;            // zoomed LOD tile (z_/zz_) or unexpected
    var tx = parseInt(coords[0], 10), tz = parseInt(coords[1], 10);
    if (isNaN(tx) || isNaN(tz)) return null;
    var region = parts.pop() || "";
    var map = parts.pop() || "";
    var world = parts.pop() || "";
    var ti = parts.indexOf("tiles");
    var origin = (ti > 0 ? parts.slice(0, ti) : parts).join("/");
    return { tx: tx, tz: tz, region: region, map: map, world: world, origin: origin,
             name: map + "/" + region + "/" + file };
  }

  /* Tile coordinates are only unique WITHIN one map type, so this key carries no
     map type: build() filters the model down to a single type first (see the
     "one map type at a time" block). Do not reuse this key across types. */
  function tileKey(tx, tz) { return tx + "," + tz; }

  /* The filename tracker.py's save_chunk_image() writes when SAVE_IMAGES=true:
     "<tile_ts>_" + name with slashes flattened. Reproducing it here is what lets
     the viewer prefer a real historical snapshot over the server's current tile. */
  function historicalName(t) {
    return t.rawTileMs + "_" + t.map + "_" + t.region.replace(/\//g, "_") + "_" + t.tx + "_" + t.tz + ".png";
  }

  /* ======================================================================= */

  /* ==========================================================================
     PARSE CACHE
     --------------------------------------------------------------------------
     Live mode re-derives the model on every poll, but the raw rows never change
     once written -- only new ones are appended. Re-running parseMs (a regex) and
     parseTileUrl (splits) over every row each time is the single most expensive
     thing the viewer does: ~9,200 rows today, ~65,000 after a week.

     So the parse is memoised. The caller hands the same cache object back on each
     rebuild; we reuse it as long as the row arrays are the SAME arrays and have
     only grown, and parse just the tail. This is why app.js appends rows in place
     rather than with concat(): a fresh array would break identity and force a
     full re-parse every poll.

     Only skew-independent facts are cached (capMs, rawTileMs, coordinates), so
     changing the clock offset, map type or blocks-per-tile re-derives without
     re-parsing.
     ======================================================================== */
  function freshCache(chunkRows, playerRows) {
    return {
      chunkSrc: chunkRows, playerSrc: playerRows,
      chunkSeen: 0, playerSeen: 0,
      allTiles: [], chunkErrors: [], lifecycle: [], playerErrors: [],
      snapByTime: new Map(), snapshots: [], mapCounts: new Map(),
      /* (tile URL + tile_ts) already seen. tile_ts IS the moment the tile
         rendered, so the same pair twice is necessarily the same event recorded
         twice -- which happens if two tracker instances ever write to one folder
         (easy to do by accident: renaming a compose project orphans the old
         containers, leaving them running). Counting it twice would inflate the
         heatmap, so drop the repeat instead of trusting the file. */
      seenTiles: new Set(), duplicates: 0
    };
  }

  function usable(cache, chunkRows, playerRows) {
    return cache && cache.chunkSrc === chunkRows && cache.playerSrc === playerRows &&
           cache.chunkSeen <= chunkRows.length && cache.playerSeen <= playerRows.length;
  }

  /* opts: {skewMs|null (null = estimate), blocksPerTile, retentionMs, mapType, cache} */
  function build(chunkRows, playerRows, opts) {
    opts = opts || {};
    var bpt = opts.blocksPerTile || BLOCKS_PER_TILE;
    var retention = opts.retentionMs || RETENTION_MS;

    /* ---- pass 1: parse whatever is new ------------------------------- */
    var C = usable(opts.cache, chunkRows, playerRows) ? opts.cache : freshCache(chunkRows, playerRows);
    if (opts.cache && opts.cache !== C) {
      // Caller's cache was stale (different arrays, or rows removed): replace its
      // contents in place so the caller keeps holding a valid object.
      for (var kk in C) opts.cache[kk] = C[kk];
      C = opts.cache;
    }

    var allTiles = C.allTiles, chunkErrors = C.chunkErrors, lifecycle = C.lifecycle,
        mapCounts = C.mapCounts;
    for (var i = C.chunkSeen; i < chunkRows.length; i++) {
      var r = chunkRows[i];
      var capMs = parseMs(r.time);
      if (r.event) { lifecycle.push({ ms: capMs, raw: r.event, source: "chunks" }); continue; }
      if (r.error) { chunkErrors.push({ ms: capMs, reason: r.error }); continue; }
      var info = parseTileUrl(r.tile);
      if (!info) continue;
      var rawTileMs = r.tile_ts ? Number(r.tile_ts) : parseMs(r.tile_time);
      if (!isFinite(rawTileMs)) rawTileMs = capMs;
      var dedupKey = r.tile + "|" + rawTileMs;
      if (C.seenTiles.has(dedupKey)) { C.duplicates++; continue; }
      C.seenTiles.add(dedupKey);
      mapCounts.set(info.map, (mapCounts.get(info.map) || 0) + 1);
      allTiles.push({
        capMs: capMs, rawTileMs: rawTileMs, url: r.tile,
        tx: info.tx, tz: info.tz, region: info.region, map: info.map,
        world: info.world, origin: info.origin, name: info.name
      });
    }
    C.chunkSeen = chunkRows.length;

    /* ---- one map type at a time --------------------------------------- */
    /* tracker.py can be run with MAP_TYPE="" to log EVERY map type. Different
       map types are different projections of the same world (flat2/night are
       overhead 8x8; t/night2/test1 are isometric) yet they reuse the same tile
       coordinate numbers, so a tile named 256_600 exists independently in each.
       Merging them would count one physical block change several times, paint
       neighbouring cells from different projections, and make the world-coordinate
       readout wrong for whichever type doesn't match blocksPerTile. So the grid is
       always ONE map type, and everything downstream may safely key on (tx,tz).
       Default to whichever type has the most rows. */
    /* Choosing the default: OVERHEAD FIRST, then volume.

       Picking simply the most-logged type was wrong and quietly broke everything
       downstream. Once the tracker began logging every map, the isometric "t"
       overtook "flat2" on count (27,080 to 15,690 -- one chunk load crosses
       several isometric tiles), so the model silently switched its whole
       coordinate frame to a skewed projection while the heatmap, the tile/world
       readout and the tracks all still assumed an overhead one. Positions were
       nonsense and nothing announced it.

       An overhead map is the only kind whose tile grid maps linearly onto world
       X/Z, which is what every position calculation here needs, so prefer one
       whenever the projections are known. */
    var mapTypes = Array.from(mapCounts.entries())
      .map(function (e) {
        var cfg = opts.mapConfigs ? opts.mapConfigs[e[0]] : null;
        var overhead = cfg && cfg.worldtomap ? Math.abs(cfg.worldtomap[4]) < 1e-9 : null;
        return { map: e[0], count: e[1], overhead: overhead };
      })
      .sort(function (a, b) {
        // known-overhead beats unknown beats known-skewed; then by volume
        var ra = a.overhead === true ? 0 : (a.overhead === null ? 1 : 2);
        var rb = b.overhead === true ? 0 : (b.overhead === null ? 1 : 2);
        return ra - rb || b.count - a.count || (a.map < b.map ? -1 : 1);
      });
    var mapType = opts.mapType && mapCounts.has(opts.mapType) ? opts.mapType
                : (mapTypes.length ? mapTypes[0].map : "");
    var rawTiles = mapTypes.length > 1
      ? allTiles.filter(function (t) { return t.map === mapType; })
      : allTiles;

    /* ---- clock skew ---------------------------------------------------- */
    /* A tile can only be OBSERVED after it rendered, so on a common clock
       (capture - render) >= 0 always. Measured on the raw values it is almost
       always negative, and how negative it is IS the clock offset. The most
       optimistic sample -- the tile we caught with the least delay -- pins it:

           skew = -min(capture - rawTile)

       We use the true minimum rather than a low percentile precisely because the
       invariant is physical: any choice above the minimum leaves some tiles
       "observed before they rendered", which is impossible and shows up as
       negative lag. The guard below only rejects the minimum when it is absurdly
       far from the bulk of the distribution, which means a corrupt or
       clock-jumped row rather than a genuinely prompt observation. */
    var diffs = [];
    for (i = 0; i < rawTiles.length; i++) diffs.push(rawTiles[i].capMs - rawTiles[i].rawTileMs);
    diffs.sort(function (a, b) { return a - b; });

    function estimateFrom(sorted) {
      if (!sorted.length) return 0;
      var lo = sorted[0], p = pct(sorted, 0.01);
      var basis = (sorted.length > 100 && isFinite(p) && (p - lo) > 60000) ? p : lo;
      return Math.max(0, -basis);
    }
    var estimated = estimateFrom(diffs);

    /* PER RUN, not per file. The offset is a property of the tracker process:
       tracker.py now anchors its clock to the server's Date header at startup, so
       a log spanning that change contains one stretch written ~14s slow and
       another written correctly. A single global estimate would take the worst
       case from the old stretch and wrongly shift the corrected rows back by it.
       Each "tracker starting" event opens a new run, so segment there and
       estimate inside each; runs with too few tiles to be reliable fall back to
       the file-wide number. */
    var runStarts = [];
    for (i = 0; i < lifecycle.length; i++) {
      if (/^tracker starting/.test(lifecycle[i].raw)) runStarts.push(lifecycle[i].ms);
    }
    runStarts.sort(function (a, b) { return a - b; });

    function runOf(ms) {
      var lo = 0, hi = runStarts.length;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (runStarts[mid] <= ms) lo = mid + 1; else hi = mid; }
      return lo - 1;                       // -1 = before any recorded start
    }

    var runDiffs = new Map();
    for (i = 0; i < rawTiles.length; i++) {
      var ri = runOf(rawTiles[i].capMs);
      if (!runDiffs.has(ri)) runDiffs.set(ri, []);
      runDiffs.get(ri).push(rawTiles[i].capMs - rawTiles[i].rawTileMs);
    }
    var runSkew = new Map();
    runDiffs.forEach(function (arr, ri) {
      arr.sort(function (a, b) { return a - b; });
      runSkew.set(ri, arr.length >= 20 ? estimateFrom(arr) : estimated);
    });
    var skewMs = (opts.skewMs === null || opts.skewMs === undefined) ? estimated : opts.skewMs;

    /* ==========================================================================
       RENDER-QUEUE DELAY
       --------------------------------------------------------------------------
       tile_ts is when Dynmap FINISHED REDRAWING a tile, which is not when the
       player caused the chunk to load. Dynmap queues dirty tiles and works
       through them, and on this server that queue runs well over a minute deep.
       Measured three independent ways over 67h of log:

         * 130 flat2 tiles are stamped while NOBODY was online, 98% of them
           within 120s of the last player leaving (median 42s). Nothing was there
           to cause them; they are the queue draining.
         * Sessions with enough tiles to measure: the first tile lands a median
           of 66s after the join (p25 41s, p75 95s).
         * The calibration session's own cluster starts at join +51s and ends at
           leave +84s -- late at BOTH ends by a similar amount, which is the
           signature of a pipeline delay rather than a clock offset.

       Estimated here by asking which backward shift best explains tile activity
       by player presence: sweeping the shift, the fraction of tiles landing
       inside an occupied interval peaks at 99.75% at -73s, against 99.1%
       unshifted. That is the number applied.

       This is a MEDIAN, and the spread is real (41-95s between quartiles), so it
       fixes alignment, not jitter. Without it every track is dragged about a
       minute past the session that produced it -- which is how tracks were being
       created in windows with nobody online, and therefore no name.
       ======================================================================== */
    function estimateRenderDelay(rawList, occupied) {
      if (!rawList.length || !occupied.length) return 0;
      var startsArr = occupied.map(function (o) { return o[0]; });
      function inside(t) {
        var lo = 0, hi = startsArr.length;
        while (lo < hi) { var mid = (lo + hi) >> 1; if (startsArr[mid] <= t) lo = mid + 1; else hi = mid; }
        var i = lo - 1;
        return i >= 0 && t >= occupied[i][0] && t < occupied[i][1];
      }
      /* Objective: the fewest tiles left attributable to NOBODY. That is exactly
         the symptom being fixed -- a tile stamped when the server was empty
         cannot have been caused by a player, so the shift that empties that
         bucket is the shift that aligns cause with effect.

         Scored over every tile, not just those near a session edge. It is
         tempting to score only the edges, since a long session's interior is
         inside the window at any shift and contributes nothing -- but an edge
         window also sweeps in the busy first minutes of long sessions, which
         pull one-sidedly and dragged the estimate to 162s against a true peak
         near 70s. Interior tiles are merely insensitive, not misleading. */
      var best = 0, bestHit = -1;
      for (var d = 0; d <= 180000; d += 1000) {
        var hit = 0;
        for (var k = 0; k < rawList.length; k++) if (inside(rawList[k] - d)) hit++;
        if (hit > bestHit) { bestHit = hit; best = d; }
      }
      return best;
    }

    /* Intervals during which at least one player was online, from the snapshots.
       Built before the tiles are placed on the timeline, because the tiles are
       about to be aligned TO it. */
    function occupiedIntervals(snaps) {
      var out = [];
      for (var i = 0; i < snaps.length - 1; i++) {
        if (snaps[i].count > 0) {
          if (out.length && snaps[i].ms - out[out.length - 1][1] < 1000) out[out.length - 1][1] = snaps[i + 1].ms;
          else out.push([snaps[i].ms, snaps[i + 1].ms]);
        }
      }
      return out;
    }

    /* ---- tiles on the corrected (host) timebase ------------------------ */
    /* Occupancy, read straight off the player rows -- needed BEFORE the tiles are
       placed on the timeline, because they are about to be aligned to it. A light
       scan rather than the full snapshot build, which happens further down. */
    /* Counts the NAMES too, not just the count column: a name in the sample is
       proof that account was connected, so a sample of one against a count of
       zero means one person was on. Reading only the count called those moments
       empty and handed the tiles rendered in them to nobody. */
    var occSnaps = [], occSeen = new Map();
    for (i = 0; i < playerRows.length; i++) {
      var pr = playerRows[i];
      if (pr.event || pr.error || pr.count === "" || pr.count === undefined) continue;
      var pms2 = parseMs(pr.time), occ = occSeen.get(pms2);
      if (!occ) { occ = { ms: pms2, count: parseInt(pr.count, 10) || 0, named: 0 }; occSeen.set(pms2, occ); occSnaps.push(occ); }
      if (pr.player) occ.named++;
    }
    for (i = 0; i < occSnaps.length; i++) occSnaps[i].count = Math.max(occSnaps[i].count, occSnaps[i].named);
    occSnaps.sort(function (a, b) { return a.ms - b.ms; });
    var occupied = occupiedIntervals(occSnaps);

    var rawTileMsList = [];
    for (i = 0; i < rawTiles.length; i++) rawTileMsList.push(rawTiles[i].rawTileMs - skewMs);
    rawTileMsList.sort(function (a, b) { return a - b; });
    var renderDelayMs = opts.renderDelayMs === undefined
      ? estimateRenderDelay(rawTileMsList, occupied)
      : opts.renderDelayMs;

    var tiles = [];
    var manual = (opts.skewMs !== null && opts.skewMs !== undefined);
    for (i = 0; i < rawTiles.length; i++) {
      var t = rawTiles[i];
      // A manual override applies to everything; otherwise each row is corrected
      // by the offset its own tracker run was written with.
      var use = manual ? skewMs : (runSkew.has(runOf(t.capMs)) ? runSkew.get(runOf(t.capMs)) : estimated);
      t.skewMs = use;
      t.renderMs = t.rawTileMs - use;    // when Dynmap finished drawing it
      t.lagMs = t.capMs - t.renderMs;    // render -> observed, the polling delay
      /* The timeline position is when the chunk was LOADED, which is the render
         time less the queue depth -- that is the moment a player was there, and
         the only one worth correlating against player activity. */
      t.tileMs = t.renderMs - renderDelayMs;
      tiles.push(t);
    }
    tiles.sort(function (a, b) { return a.tileMs - b.tileMs || a.capMs - b.capMs; });
    for (i = 0; i < tiles.length; i++) tiles[i].i = i;

    var lags = tiles.map(function (x) { return x.lagMs; }).sort(function (a, b) { return a - b; });
    var lag = {
      minMs: lags.length ? lags[0] : 0,
      medianMs: median(lags), p95Ms: pct(lags, 0.95),
      maxMs: lags.length ? lags[lags.length - 1] : 0,
      negative: lags.filter(function (x) { return x < 0; }).length,
      samples: lags.length
    };

    /* ==========================================================================
       CHUNK COORDINATES AND EVENT CLASSIFICATION
       --------------------------------------------------------------------------
       Measured on 9,943 logged tiles from this server:

         * 68.5% of distinct lit tiles have BOTH coordinates even, where an even
           spread would be 25%. A Minecraft chunk is a 2x2 group of tiles, and the
           even/even member is the chunk-aligned corner -- the same coordinate
           Dynmap gives the zoomed LOD tile that covers the group.
         * Split by whether a neighbouring tile changed at nearly the same time:
           ISOLATED events are 91.1% chunk-aligned; CLUSTERED events are close to
           uniform (36/21/25/18). So the lattice and the neighbour-touching events
           are two different populations, not one.
         * In a live capture, 23 of 24 chunk-aligned groups had exactly ONE of
           their four tiles change -- chunk granularity, not block granularity.
         * Re-fetching the images: 7 of 8 re-renders of a chunk-aligned tile came
           back BYTE-IDENTICAL. Nothing about them changed visually.

       So a chunk-aligned tile that changed alone is very probably Dynmap
       re-rendering a chunk that was loaded (players moving), not a block edit.
       That is ~74% of this log, and it swamps the heatmap if left in.

       This is a HEURISTIC and named like one: "likely". A real edit that happens
       to fall on a chunk-aligned tile with no neighbour activity is
       indistinguishable here, and would be misfiled as a load. Confirming an edit
       properly means diffing the tile images, which needs SAVE_IMAGES=true.
       ======================================================================== */
    var neighbourMs = opts.neighbourMs === undefined ? 60000 : opts.neighbourMs;

    /* ---- per-tile aggregate ------------------------------------------- */
    var tileIndex = new Map();
    var tb = { minTx: Infinity, maxTx: -Infinity, minTz: Infinity, maxTz: -Infinity };
    for (i = 0; i < tiles.length; i++) {
      var tl = tiles[i], k = tileKey(tl.tx, tl.tz);
      var cell = tileIndex.get(k);
      if (!cell) { cell = { tx: tl.tx, tz: tl.tz, events: [] }; tileIndex.set(k, cell); }
      cell.events.push(i);
      if (tl.tx < tb.minTx) tb.minTx = tl.tx;
      if (tl.tx > tb.maxTx) tb.maxTx = tl.tx;
      if (tl.tz < tb.minTz) tb.minTz = tl.tz;
      if (tl.tz > tb.maxTz) tb.maxTz = tl.tz;
    }
    if (!tiles.length) tb = { minTx: -8, maxTx: 8, minTz: -8, maxTz: 8 };

    /* ---- chunk coordinates + load/edit classification ------------------ */
    /* Neighbour test by binary search into each cell's own event list, rather
       than sweeping a time window: four short searches per tile instead of a scan
       over everything nearby, which matters because this runs on every rebuild. */
    function neighbourChanged(tx, tz, tMs) {
      var cell = tileIndex.get(tileKey(tx, tz));
      if (!cell) return false;
      var ev = cell.events;                       // indices, ascending in tileMs
      var lo = 0, hi = ev.length;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (tiles[ev[mid]].tileMs < tMs - neighbourMs) lo = mid + 1; else hi = mid;
      }
      return lo < ev.length && tiles[ev[lo]].tileMs <= tMs + neighbourMs;
    }

    var loadCount = 0, editCount = 0;
    for (i = 0; i < tiles.length; i++) {
      var t2 = tiles[i];
      var ch = tileChunk(t2.tx, t2.tz, bpt);
      t2.cx = ch.cx; t2.cz = ch.cz;
      // The chunk-aligned corner: the tile Dynmap's zoomed LOD shares a name with.
      t2.aligned = (t2.tx % 2 === 0) && (t2.tz % 2 === 0);
      t2.isolated = !(neighbourChanged(t2.tx + 1, t2.tz, t2.tileMs) ||
                      neighbourChanged(t2.tx - 1, t2.tz, t2.tileMs) ||
                      neighbourChanged(t2.tx, t2.tz + 1, t2.tileMs) ||
                      neighbourChanged(t2.tx, t2.tz - 1, t2.tileMs));
      t2.kind = (t2.aligned && t2.isolated) ? "load" : "edit";
      if (t2.kind === "load") loadCount++; else editCount++;
    }

    /* ---- pass 2: player rows ------------------------------------------ */
    /* Rows sharing one "time" are ONE snapshot (tracker.py writes one row per
       online name). Rebuild the roster before drawing any conclusion from it.
       A poll can land mid-snapshot and split those rows across two builds, which
       the by-time Map handles: the later rows find the existing snapshot and add
       to its roster, and the flags below are recomputed each build so a
       momentarily-incomplete roster corrects itself. */
    var playerErrors = C.playerErrors, byTime = C.snapByTime;
    for (i = C.playerSeen; i < playerRows.length; i++) {
      var p = playerRows[i], pms = parseMs(p.time);
      if (p.event) { lifecycle.push({ ms: pms, raw: p.event, source: "players" }); continue; }
      if (p.error) { playerErrors.push({ ms: pms, reason: p.error }); continue; }
      if (p.count === "" || p.count === undefined) continue;
      var snap = byTime.get(pms);
      if (!snap) { snap = { ms: pms, count: parseInt(p.count, 10) || 0, roster: [], unnamed: [] }; byTime.set(pms, snap); C.snapshots.push(snap); }
      /* A sample entry that cannot be a username is not one. Mojang usernames are
         3-16 characters of [A-Za-z0-9_], so "Anonymous Player" -- which this
         server returned once, alongside a real name, with a count of 2 -- has a
         space in it and could never be anybody's account. It is the server
         declining to name someone, which is exactly the fact `truncated` already
         carries, so route it there: keep the entry OUT of the roster and leave
         the count alone, and the snapshot reads "2 online, 1 named" on its own.

         The alternative was letting it stand as a player, and it does not stand
         still: it joins, it leaves, it collects sessions, and attribution will
         hand it a track that some real person walked. A placeholder cannot own a
         track. Anything rejected here is named in the data-quality report rather
         than silently dropped -- if a Geyser server ever puts a Bedrock gamertag
         through this rule, that is where you will see it. */
      if (p.player) (NAME_RE.test(p.player) ? snap.roster : snap.unnamed).push(p.player);
    }
    C.playerSeen = playerRows.length;

    var snapshots = C.snapshots.sort(function (a, b) { return a.ms - b.ms; });
    for (i = 0; i < snapshots.length; i++) {
      var s = snapshots[i];
      s.roster.sort();
      s.i = i;
      if (!s.unnamed) s.unnamed = [];   // snapshots cached from an older build
      /* Two independent things can disagree here, and they mean opposite things:
         count > roster  -- the server capped/hid its SLP sample list, so names
                            are missing and a derived "leave" may be an artifact.
         count < roster  -- the count is SHORT of the sample. Not a contradiction
                            to be split down the middle: a name in the sample is
                            the server telling us that account was connected, and
                            it has no reason to invent one. The count is the side
                            that can be made to lie -- a vanish plugin drops the
                            admin from the head-count, and this server hides
                            players from Dynmap the same way (dyncount reads 0
                            with three people on). Every one of the 61 here is
                            short by exactly one and lasts exactly one poll. */
      /* Placeholders count as accounted for: the server did return an entry for
         that player, it just would not name them, so the sample was not CAPPED.
         Otherwise one anonymised entry also raised "some players could not be
         named", reporting one event as two different problems. */
      s.truncated = s.count > s.roster.length + s.unnamed.length;
      s.overfull = s.count < s.roster.length;
      /* The head-count we can defend: names are evidence of presence, so the
         roster is a FLOOR under the count, never a competitor to it. Placeholders
         count too -- "Anonymous Player" is somebody, just not somebody named. */
      s.online = Math.max(s.count, s.roster.length + s.unnamed.length);
    }

    /* ---- lifecycle -> coverage intervals ------------------------------ */
    /* Both CSVs get the same event row at the same instant, so dedupe first. */
    lifecycle.sort(function (a, b) { return a.ms - b.ms; });
    var events = [], seen = new Set();
    for (i = 0; i < lifecycle.length; i++) {
      var ev = lifecycle[i], key = ev.ms + "|" + ev.raw;
      if (seen.has(key)) continue;
      seen.add(key);
      ev.kind = /^tracker starting/.test(ev.raw) ? "start"
              : /^tracker stopped/.test(ev.raw) ? "stop"
              : /closed without warning/.test(ev.raw) ? "unclean" : "other";
      events.push(ev);
    }

    var dataMs = [];
    for (i = 0; i < tiles.length; i++) dataMs.push(tiles[i].capMs);
    for (i = 0; i < snapshots.length; i++) dataMs.push(snapshots[i].ms);
    for (i = 0; i < chunkErrors.length; i++) dataMs.push(chunkErrors[i].ms);
    for (i = 0; i < playerErrors.length; i++) dataMs.push(playerErrors[i].ms);
    dataMs.sort(function (a, b) { return a - b; });

    var bounds = { minMs: NaN, maxMs: NaN };
    /* min/max directly, rather than concatenating and sorting a second copy of
       every timestamp in the file just to read its two ends. dataMs is already
       ascending. */
    var lo = Infinity, hi = -Infinity;
    if (dataMs.length) { lo = dataMs[0]; hi = dataMs[dataMs.length - 1]; }
    for (i = 0; i < events.length; i++) {
      var ems = events[i].ms;
      if (!isFinite(ems)) continue;
      if (ems < lo) lo = ems;
      if (ems > hi) hi = ems;
    }
    if (isFinite(lo)) { bounds.minMs = lo; bounds.maxMs = hi; }
    // Corrected tile times can sit slightly outside the capture range.
    if (tiles.length) {
      bounds.minMs = Math.min(bounds.minMs, tiles[0].tileMs);
      bounds.maxMs = Math.max(bounds.maxMs, tiles[tiles.length - 1].tileMs);
    }
    /* The newest ROW, kept separately because extendLive() below can push maxMs
       past it: in live mode the two answer different questions -- "how far does
       the timeline reach" and "when did we last actually hear anything". */
    bounds.dataMaxMs = bounds.maxMs;

    var coverage = [], open = null;
    /* Binary search, not a scan: this is called once per lifecycle event, and a
       long-lived file with many tracker restarts would otherwise be O(restarts x
       rows) on every rebuild -- 100 restarts over 65k rows is 6.5M steps a poll. */
    /* STRICTLY before, and that strictness is the whole point. Both callers are
       retro-closing a dead run using a marker that the NEXT run wrote, and the
       next run's first poll lands on the very same second as its own marker --
       a restart logged "closed without warning" at 18:43:49 and recorded its
       first tiles at 18:43:49. With <=, the dead run swallowed that tile and
       closed at the restart instant instead of at its last real sample, hiding a
       15.7h outage as covered time. */
    function lastDataBefore(ms) {
      var lo = 0, hi = dataMs.length;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (dataMs[mid] < ms) lo = mid + 1; else hi = mid; }
      return lo > 0 ? dataMs[lo - 1] : NaN;
    }
    for (i = 0; i < events.length; i++) {
      ev = events[i];
      if (ev.kind === "start") {
        if (open) { open.endMs = lastDataBefore(ev.ms) || ev.ms; open.complete = false; open.endReason = "no stop marker"; coverage.push(open); }
        open = { startMs: ev.ms, endMs: NaN, complete: true, endReason: "" };
      } else if (ev.kind === "stop") {
        if (open) { open.endMs = ev.ms; open.complete = true; coverage.push(open); open = null; }
      } else if (ev.kind === "unclean") {
        /* tracker.py writes this at the START of the next run, after discovering
           the previous run never recorded a stop. So it retro-closes whatever
           interval is still open, at the last row we actually have. */
        if (open) {
          var last = lastDataBefore(ev.ms);
          open.endMs = isFinite(last) ? last : ev.ms;
          open.complete = false;
          open.endReason = "killed; end time unknown";
          coverage.push(open);
          open = null;
        }
      }
    }
    if (open) {
      open.endMs = isFinite(bounds.maxMs) ? bounds.maxMs : open.startMs;
      open.complete = false;
      open.endReason = "still running / not yet stopped";
      open.open = true;                  // the only run extendLive() may move
      coverage.push(open);
    }
    // No lifecycle rows at all (someone loaded a hand-trimmed CSV): assume the
    // data range itself is the covered window rather than reporting 100% gap.
    if (!coverage.length && isFinite(bounds.minMs)) {
      coverage.push({ startMs: bounds.minMs, endMs: bounds.maxMs, complete: false, endReason: "no start/stop markers in file" });
    }

    /* ==========================================================================
       COVERAGE ON THE CORRECTED CLOCK
       --------------------------------------------------------------------------
       The intervals above are host-clock facts about the tracker PROCESS: it was
       up from this start marker until that stop marker. But everything the viewer
       DRAWS sits on the corrected clock -- a tile is plotted at
       renderMs - renderDelayMs, which is skew + queue depth EARLIER than the poll
       that found it. So a run's first tiles land before its own start marker, and
       asking the raw interval "were you running then?" answered NO about rows the
       tracker itself wrote. On this log that was 426 tiles drawn as bars sitting
       on top of the "tracker not running" hatch, with the tile panel calling them
       "outside a tracker run" and the Now panel reporting changes at a moment it
       said nothing was recorded.

       The observation window genuinely does open before the start marker, and by
       a knowable amount: Dynmap's since-feed hands the first poll its whole ~28s
       buffer, and the chunk load that a render is evidence of happened
       renderDelayMs before the render. So in corrected time a run covers from
       startMs - (retention + renderDelayMs). Here that bound is 101s against a
       worst observed overhang of 97s -- it explains every one of those tiles
       without claiming coverage past what the feed can actually deliver.

       The end needs no such shift: a tile is always plotted before the poll that
       caught it, so nothing overhangs a stop marker.

       Runs whose lookbacks overlap merge, which is what this log's 2-4s
       stop/start restart pairs always physically were. Merging matters because
       callers sum these intervals to measure off-time, and overlapping ones would
       count the same second twice.
       ======================================================================== */
    var lookbackMs = retention + renderDelayMs;
    var dataCoverage = [];
    for (i = 0; i < coverage.length; i++) {
      coverage[i].dataStartMs = coverage[i].startMs - lookbackMs;
      var tail = dataCoverage[dataCoverage.length - 1];
      if (tail && coverage[i].dataStartMs <= tail.endMs) {
        if (coverage[i].endMs > tail.endMs) tail.endMs = coverage[i].endMs;
      } else {
        dataCoverage.push({ startMs: coverage[i].dataStartMs, endMs: coverage[i].endMs });
      }
    }

    /* Binary search, not the scan this replaced: covered() is called once per
       tile on every rebuild and once per hovered pixel, and a log with 53 runs
       paid all 53 comparisons every time. */
    function covered(ms) {
      var lo = 0, hi = dataCoverage.length;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (dataCoverage[mid].startMs <= ms) lo = mid + 1; else hi = mid; }
      var c = dataCoverage[lo - 1];
      return !!c && ms <= c.endMs;
    }

    /* ==========================================================================
       THE LIVE EDGE
       --------------------------------------------------------------------------
       Every interval above ends at a logged row, because a row is the only proof
       the model has. That makes the newest row the end of the world, which is
       wrong while the tracker is still up: it writes NOTHING when a poll finds
       nothing changed, so a quiet hour and a dead tracker look identical in the
       file. The viewer, tailing that file, knows something the file does not --
       that time is passing and the run has no stop marker yet -- and this is
       where it says so.

       Only a run still marked open may be extended, and only forward. If the
       tracker did die in that silence the claim is wrong until its next start
       writes "closed without warning", which retro-closes the run at its last
       real row -- the correction is already in the lifecycle handling above, so
       the mistake is temporary and self-repairing. A cleanly stopped run is never
       extended: it said when it ended.

       Mutates in place rather than rebuilding, because it is called on every live
       poll and a rebuild of this log costs ~380 ms of full passes to move one
       number. covered() and uncoveredMs() read the same array objects, so they
       follow along. */
    function extendLive(ms) {
      if (!isFinite(ms) || !(ms > bounds.maxMs)) return false;
      var last = coverage[coverage.length - 1];
      if (!last || !last.open) return false;
      bounds.maxMs = ms;
      last.endMs = ms;
      var tail = dataCoverage[dataCoverage.length - 1];
      if (tail) tail.endMs = ms;
      return true;
    }

    /* Milliseconds between a and b that no run covers. The one implementation of
       this: the panels and the timeline tooltip both need it, and both used to
       decide "was anything recorded here?" from a single instant, which is how a
       bucket spanning an outage could show bars and call itself unrecorded. */
    function uncoveredMs(aMs, bMs) {
      if (!(bMs > aMs)) return 0;
      var on = 0;
      for (var j = 0; j < dataCoverage.length; j++) {
        var s = Math.max(aMs, dataCoverage[j].startMs), e = Math.min(bMs, dataCoverage[j].endMs);
        if (e > s) on += e - s;
      }
      return Math.max(0, (bMs - aMs) - on);
    }

    /* ---- poll cadence, inferred rather than assumed ------------------- */
    /* Median gap between distinct tile capture times gives the real loop
       cadence. tracker.py pings the game server from that SAME loop, so the
       player cadence is the same number -- do NOT infer it from the gaps between
       player snapshots, because those rows are only written when the value
       CHANGES, which measures how often players come and go (minutes) rather
       than how often we looked (seconds). */
    // Built once and shared by inferPoll and groupErrors below; it was previously
    // materialised twice. Already ascending, since tiles are polled in order.
    var tileCapMs = [];
    for (i = 0; i < tiles.length; i++) tileCapMs.push(tiles[i].capMs);
    tileCapMs.sort(function (a, b) { return a - b; });

    var pollMs = inferPoll(tileCapMs);
    var playerPollMs = pollMs;
    var playerChangeMs = inferPoll(snapshots.map(function (x) { return x.ms; }));

    /* ---- error windows ------------------------------------------------ */
    var chunkWindows = groupErrors(chunkErrors, pollMs, tileCapMs, retention);
    var playerWindows = groupErrors(playerErrors, pollMs, snapshots, Infinity);

    /* ---- joins / leaves ---------------------------------------------- */
    /* Only ever derived by diffing two adjacent snapshots. Anything that could
       make that diff a lie -- a tracker restart in between, a player-ping outage
       in between, a capped sample on either side -- is marked uncertain instead
       of being presented as a clean join/leave. */
    var transitions = [];
    for (i = 0; i < snapshots.length; i++) {
      var cur = snapshots[i], prev = i > 0 ? snapshots[i - 1] : null;
      if (!prev) {
        for (var a = 0; a < cur.roster.length; a++) {
          transitions.push(mkTrans(cur.ms, "join", cur.roster[a], prev, cur, true, "first snapshot: already online"));
        }
        continue;
      }
      var gapReason = "";
      if (!sameRun(coverage, prev.ms, cur.ms)) gapReason = "tracker was off between samples";
      else if (windowBetween(playerWindows, prev.ms, cur.ms)) gapReason = "player ping errored between samples";
      /* Checked before the cap, because it is the more specific fact: both end up
         with fewer names than the count, but one is SLP returning a short sample
         and the other is the server holding a name back on purpose. */
      else if (prev.unnamed.length || cur.unnamed.length) gapReason = "the server would not name someone in its own sample";
      else if (prev.truncated || cur.truncated) gapReason = "server capped its player sample list";
      /* NOT a reason any more. A count below the sample used to flag the whole
         transition as doubtful, which was the model hedging on whether the names
         were real -- 61 of the 62 question marks in this log came from it. A name
         is the server naming an account it had connected; it is the count that a
         vanish plugin or a lagging status reply can understate. So the names are
         taken at face value, s.online carries the floor they impose, and the
         transition stands on its own. */

      var before = new Set(prev.roster), after = new Set(cur.roster);
      var joined = cur.roster.filter(function (nm) { return !before.has(nm); });
      var left = prev.roster.filter(function (nm) { return !after.has(nm); });
      joined.forEach(function (nm) { transitions.push(mkTrans(cur.ms, "join", nm, prev, cur, !!gapReason, gapReason)); });
      left.forEach(function (nm) { transitions.push(mkTrans(cur.ms, "leave", nm, prev, cur, !!gapReason, gapReason)); });

      /* The head-count can move by more than the named roster explains, because
         SLP only returns a SAMPLE of names. Record the unexplained remainder
         instead of dropping it -- requiring both rosters to be empty (the previous
         test) silently lost every join on a server that caps its sample to a few
         names. Done on s.online rather than the raw count, so a count that was
         merely short of its own sample no longer looks like people arriving: the
         floor the names impose is already in both terms and cancels. */
      var unexplained = (cur.online - prev.online) - (joined.length - left.length);
      var namesMissing = prev.truncated || cur.truncated ||
                         prev.unnamed.length || cur.unnamed.length ||
                         (!cur.roster.length && !prev.roster.length);
      if (unexplained !== 0 && namesMissing) {
        var n = Math.abs(unexplained);
        transitions.push(mkTrans(cur.ms, unexplained > 0 ? "join" : "leave",
          n > 1 ? "(" + n + " unnamed)" : "(unnamed)", prev, cur, true,
          gapReason || "the count moved by more than the named players explain; the server capped its sample"));
      }
    }
    transitions.sort(function (x, y) { return x.ms - y.ms; });

    /* The counts shown are the defensible ones. Reading them off the raw column
       produced rows like "Avery_strab3ry leave 0->0" -- a departure from a server
       that already claimed to be empty, which is not a thing that can happen. */
    function mkTrans(ms, type, player, prev, cur, uncertain, reason) {
      return { ms: ms, type: type, player: player, countBefore: prev ? prev.online : 0,
               countAfter: cur.online, uncertain: uncertain, reason: reason || "" };
    }

    /* ---- correlate tiles with who was online ------------------------- */
    /* Merge walk over two already-sorted arrays. For every tile we record the
       roster in force at its CORRECTED render time -- this is the join the whole
       skew correction exists to make possible. */
    /* The summary counts assess() needs are tallied HERE, in the pass that
       already visits every tile, rather than in four more full passes inside
       assess() itself. */
    var stats = { outsideCoverage: 0, whileEmpty: 0, truncated: 0, overfull: 0,
                  loads: loadCount, edits: editCount };
    var si = -1;
    for (i = 0; i < tiles.length; i++) {
      var tm = tiles[i].tileMs;
      while (si + 1 < snapshots.length && snapshots[si + 1].ms <= tm) si++;
      var act = si >= 0 ? snapshots[si] : null;
      tiles[i].online = act ? act.online : null;
      tiles[i].roster = act ? act.roster : [];
      tiles[i].inCoverage = covered(tm);
      if (!tiles[i].inCoverage) stats.outsideCoverage++;
      if (tiles[i].online === 0) stats.whileEmpty++;
    }
    stats.overfullExamples = [];
    stats.unnamed = 0; stats.unnamedStrings = [];
    for (i = 0; i < snapshots.length; i++) {
      for (var u = 0; u < snapshots[i].unnamed.length; u++) {
        stats.unnamed++;
        var str = snapshots[i].unnamed[u];
        if (stats.unnamedStrings.indexOf(str) < 0) stats.unnamedStrings.push(str);
      }
      if (snapshots[i].truncated) stats.truncated++;
      if (snapshots[i].overfull) {
        stats.overfull++;
        // Only the handful the report actually prints; no need to collect them all.
        if (stats.overfullExamples.length < 4) stats.overfullExamples.push(snapshots[i]);
      }
    }

    /* ---- steppable event list --------------------------------------- */
    /* One flat, time-ordered list so Left/Right arrows can walk the data point
       by point regardless of which source each point came from. */
    var steps = [];
    for (i = 0; i < tiles.length; i++) steps.push({ ms: tiles[i].tileMs, kind: "tile", ref: i });
    for (i = 0; i < snapshots.length; i++) steps.push({ ms: snapshots[i].ms, kind: "snapshot", ref: i });
    for (i = 0; i < transitions.length; i++) steps.push({ ms: transitions[i].ms, kind: transitions[i].type, ref: i });
    for (i = 0; i < chunkErrors.length; i++) steps.push({ ms: chunkErrors[i].ms, kind: "chunk-error", ref: i });
    for (i = 0; i < playerErrors.length; i++) steps.push({ ms: playerErrors[i].ms, kind: "player-error", ref: i });
    for (i = 0; i < events.length; i++) steps.push({ ms: events[i].ms, kind: "lifecycle", ref: i });
    steps.sort(function (x, y) { return x.ms - y.ms; });

    var model = {
      tiles: tiles, tileIndex: tileIndex, tileBounds: tb,
      snapshots: snapshots, transitions: transitions,
      chunkErrors: chunkErrors, playerErrors: playerErrors,
      chunkWindows: chunkWindows, playerWindows: playerWindows,
      events: events, coverage: coverage, dataCoverage: dataCoverage,
      lookbackMs: lookbackMs, steps: steps, bounds: bounds, stats: stats,
      neighbourMs: neighbourMs,
      blocksPerTile: bpt, retentionMs: retention,
      mapType: mapType, mapTypes: mapTypes, tilesAllMaps: allTiles.length, duplicatesDropped: C.duplicates,
      // every map type, unfiltered -- infer.js needs the isometric ones for height
      allTiles: allTiles,
      pollMs: pollMs, playerPollMs: playerPollMs, playerChangeMs: playerChangeMs,
      renderDelayMs: renderDelayMs, occupied: occupied,
      skew: { ms: skewMs, estimatedMs: estimated, overridden: manual,
              perRun: Array.from(runSkew.entries()).map(function (e) { return { run: e[0], ms: e[1] }; }),
              samples: diffs.length, rawMinMs: diffs.length ? diffs[0] : 0,
              rawMedianMs: median(diffs), rawMaxMs: diffs.length ? diffs[diffs.length - 1] : 0 },
      lag: lag,
      covered: covered, uncoveredMs: uncoveredMs, extendLive: extendLive
    };
    /* Before assess(), so the coverage percentage it reports is measured over the
       same span the timeline will draw. */
    if (opts.liveEdgeMs) extendLive(opts.liveEdgeMs);
    model.quality = assess(model);
    return model;
  }

  /* Median gap between consecutive distinct timestamps -- the tracker's real
     cadence, which we would rather measure than hardcode. */
  function inferPoll(msList) {
    var uniq = Array.from(new Set(msList)).sort(function (a, b) { return a - b; });
    if (uniq.length < 3) return 10000;
    var gaps = [];
    for (var i = 1; i < uniq.length; i++) { var g = uniq[i] - uniq[i - 1]; if (g > 0) gaps.push(g); }
    gaps.sort(function (a, b) { return a - b; });
    var m = median(gaps);
    return Math.min(120000, Math.max(1000, m || 10000));
  }

  /* Collapse a run of consecutive error rows into one blind window, and decide
     whether it actually cost us data.

     CAREFUL: you cannot measure an outage by looking at the gap between logged
     tiles. A poll that succeeds but finds nothing changed writes no row at all,
     so a quiet server looks identical to a dead one in the tile rows -- an early
     version of this measured one 10s timeout as a 2h54m outage because the next
     tile happened to be hours later. Errors, on the other hand, are ALWAYS
     logged, once per failed poll. So the honest measure is the number of
     consecutive error rows times the poll cadence, and nothing else. */
  function groupErrors(errs, pollMs, _ok, retentionMs) {
    if (!errs.length) return [];
    var sorted = errs.slice().sort(function (a, b) { return a.ms - b.ms; });
    var out = [], cur = null;
    for (var i = 0; i < sorted.length; i++) {
      var e = sorted[i];
      if (cur && e.ms - cur.lastMs <= pollMs * 2.5) {
        cur.lastMs = e.ms; cur.count++;
        if (cur.reasons.indexOf(e.reason) < 0) cur.reasons.push(e.reason);
      } else {
        if (cur) out.push(cur);
        cur = { startMs: e.ms, lastMs: e.ms, count: 1, reasons: [e.reason] };
      }
    }
    if (cur) out.push(cur);

    for (i = 0; i < out.length; i++) {
      var w = out[i];
      /* One failed poll blinds us for roughly one cadence; n consecutive
         failures for roughly n of them. */
      w.spanMs = (w.lastMs - w.startMs) + pollMs;
      w.endMs = w.startMs + w.spanMs;
      /* tracker.py leaves its feed cursor untouched on a failed poll, so the
         next good poll re-requests from the same point and the feed replays
         whatever it still holds. Nothing is lost while the outage fits inside
         the retention buffer; past that, the oldest updates aged out. */
      w.lossy = w.spanMs > retentionMs;
      /* Deliberately NOT recording the nearest logged tiles either side. An
         earlier version did, scanning the whole tile list per window (O(windows x
         rows) on every rebuild) to fill fields nothing consumed -- and worse, the
         comment above explains those numbers must never be used to size an
         outage, so keeping them on the object invited exactly the bug that
         comment warns about. */
    }
    return out;
  }

  function sameRun(coverage, aMs, bMs) {
    for (var i = 0; i < coverage.length; i++) {
      var c = coverage[i];
      if (aMs >= c.startMs && aMs <= c.endMs && bMs >= c.startMs && bMs <= c.endMs) return true;
    }
    return false;
  }

  function windowBetween(windows, aMs, bMs) {
    for (var i = 0; i < windows.length; i++) {
      var w = windows[i];
      if (w.startMs > aMs && w.startMs < bMs) return true;
      if (w.endMs > aMs && w.endMs < bMs) return true;
    }
    return false;
  }

  /* ---------------------------------------------------------- data quality */

  /* Everything that could make the picture misleading, stated plainly with a
     count, so the panel never has to invent wording and nothing is silently
     swallowed. Severities map to the reserved status colours and each item is
     rendered with an icon + label, never colour alone. */
  function assess(m) {
    var q = [];
    var s = m.skew;

    if (m.duplicatesDropped) {
      q.push({ severity: "warning", code: "duplicate-rows",
        title: m.duplicatesDropped.toLocaleString() + " duplicated row" + (m.duplicatesDropped > 1 ? "s" : "") + " ignored",
        detail: "The same map change was recorded more than once, which means two trackers were writing to this folder at the same time. They are counted once here, so the map is right -- but the file itself has repeats, and whichever tracker you did not mean to run should be stopped." });
    }

    if (m.mapTypes.length > 1) {
      q.push({ severity: "warning", code: "multiple-map-types",
        title: "This log holds " + m.mapTypes.length + " map types; showing " + m.mapType,
        detail: "Found " + m.mapTypes.map(function (t) { return t.map + " (" + t.count.toLocaleString() + ")"; }).join(", ") +
          ". Map types are different projections that reuse the same tile numbers, so they cannot share one grid -- only " +
          m.mapType + " is plotted. Pick another under Map, or set MAP_TYPE in the tracker to log just one. Note the isometric types (t, night2, test1) need a different blocks-per-tile than the flat ones." });
    }

    /* Written for someone reading their own data, not for someone debugging this
       code: lead with what it means for what they are looking at, and only then
       explain the mechanism. */
    if (s.ms > 0) {
      var runs = s.perRun.length;
      q.push({ severity: "info", code: "clock-skew",
        title: "Times are corrected by " + fmtDur(s.ms) + " so both files line up",
        detail: "Your tracker's clock and Dynmap's disagreed by about " + fmtDur(s.ms) +
          ", which would otherwise put every map change " + fmtDur(s.ms) +
          " away from the player activity that caused it. That is corrected here, so what you see is aligned." +
          (runs > 1 ? " Measured separately for each of the " + runs + " tracker runs in this file, since the offset can change between them." : "") +
          " Usually it is the tracker's host that has drifted -- check its time sync if you want the raw files to be right too." +
          (s.overridden ? " You have set a manual offset, which is being used instead." : "") });
    } else if (s.samples) {
      q.push({ severity: "good", code: "clock-ok", title: "Both files are on the same clock",
        detail: "No correction needed -- map changes and player activity can be compared directly." });
    }

    if (m.lag.samples) {
      q.push({ severity: m.lag.negative ? "warning" : "good", code: "render-lag",
        title: m.lag.negative
          ? "Some times could not be reconciled"
          : "Map changes show up about " + fmtDur(m.lag.medianMs) + " after they happen",
        detail: m.lag.negative
          ? m.lag.negative.toLocaleString() + " of " + m.lag.samples.toLocaleString() +
            " changes still appear to have been seen before they happened, which means the correction above is not quite right for them. Their position on the timeline may be off by a few seconds."
          : "Dynmap takes a moment to redraw a tile and the tracker checks every " + fmtDur(m.pollMs) +
            ", so a change appears " + fmtDur(m.lag.medianMs) + " later on average (worst case " + fmtDur(m.lag.maxMs) +
            "). Everything on the timeline already accounts for this." });
    }

    if (m.stats.loads + m.stats.edits > 0) {
      var loadPct = 100 * m.stats.loads / (m.stats.loads + m.stats.edits);
      q.push({ severity: "info", code: "load-vs-edit",
        title: Math.round(loadPct) + "% of map changes look like chunks loading, not edits",
        detail: m.stats.loads.toLocaleString() + " of " + (m.stats.loads + m.stats.edits).toLocaleString() +
          " changes sit alone on a chunk boundary, which is what Dynmap does when it redraws a chunk a player just walked into -- re-fetching those tiles shows the picture is usually identical. " +
          "The remaining " + m.stats.edits.toLocaleString() + " touch neighbouring tiles and are the better candidates for someone actually building. " +
          "Use Show -> \"Likely block edits only\" to drop the loading noise, or \"chunk loads only\" to watch players move." });
    }

    var gaps = m.coverage.filter(function (c) { return !c.complete; });
    if (gaps.length) {
      q.push({ severity: "serious", code: "coverage",
        title: "The tracker stopped unexpectedly " + gaps.length + " time" + (gaps.length > 1 ? "s" : ""),
        detail: "So the end of those runs is guessed at: " + gaps.map(function (c) { return fmtTime(c.startMs) + " to " + fmtTime(c.endMs) + " (" + c.endReason + ")"; }).join("; ") +
          ". Where the timeline is hatched, nothing was being recorded -- a blank map there means nobody was watching, not that the server was quiet." });
    }

    var offMs = 0;
    if (isFinite(m.bounds.minMs)) {
      /* Measured on the SAME intervals the timeline hatches, so the percentage
         here and the hatched width there are the same statement. Those are the
         merged corrected-clock runs, not the raw process ones: what this line
         claims is how much of the range has data, and the feed's lookback is
         data. */
      var span = m.bounds.maxMs - m.bounds.minMs, on = 0;
      for (var i = 0; i < m.dataCoverage.length; i++) on += Math.max(0, m.dataCoverage[i].endMs - m.dataCoverage[i].startMs);
      offMs = Math.max(0, span - on);
      if (offMs > 1000) {
        q.push({ severity: "info", code: "off-time", title: "You are only seeing " + (100 * on / span).toFixed(0) + "% of this time range",
          detail: "Nothing was recorded for " + fmtDur(offMs) + " of the " + fmtDur(span) +
          " this file spans, shown hatched on the timeline. Live data is necessarily thin at first; a few hours of history usually reads much better." });
      }
    }

    var lossy = m.chunkWindows.filter(function (w) { return w.lossy; });
    if (m.chunkWindows.length) {
      q.push({ severity: lossy.length ? "critical" : "warning", code: "chunk-errors",
        title: m.chunkErrors.length + " Dynmap poll error" + (m.chunkErrors.length > 1 ? "s" : "") +
          " in " + m.chunkWindows.length + " outage" + (m.chunkWindows.length > 1 ? "s" : ""),
        detail: (lossy.length
          ? lossy.length + " outage(s) ran longer than the feed's " + fmtDur(m.retentionMs) +
            " retention buffer, so tile changes in those windows are permanently missing: " +
            lossy.map(function (w) { return fmtTime(w.startMs) + " (" + fmtDur(w.spanMs) + ")"; }).join(", ") + "."
          : "All short enough to be recovered: the tracker does not advance its feed cursor on a failed poll, and every outage fit inside the " +
            fmtDur(m.retentionMs) + " retention buffer, so no tiles were lost.") +
          " Outage length is counted as consecutive failed polls at the " + fmtDur(m.pollMs) +
          " cadence -- it cannot be read off the gaps between logged tiles, because a poll that succeeds with nothing changed writes no row." +
          " Reasons: " + uniqReasons(m.chunkWindows) + "." });
    }

    if (m.playerErrors.length) {
      q.push({ severity: "warning", code: "player-errors",
        title: "The player list was briefly unreachable " + m.playerErrors.length + " time" + (m.playerErrors.length > 1 ? "s" : ""),
        detail: "Someone could have joined and left inside one of those gaps without ever appearing here. The roster shown just carries over from before. Cause: " +
          uniqReasons(m.playerWindows) + "." });
    }

    if (m.stats.unnamed) {
      q.push({ severity: "serious", code: "placeholder-name",
        title: "The server refused to name someone " + m.stats.unnamed + " time" + (m.stats.unnamed > 1 ? "s" : ""),
        detail: "It returned " + m.stats.unnamedStrings.map(function (s) { return '"' + s + '"'; }).join(", ") +
          " in the player sample, which cannot be a username (Mojang allows 3-16 characters of letters, digits and underscore). " +
          "Somebody was online under it -- and note the head-count INCLUDED them, so this is not the same thing as the short counts above: there the server withheld a player from the count, here it withheld only the name. " +
          "They are counted and simply not named, and joins or leaves worked out across those moments are marked with a ? . " +
          "They are left out of the roster on purpose -- a placeholder that collects sessions and gets handed a track would put a real person's movements under a name that is not theirs." });
    }

    var trunc = m.stats.truncated;
    if (trunc) {
      q.push({ severity: "serious", code: "sample-cap",
        title: "Some players could not be named (" + trunc + " sample" + (trunc > 1 ? "s" : "") + ")",
        detail: "The server only publishes a sample of names, so the head-count is right but the name list is short. Joins and leaves worked out across those moments are marked with a ? because they may be wrong." });
    }

    var over = m.stats.overfull;
    if (over) {
      q.push({ severity: "info", code: "count-below-roster",
        title: "The head-count came up short " + over + " time" + (over > 1 ? "s" : ""),
        detail: "The server named more players than its own count admitted to, always by exactly one and never for longer than a single poll: " +
          m.stats.overfullExamples.map(function (x) { return fmtTime(x.ms) + " (count " + x.count + ", " + x.roster.length + " named)"; }).join(", ") +
          (over > m.stats.overfullExamples.length ? ", ..." : "") +
          ". The names are taken as true here and the count is treated as the floor being wrong -- the server has no reason to name an account that was not connected, while a count can be made to understate (a vanish plugin drops the hidden player from it, and this server already hides everyone from Dynmap's own count). Nothing is marked uncertain for it." });
    }

    var orphan = m.stats.outsideCoverage;
    if (orphan) {
      q.push({ severity: "warning", code: "tile-outside-coverage",
        title: orphan.toLocaleString() + " change" + (orphan > 1 ? "s" : "") + " sits outside every tracker run",
        detail: "A change picked up by a run's first poll is expected to predate that run's start marker, and " + fmtDur(m.lookbackMs) +
          " of that overhang is already allowed for (the feed's " + fmtDur(m.retentionMs) + " buffer plus the " + fmtDur(m.renderDelayMs) +
          " render queue). These fall outside even that, so their position on the timeline rests on a correction bigger than the mechanism explains. Worth a look only if this number is large." });
    }

    var idle = m.stats.whileEmpty;
    if (idle && m.tiles.length) {
      q.push({ severity: "info", code: "changes-while-empty",
        title: (100 * idle / m.tiles.length).toFixed(1) + "% of map changes happened with nobody online",
        detail: idle.toLocaleString() + " of " + m.tiles.length.toLocaleString() +
          " changes happened while nobody was logged in. The world keeps ticking without players, so a low number here is normal and simply means map activity is not a perfect stand-in for player activity." });
    }

    return q;
  }

  function uniqReasons(windows) {
    var set = [];
    for (var i = 0; i < windows.length; i++)
      for (var j = 0; j < windows[i].reasons.length; j++)
        if (set.indexOf(windows[i].reasons[j]) < 0) set.push(windows[i].reasons[j]);
    return set.length ? set.join(", ") : "unknown";
  }

  /* ------------------------------------------------------------ formatting */

  function two(n) { return (n < 10 ? "0" : "") + n; }

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  /* Display mode for every timestamp in the UI:
       "local" -- the viewer's own timezone, date first, 12-hour. What you want
                  when reading "when did this happen".
       "raw"   -- the exact UTC string the CSV holds. What you want when
                  cross-referencing a row in the file.
     The tracker always WRITES UTC; this only changes how it is shown. Clicking
     any timestamp in the UI flips between the two. */
  var timeMode = "local";

  function setTimeMode(m) { timeMode = (m === "raw") ? "raw" : "local"; }
  function getTimeMode() { return timeMode; }
  function toggleTimeMode() { setTimeMode(timeMode === "local" ? "raw" : "local"); return timeMode; }

  function timeZoneName() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time"; }
    catch (e) { return "local time"; }
  }

  function hour12(d) { var h = d.getHours() % 12; return h === 0 ? 12 : h; }
  function meridiem(d) { return d.getHours() < 12 ? "AM" : "PM"; }

  function localClock(d) {
    return hour12(d) + ":" + two(d.getMinutes()) + ":" + two(d.getSeconds()) + " " + meridiem(d);
  }

  /* Date first, then the 12-hour clock: "Jul 24, 3:44:39 PM". */
  function localDateTime(d) {
    return MONTHS[d.getMonth()] + " " + d.getDate() + ", " + localClock(d);
  }

  /* Clock only. Compact enough for a dense feed column. */
  function fmtTime(ms) {
    if (!isFinite(ms)) return "--:--:--";
    var d = new Date(ms);
    if (timeMode === "raw") {
      return two(d.getUTCHours()) + ":" + two(d.getUTCMinutes()) + ":" + two(d.getUTCSeconds());
    }
    return localClock(d);
  }

  /* The full stamp: in raw mode this is byte-for-byte what the CSV contains. */
  function fmtStamp(ms) {
    if (!isFinite(ms)) return timeMode === "raw" ? "---------T--:--:--Z" : "--";
    var d = new Date(ms);
    if (timeMode === "raw") {
      return d.getUTCFullYear() + "-" + two(d.getUTCMonth() + 1) + "-" + two(d.getUTCDate()) +
        "T" + two(d.getUTCHours()) + ":" + two(d.getUTCMinutes()) + ":" + two(d.getUTCSeconds()) + "Z";
    }
    return localDateTime(d);
  }

  /* Date + time, for rows that can span more than one day. */
  function fmtDate(ms) {
    if (!isFinite(ms)) return "--";
    var d = new Date(ms);
    if (timeMode === "raw") {
      return two(d.getUTCMonth() + 1) + "-" + two(d.getUTCDate()) + " " +
        two(d.getUTCHours()) + ":" + two(d.getUTCMinutes()) + ":" + two(d.getUTCSeconds());
    }
    return localDateTime(d);
  }

  function fmtDur(ms) {
    if (!isFinite(ms)) return "--";
    var neg = ms < 0; ms = Math.abs(ms);
    var s = ms / 1000, out;
    if (s < 1) out = Math.round(ms) + "ms";
    else if (s < 60) out = (s < 10 ? s.toFixed(1).replace(/\.0$/, "") : Math.round(s)) + "s";
    else if (s < 3600) out = Math.floor(s / 60) + "m" + (Math.round(s % 60) ? " " + Math.round(s % 60) + "s" : "");
    else if (s < 86400) out = Math.floor(s / 3600) + "h" + (Math.round(s % 3600 / 60) ? " " + Math.round(s % 3600 / 60) + "m" : "");
    else out = Math.floor(s / 86400) + "d " + Math.round(s % 86400 / 3600) + "h";
    return (neg ? "-" : "") + out;
  }

  function fmtSigned(ms) { return (ms >= 0 ? "+" : "") + fmtDur(ms); }

  /* datetime-local <-> epoch ms, in the viewer's OWN timezone -- which is what
     <input type="datetime-local"> means, and what the rest of the UI now shows.
     These deliberately do NOT follow the raw/local display toggle: the control
     has no way to render a "Z" suffix, so a UTC value in it would silently read
     as local to the browser and shift the window by the offset on every edit. */
  function toLocalInput(ms) {
    if (!isFinite(ms)) return "";
    var d = new Date(ms);
    return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate()) +
      "T" + two(d.getHours()) + ":" + two(d.getMinutes()) + ":" + two(d.getSeconds());
  }

  function fromLocalInput(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v || "");
    if (!m) return NaN;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
  }

  DV.model = {
    build: build,
    parseMs: parseMs, parseTileUrl: parseTileUrl, tileKey: tileKey,
    tileWorld: tileWorld, tileChunk: tileChunk, historicalName: historicalName,
    BLOCKS_PER_TILE: BLOCKS_PER_TILE, RETENTION_MS: RETENTION_MS,
    fmtTime: fmtTime, fmtStamp: fmtStamp, fmtDate: fmtDate, fmtDur: fmtDur, fmtSigned: fmtSigned,
    toLocalInput: toLocalInput, fromLocalInput: fromLocalInput, pct: pct,
    setTimeMode: setTimeMode, getTimeMode: getTimeMode, toggleTimeMode: toggleTimeMode,
    timeZoneName: timeZoneName,
    // Shared sorted-array helpers -- the one implementation for every hot path.
    lowerBound: lowerBound, atOrBefore: atOrBefore, sliceRange: sliceRange
  };
})(window.DV);

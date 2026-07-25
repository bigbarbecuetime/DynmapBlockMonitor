/* ============================================================================
   infer.js -- the two things that go beyond plotting: recovering HEIGHT from the
   isometric maps, and stitching chunk loads into player TRACKS.
   ----------------------------------------------------------------------------
   Both rest on measurements made against this server rather than assumptions;
   the numbers quoted in the comments are reproducible from the logged data.
   ========================================================================= */

window.DV = window.DV || {};

(function (DV) {
  "use strict";

  var M = DV.model;

  /* ==========================================================================
     HEIGHT FROM THE ISOMETRIC MAPS
     --------------------------------------------------------------------------
     A flat overhead tile pins X and Z but says nothing about Y -- it is a
     top-down projection, so a change at y=8 and one at y=200 land on the same
     tile. The isometric maps are shot at inclination 30, which folds height into
     the vertical screen axis, and that is the missing constraint.

     Dynmap gives each map a worldtomap matrix (row-major 3x3):

         mapX = m0*x + m1*y + m2*z
         mapY = m3*x + m4*y + m5*z

     For this server's isometric map "t":
         mapX =  11.3137*x + 0*y - 11.3137*z      <- no y term: fixes x-z only
         mapY =  -5.6569*x + 13.8564*y - 5.6569*z <- y appears HERE

     So once a flat tile has given us x and z to within its 8 blocks, an
     isometric tile confines mapY to its own 128px band, and y is the only
     unknown left:

         y = (mapY + 5.6569*(x + z)) / 13.8564

     Verified against a point whose height is published independently -- the world
     spawn at (-252, 88, 111). Its isometric tile is -33,15; feeding that tile
     plus the flat tile's x/z back through the above yields y in [77.7, 93.5],
     which contains the true 88. Band width ~16 blocks, of which ~9 comes from the
     tile's own 128px height and the rest from the 8-block x/z uncertainty --
     narrowing x/z (by diffing tile images) would tighten it to about 9.

     Requires the tracker to be logging more than one map type (MAP_TYPE="").
     ======================================================================== */

  function tileSizeOf(mapCfg) {
    return 128 << (parseInt(mapCfg.tilescale, 10) || 0);
  }

  /* World point -> tile coordinates on a given map. */
  function worldToTile(mapCfg, x, y, z) {
    var a = mapCfg.worldtomap, s = tileSizeOf(mapCfg);
    var mx = a[0] * x + a[1] * y + a[2] * z;
    var my = a[3] * x + a[4] * y + a[5] * z;
    return { tx: Math.floor(mx / s), tz: Math.floor(my / s) };
  }

  /* The band of heights consistent with an isometric tile, given the x/z box a
     flat tile already established. Returns null when the map carries no height
     information (m4 == 0, i.e. a straight overhead projection). */
  function heightBand(isoCfg, isoTx, isoTz, world) {
    var a = isoCfg.worldtomap, s = tileSizeOf(isoCfg);
    if (!a || Math.abs(a[4]) < 1e-9) return null;
    var lo = Infinity, hi = -Infinity;
    var edges = [isoTz * s, (isoTz + 1) * s];
    // Corners of the flat tile's x/z box, against both edges of the iso band.
    for (var xi = 0; xi < 2; xi++) {
      for (var zi = 0; zi < 2; zi++) {
        var x = xi ? world.x1 : world.x0;
        var z = zi ? world.z1 : world.z0;
        for (var e = 0; e < 2; e++) {
          var y = (edges[e] - a[3] * x - a[5] * z) / a[4];
          if (y < lo) lo = y;
          if (y > hi) hi = y;
        }
      }
    }
    return { yMin: lo, yMax: hi, width: hi - lo };
  }

  /* Pair each flat tile change with isometric changes stamped at nearly the same
     moment, and intersect their height bands. Several isometric maps agreeing
     narrows the answer; one is usually enough to be useful. */
  function inferHeights(model, mapConfigs, opts) {
    opts = opts || {};
    var tolMs = opts.tolMs === undefined ? 2000 : opts.tolMs;
    var flatName = model.mapType;
    var out = { attempted: 0, resolved: 0, rejected: 0, bands: new Map(), medianWidth: NaN };
    if (!model.allTiles || !mapConfigs) return out;

    // Isometric maps only: a second overhead map adds no height information.
    var isoNames = Object.keys(mapConfigs).filter(function (n) {
      var c = mapConfigs[n];
      return n !== flatName && c.worldtomap && Math.abs(c.worldtomap[4]) > 1e-9;
    });
    if (!isoNames.length) return out;

    var byTime = new Map();
    model.allTiles.forEach(function (t) {
      if (isoNames.indexOf(t.map) < 0) return;
      var k = Math.round(t.rawTileMs / 1000);
      if (!byTime.has(k)) byTime.set(k, []);
      byTime.get(k).push(t);
    });

    var widths = [];
    model.tiles.forEach(function (t) {
      out.attempted++;
      var sec = Math.round(t.rawTileMs / 1000);
      var span = Math.ceil(tolMs / 1000);
      var world = M.tileWorld(t.tx, t.tz, model.blocksPerTile);
      var lo = -Infinity, hi = Infinity, used = 0;
      for (var d = -span; d <= span; d++) {
        var bucket = byTime.get(sec + d);
        if (!bucket) continue;
        for (var i = 0; i < bucket.length; i++) {
          var iso = bucket[i];
          var band = heightBand(mapConfigs[iso.map], iso.tx, iso.tz, world);
          if (!band) continue;
          /* Only accept an isometric tile whose x-z constraint is consistent with
             this flat tile; otherwise we would be intersecting bands from two
             unrelated changes that merely happened at the same second. */
          if (!consistentXZ(mapConfigs[iso.map], iso, world)) continue;
          lo = Math.max(lo, band.yMin);
          hi = Math.min(hi, band.yMax);
          used++;
        }
      }
      /* Reject bands that fall outside the world's build range. Two changes can
         coincide in time without being the same change, and the x-z check above
         only constrains one axis -- a wrong pairing shows up as a height no block
         can occupy (a band at y -200 was the tell). Better to say nothing than to
         report a confident impossibility. */
      var yFloor = opts.yMin === undefined ? -64 : opts.yMin;
      var yCeil = opts.yMax === undefined ? 320 : opts.yMax;
      if (used && lo <= hi && hi >= yFloor && lo <= yCeil) {
        out.resolved++;
        widths.push(hi - lo);
        out.bands.set(t.i, { yMin: Math.max(lo, yFloor), yMax: Math.min(hi, yCeil), sources: used });
      } else if (used) {
        out.rejected++;
      }
    });
    widths.sort(function (a, b) { return a - b; });
    out.medianWidth = widths.length ? widths[widths.length >> 1] : NaN;
    return out;
  }

  /* Does this isometric tile's mapX band overlap the flat tile's x-z box at any
     plausible height? mapX has no y term on these projections, so this is a clean
     independent check. */
  function consistentXZ(isoCfg, isoTile, world) {
    var a = isoCfg.worldtomap, s = tileSizeOf(isoCfg);
    var lo = isoTile.tx * s, hi = lo + s;
    var mn = Infinity, mx = -Infinity;
    for (var xi = 0; xi < 2; xi++) {
      for (var zi = 0; zi < 2; zi++) {
        var v = a[0] * (xi ? world.x1 : world.x0) + a[2] * (zi ? world.z1 : world.z0);
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
    return mx >= lo && mn <= hi;
  }

  /* ==========================================================================
     PLAYER TRACKS
     --------------------------------------------------------------------------
     Chunk loads are the movement signal. Dynmap redraws a chunk when it is
     loaded, which is what happens as a player walks into new terrain -- and the
     classification in model.js already separates those from likely block edits.

     What does NOT work, and is worth writing down because it looks like it
     should: reading direction out of the emission order. Tiles arrive from the
     feed sorted by ascending x -- within a single second of tile_ts, where time
     cannot explain the ordering, x is perfectly ascending in 92% of polls. That
     is Dynmap's render queue iterating its dirty set in coordinate order, not
     players moving east. Any tracker built on emission order measures the
     server's for-loop.

     What does work is proximity in space and time. A player generates loads in a
     connected chain: successive loads are close together and close in time,
     while two players on opposite sides of the map are not. So link greedily --
     attach each load to the nearest open track within a distance and time gate,
     otherwise start a new one. The player roster then acts as the check: the
     number of concurrent tracks should track the number of people online, and
     that is a falsifiable prediction rather than a picture.
     ======================================================================== */

  function buildTracks(model, opts) {
    opts = opts || {};
    var maxGapMs = opts.maxGapMs === undefined ? 45000 : opts.maxGapMs;
    var maxDist = opts.maxDist === undefined ? 24 : opts.maxDist;   // tiles
    var minPoints = opts.minPoints === undefined ? 4 : opts.minPoints;
    var from = opts.from === undefined ? -Infinity : opts.from;
    var to = opts.to === undefined ? Infinity : opts.to;
    var kinds = opts.kind || "load";

    var open = [], done = [], nextId = 1;
    var tiles = model.tiles;

    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i];
      if (t.tileMs < from || t.tileMs > to) continue;
      if (kinds !== "all" && t.kind !== kinds) continue;

      // Retire tracks that have gone quiet: they cannot claim this point.
      for (var k = open.length - 1; k >= 0; k--) {
        if (t.tileMs - open[k].lastMs > maxGapMs) { done.push(open[k]); open.splice(k, 1); }
      }

      var best = null, bestD = Infinity;
      for (k = 0; k < open.length; k++) {
        var d = Math.hypot(t.tx - open[k].lastTx, t.tz - open[k].lastTz);
        if (d <= maxDist && d < bestD) { bestD = d; best = open[k]; }
      }
      if (!best) {
        best = { id: nextId++, points: [], startMs: t.tileMs, lastMs: t.tileMs,
                 lastTx: t.tx, lastTz: t.tz, minTx: t.tx, maxTx: t.tx, minTz: t.tz, maxTz: t.tz,
                 dist: 0 };
        open.push(best);
      } else {
        best.dist += bestD;
      }
      best.points.push({ ms: t.tileMs, tx: t.tx, tz: t.tz, online: t.online, roster: t.roster });
      best.lastMs = t.tileMs; best.lastTx = t.tx; best.lastTz = t.tz;
      if (t.tx < best.minTx) best.minTx = t.tx;
      if (t.tx > best.maxTx) best.maxTx = t.tx;
      if (t.tz < best.minTz) best.minTz = t.tz;
      if (t.tz > best.maxTz) best.maxTz = t.tz;
    }
    done = done.concat(open);

    var tracks = done.filter(function (tr) { return tr.points.length >= minPoints; });
    tracks.forEach(function (tr) {
      tr.durationMs = tr.lastMs - tr.startMs;
      tr.spanTiles = Math.hypot(tr.maxTx - tr.minTx, tr.maxTz - tr.minTz);
      var bpt = model.blocksPerTile;
      tr.blocksTravelled = Math.round(tr.dist * bpt);
      tr.speedBlocksPerSec = tr.durationMs > 0 ? tr.blocksTravelled / (tr.durationMs / 1000) : 0;

      /* Attribution, only where the roster permits it. One player online for the
         whole track means the track is theirs; more than one means we can name
         the candidates but not choose between them. */
      var names = new Map(), soloAll = true;
      tr.points.forEach(function (p) {
        if (p.online !== 1) soloAll = false;
        (p.roster || []).forEach(function (n) { names.set(n, (names.get(n) || 0) + 1); });
      });
      tr.candidates = Array.from(names.entries())
        .sort(function (a, b) { return b[1] - a[1]; })
        .map(function (e) { return e[0]; });
      tr.player = (soloAll && tr.candidates.length === 1) ? tr.candidates[0] : null;
      tr.confident = !!tr.player;
    });
    tracks.sort(function (a, b) { return a.startMs - b.startMs; });
    return tracks;
  }

  /* How well does the track count match the number of people actually online?
     This is the honest scoreboard for the linking parameters above: if the two
     disagree badly, the gates are wrong and the tracks are fiction. */
  function scoreTracks(model, tracks, opts) {
    opts = opts || {};
    var stepMs = opts.stepMs || 60000;
    var from = opts.from, to = opts.to;
    if (!isFinite(from) || !isFinite(to)) return null;
    var pts = 0, agree = 0, sumErr = 0, over = 0, under = 0;
    for (var t = from; t <= to; t += stepMs) {
      if (!model.covered(t)) continue;
      var snap = DV.snapshotAt(model, t);
      if (!snap) continue;
      var active = 0;
      for (var i = 0; i < tracks.length; i++) {
        if (tracks[i].startMs <= t && tracks[i].lastMs >= t) active++;
      }
      pts++;
      sumErr += Math.abs(active - snap.count);
      if (active === snap.count) agree++;
      else if (active > snap.count) over++; else under++;
    }
    return pts ? { samples: pts, exact: agree / pts, meanAbsErr: sumErr / pts,
                   overCount: over / pts, underCount: under / pts } : null;
  }

  DV.infer = {
    worldToTile: worldToTile, heightBand: heightBand, inferHeights: inferHeights,
    buildTracks: buildTracks, scoreTracks: scoreTracks
  };
})(window.DV);

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

  /* A loaded tile is NOT where the player is.

     Measured over 42.9h of stretches with exactly one player online: the tiles
     loading in any 30s window sit a median 10.8 tiles (86 blocks, ~5.4 chunks)
     from the centre of the group -- a view-distance disc around the player, not
     a point on their path. And one 8x8 tile stands in for the whole 16x16 chunk
     it belongs to: of the chunks touched, 793 contributed a single tile and only
     12 contributed all four.

     So the player's position is estimated as the CENTROID of the tiles loading in
     a short slice, and the track is the chain of those centroids. Linking raw
     tiles instead makes the path hop back and forth across the disc, which
     inflates the apparent speed -- centroid motion comes out at a median 2.2
     blocks/s (p90 5.8), squarely walking-to-sprinting, whereas tile-to-tile
     linking suggested 3.8-8.5.

     Chunks, not tiles, are counted: two tiles of the same chunk are one load. */
  /* ==========================================================================
     TURNING ANY MAP TYPE'S TILE INTO A WORLD POSITION
     --------------------------------------------------------------------------
     Every map is a linear projection of the world, so each is invertible -- but
     only two of the three world axes are pinned by a 2D tile, and which two
     depends on the projection:

       flat2  mapX = 16x, mapY = -16z          -> x and z directly, y unknown
       t      mapX = 11.31(x-z)                -> pins (x-z) exactly
              mapY = -5.66(x+z) + 13.86y       -> mixes the other axis WITH height

     So an isometric tile fixes one diagonal precisely and leaves the other
     smeared by however wrong the assumed height is. Inverting at a nominal y=64
     still gives a usable position, just a looser one, and the smear is quantified
     here rather than hidden: a height error dy displaces the answer along the
     anti-diagonal by (a4/det)*dy per axis.

     Worth doing because the isometric maps fire far more often than the flat one
     -- 7,388 events to 975 over the same period, since one chunk's projected
     column crosses several isometric tiles -- so they cover moments the flat map
     misses entirely. Flat tiles set position when present; isometric tiles fill
     the gaps, carrying a bigger error bar.
     ======================================================================== */
  function projector(mapCfg, nominalY) {
    var a = mapCfg && mapCfg.worldtomap;
    if (!a) return null;
    var s = tileSizeOf(mapCfg);
    var y = nominalY === undefined ? 64 : nominalY;
    var A = a[0], B = a[2], C = a[3], D = a[5];
    var det = A * D - B * C;
    if (Math.abs(det) < 1e-9) return null;
    // How far a 64-block height error moves the answer, in blocks.
    var smear = Math.abs(a[4] * 64 / det) * Math.max(Math.abs(A), Math.abs(B));
    return {
      smear: smear,
      // Tile centre -> world (x, z) at the nominal height.
      toWorld: function (tx, tz) {
        var mx = (tx + 0.5) * s - a[1] * y;
        var my = (tz + 0.5) * s - a[4] * y;
        return { x: (D * mx - B * my) / det, z: (-C * mx + A * my) / det };
      }
    };
  }

  /* Every logged tile, from every map type, as a world position with an honest
     error bar. Flat tiles are worth ~8 blocks; isometric ones however much the
     height ambiguity smears them. */
  function worldPoints(model, mapConfigs, opts) {
    opts = opts || {};
    var out = [];
    var src = model.allTiles && model.allTiles.length ? model.allTiles : model.tiles;
    var projs = {}, bpt = model.blocksPerTile;
    for (var i = 0; i < src.length; i++) {
      var t = src[i];
      var cfg = mapConfigs ? mapConfigs[t.map] : null;
      /* A tile from a map we cannot project is SKIPPED, never assumed flat.
         Falling through to flat geometry here silently reinterpreted every
         isometric tile as an overhead one -- the coordinates are in a different
         space entirely, so the positions were nonsense and the tracks built on
         them agreed with the player count only 7% of the time, against 36% once
         the projection was applied. Wrong data is worse than less data. */
      if (t.map !== model.mapType && !cfg) continue;
      if (t.map === model.mapType) {
        // The map the model is built on: use the exact tile geometry.
        var w = M.tileWorld(t.tx, t.tz, bpt);
        out.push({ ms: t.tileMs !== undefined ? t.tileMs : t.rawTileMs,
                   x: (w.x0 + w.x1) / 2, z: (w.z0 + w.z1) / 2,
                   err: bpt, map: t.map, kind: t.kind, online: t.online, roster: t.roster });
        continue;
      }
      if (!(t.map in projs)) projs[t.map] = projector(cfg, opts.nominalY);
      var pr = projs[t.map];
      if (!pr) continue;
      var p = pr.toWorld(t.tx, t.tz);
      out.push({ ms: t.tileMs !== undefined ? t.tileMs : (t.rawTileMs - (model.skew ? model.skew.ms : 0)),
                 x: p.x, z: p.z, err: Math.max(bpt, pr.smear), map: t.map,
                 kind: t.kind, online: t.online, roster: t.roster });
    }
    out.sort(function (a, b) { return a.ms - b.ms; });
    return out;
  }

  function buildTracks(model, opts) {
    opts = opts || {};
    /* 60s, not 20s. The calibration session showed why: per-20s-slice centroids
       of a STANDING player hop 100-200 blocks between disc fragments (phantom
       "sprinting"), while per-60s centroids wander only 12-36 blocks. Coarser
       time, but the signal has no better native precision anyway -- and the
       session ground truth scores 60s best on every metric (fewest spurious
       tracks, best roster agreement, no phantom modes). */
    var sliceMs = opts.sliceMs === undefined ? 60000 : opts.sliceMs;
    var maxGapMs = opts.maxGapMs === undefined ? 60000 : opts.maxGapMs;
    // A player cannot cross more than this many tiles between slices. 12 tiles
    // over 20s is ~4.8 blocks/s, near sprinting; boats and elytra get the slack
    // from maxDist scaling with the slice length.
    /* 9 blocks/s of allowed travel between slices: above sprint-jumping (7.1)
       and boats (8), below ice boats and elytra -- those are supposed to break
       the track and surface as events. The old 4.8 b/s cap silently broke tracks
       on an ordinary sprint. */
    var maxStep = opts.maxStep === undefined ? Math.max(64, 9 * (sliceMs / 1000)) : opts.maxStep;
    // Twice the measured load-disc radius (86 blocks), so one player's disc
    // stays whole while two players in different places stay apart.
    var clusterRadius = opts.clusterRadius === undefined ? 176 : opts.clusterRadius;
    var minPoints = opts.minPoints === undefined ? 3 : opts.minPoints;
    var from = opts.from === undefined ? -Infinity : opts.from;
    var to = opts.to === undefined ? Infinity : opts.to;
    var kinds = opts.kind || "load";

    /* ---- 1. slice time, and inside each slice group the loads spatially ---
       Two players in different places produce two discs in the same slice, so a
       slice can yield more than one estimate. Single-linkage at roughly twice the
       view radius keeps one player's disc together without merging two players
       who happen to be loading at the same moment. */
    /* Source points: every map type when a projection table is supplied,
       otherwise just the model's own map. Each carries its own error, so a slice
       fed only by isometric tiles is marked as the looser estimate it is. */
    var pts = opts.worldPoints || worldPoints(model, opts.mapConfigs, opts);
    var nodes = [];
    var i = M.lowerBound(pts, from, "ms");
    var slice = [], sliceStart = null;

    function flushSlice() {
      if (!slice.length) return;
      /* PRECISION FIRST. A flat tile fixes position to 8 blocks; an isometric one
         to about 78, because inverting it needs a height we do not know (verified
         against the world spawn: 38 blocks off at a nominal y=64, 5 blocks off at
         the true height). The isometric maps also fire roughly seven times more
         often, so mixing the two lets the loose majority drag every centroid and
         scatter the clusters -- which is what happened: tracks went to zero.

         So use the precise source when it exists, and fall back to the loose one
         only for moments the flat map missed entirely. That keeps the ~10% extra
         time coverage the isometric maps genuinely add without paying for it in
         position. */
      var precise = [];
      var preciseErr = (model.blocksPerTile || 8) * 2;
      for (var q = 0; q < slice.length; q++) if (slice[q].err <= preciseErr) precise.push(slice[q]);
      var use = precise.length ? precise : slice;
      var groups = clusterTiles(use, clusterRadius);
      var looseOnly = !precise.length;
      for (var g = 0; g < groups.length; g++) {
        var grp = groups[g];
        /* Centre of the EXTENT, not of the density.

           A render does not mean "a player was here". Dynmap announces a tile
           only when its image actually changed -- IsoHDPerspective.java pushes
           the client update inside `if (mtile.matchesHashCode(crc) == false)`
           -- and what triggers a render is a block event, never a chunk load:
           the shipped render-triggers are blockplaced, blockbreak, leavesdecay,
           blockburn, chunkgenerated, blockformed, blockfaded, blockspread,
           pistonmoved, explosion, structuregrow and blockgrow. Block events only
           fire in LOADED chunks, so the player's part is holding chunks loaded
           while mobs and growth decide what changes inside them. Renders pile up
           wherever something grows or decays inside the loaded disc and stop
           dead where nothing does.

           At the calibration spot that terrain was a dark-oak forest to the
           north; the open stone the player actually stood on has not re-rendered
           since January. Averaging the renders therefore walks the estimate into
           the forest -- 102/112/143 blocks off the three known positions. The
           disc, though, is still centred on the player, so take the middle of
           the span the renders cover rather than their centre of mass: 63/64/101
           blocks off, and X lands within 2 blocks twice (2172 vs 2174, 2124 vs
           2122). What is left is nearly pure Z, the south half of the disc being
           clipped by ground too barren to ever report.

           Trimming the span to 5-95% is worse (106 blocks), not better -- the
           extreme points are exactly the ones that pin the disc edge. */
        var chunks = new Map(), maps = {};
        var sw = 0;
        var minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (var k = 0; k < grp.length; k++) {
          sw += 1 / Math.max(1, grp[k].err * grp[k].err);
          if (grp[k].x < minX) minX = grp[k].x;
          if (grp[k].x > maxX) maxX = grp[k].x;
          if (grp[k].z < minZ) minZ = grp[k].z;
          if (grp[k].z > maxZ) maxZ = grp[k].z;
          chunks.set(Math.floor(grp[k].x / 16) + "," + Math.floor(grp[k].z / 16), true);
          maps[grp[k].map] = (maps[grp[k].map] || 0) + 1;
        }
        var cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
        var rad = 0;
        for (k = 0; k < grp.length; k++) rad += Math.hypot(grp[k].x - cx, grp[k].z - cz);
        nodes.push({
          ms: sliceStart + sliceMs / 2, cx: cx, cz: cz,      // WORLD blocks
          tiles: grp.length, chunks: chunks.size, maps: maps,
          radius: grp.length ? rad / grp.length : 0,          // blocks
          /* NOT the formal sqrt(1/sum-weights): that says 2 blocks with fifteen
             8-block tiles, while the three known positions of the calibration
             session land 63-101 blocks from the extent centre. The renders are
             not scattered evenly around the player -- they follow whatever
             terrain is tickable inside the loaded disc -- so the bias does not
             shrink with more samples. The honest uncertainty is tied to the disc
             radius itself. */
          err: Math.max(Math.sqrt(1 / sw), (grp.length ? rad / grp.length : 0) * 0.6, 12),
          loose: looseOnly,
          online: grp[grp.length - 1].online, roster: grp[grp.length - 1].roster
        });
      }
      slice = [];
    }

    for (; i < pts.length; i++) {
      var t = pts[i];
      if (t.ms > to) break;
      if (kinds !== "all" && t.kind && t.kind !== kinds) continue;
      // .ms, not .tileMs: these are world points from any map, not flat tiles.
      var bucket = Math.floor(t.ms / sliceMs) * sliceMs;
      if (sliceStart === null) sliceStart = bucket;
      if (bucket !== sliceStart) { flushSlice(); sliceStart = bucket; }
      slice.push(t);
    }
    flushSlice();

    /* ---- 2. link centroids across slices into tracks ------------------- */
    var open = [], done = [], nextId = 1;
    for (var n = 0; n < nodes.length; n++) {
      var nd = nodes[n];
      for (var k2 = open.length - 1; k2 >= 0; k2--) {
        if (nd.ms - open[k2].lastMs > maxGapMs) { done.push(open[k2]); open.splice(k2, 1); }
      }
      /* Linking is O(nodes x open). If a pathological input leaves hundreds of
         tracks open at once the whole build crawls, so retire the stalest rather
         than degrade without saying why. */
      if (open.length > 64) {
        open.sort(function (x, y) { return x.lastMs - y.lastMs; });
        while (open.length > 64) done.push(open.shift());
      }
      var best = null, bestD = Infinity;
      for (k2 = 0; k2 < open.length; k2++) {
        var elapsed = Math.max(1, (nd.ms - open[k2].lastMs) / sliceMs);
        var d = Math.hypot(nd.cx - open[k2].lastTx, nd.cz - open[k2].lastTz);
        if (d <= maxStep * elapsed && d < bestD) { bestD = d; best = open[k2]; }
      }
      if (!best) {
        best = { id: nextId++, points: [], startMs: nd.ms, lastMs: nd.ms,
                 lastTx: nd.cx, lastTz: nd.cz, minTx: nd.cx, maxTx: nd.cx,
                 minTz: nd.cz, maxTz: nd.cz, dist: 0, chunks: 0 };
        open.push(best);
      } else {
        best.dist += bestD;
      }
      best.points.push({ ms: nd.ms, tx: nd.cx, tz: nd.cz, radius: nd.radius, err: nd.err,
                         chunks: nd.chunks, online: nd.online, roster: nd.roster });
      best.chunks += nd.chunks;
      best.lastMs = nd.ms; best.lastTx = nd.cx; best.lastTz = nd.cz;
      if (nd.cx < best.minTx) best.minTx = nd.cx;
      if (nd.cx > best.maxTx) best.maxTx = nd.cx;
      if (nd.cz < best.minTz) best.minTz = nd.cz;
      if (nd.cz > best.maxTz) best.maxTz = nd.cz;
    }
    done = done.concat(open);

    /* MERGE PARALLEL TRACKS. One player's load disc is sparse -- a 20s slice
       holds a median of four tiles spread across a couple of hundred blocks --
       so single-linkage inside a slice often splits the disc into fragments, and
       the linker then runs several tracks side by side through the same area at
       the same time. The calibration session made it concrete: one player
       standing still produced FOUR overlapping tracks. Two tracks that overlap
       in time with mean positions inside one cluster radius are the same disc,
       so fold them together. Two players genuinely that close are one track
       anyway -- this signal cannot tell them apart, and pretending otherwise is
       how you get five tracks for three players. */
    function meanPos(tr) {
      // Cached: the merge loop reads means inside an O(n^2) pair scan, and
      // recomputing over the full point list each time made the whole build
      // forty times slower than the linking it was cleaning up after.
      if (!tr._mean) {
        var sx = 0, sz = 0;
        for (var q = 0; q < tr.points.length; q++) { sx += tr.points[q].tx; sz += tr.points[q].tz; }
        tr._mean = { x: sx / tr.points.length, z: sz / tr.points.length };
      }
      return tr._mean;
    }
    var merged = true;
    while (merged) {
      merged = false;
      for (var a2 = 0; a2 < done.length; a2++) {
        for (var b2 = a2 + 1; b2 < done.length; b2++) {
          var A = done[a2], B = done[b2];
          var overlap = Math.min(A.lastMs, B.lastMs) - Math.max(A.startMs, B.startMs);
          if (overlap <= 0) continue;
          var pa = meanPos(A), pb = meanPos(B);
          if (Math.hypot(pa.x - pb.x, pa.z - pb.z) > clusterRadius) continue;
          // fold B into A and recompute everything derived from the points
          A.points = A.points.concat(B.points).sort(function (u, v) { return u.ms - v.ms; });
          /* Fragments from one build share slice midpoints, so after the sort the
             merged list holds PAIRS at the same instant. Left alone they zigzag
             the distance sum (the path would hop fragment-to-fragment every
             slice); coalesce same-instant points into one err-weighted estimate
             instead. */
          var co = [];
          for (var q3 = 0; q3 < A.points.length; q3++) {
            var last = co[co.length - 1];
            if (last && A.points[q3].ms === last.ms) {
              var w1 = 1 / Math.max(1, last.err * last.err);
              var w2 = 1 / Math.max(1, A.points[q3].err * A.points[q3].err);
              last.tx = (last.tx * w1 + A.points[q3].tx * w2) / (w1 + w2);
              last.tz = (last.tz * w1 + A.points[q3].tz * w2) / (w1 + w2);
              last.radius = Math.max(last.radius || 0, A.points[q3].radius || 0,
                                     Math.hypot(last.tx - A.points[q3].tx, last.tz - A.points[q3].tz));
              last.err = Math.max(last.err, A.points[q3].err);
              last.chunks = (last.chunks || 0) + (A.points[q3].chunks || 0);
            } else {
              co.push(A.points[q3]);
            }
          }
          A.points = co;
          A._mean = null;
          A.startMs = A.points[0].ms;
          A.lastMs = A.points[A.points.length - 1].ms;
          A.lastTx = A.points[A.points.length - 1].tx;
          A.lastTz = A.points[A.points.length - 1].tz;
          A.chunks += B.chunks;
          A.minTx = Math.min(A.minTx, B.minTx); A.maxTx = Math.max(A.maxTx, B.maxTx);
          A.minTz = Math.min(A.minTz, B.minTz); A.maxTz = Math.max(A.maxTz, B.maxTz);
          A.dist = 0;
          for (var q2 = 1; q2 < A.points.length; q2++) {
            A.dist += Math.hypot(A.points[q2].tx - A.points[q2 - 1].tx,
                                 A.points[q2].tz - A.points[q2 - 1].tz);
          }
          done.splice(b2, 1);
          merged = true;
          b2--;               // keep scanning against the grown A in place --
          continue;           // restarting the whole sweep per merge was O(n^3)
        }
      }
    }

    var tracks = done.filter(function (tr) { return tr.points.length >= minPoints; });
    tracks.forEach(function (tr) {
      tr.durationMs = tr.lastMs - tr.startMs;
      tr.spanTiles = Math.hypot(tr.maxTx - tr.minTx, tr.maxTz - tr.minTz);
      var bpt = model.blocksPerTile;
      tr.blocksTravelled = Math.round(tr.dist);
      // The disc the loads sat in, in blocks -- roughly the render distance, and
      // the honest error bar on any single position estimate along this path.
      var rsum = 0;
      tr.points.forEach(function (p) { rsum += (p.radius || 0); });
      tr.loadRadiusBlocks = Math.round(rsum / tr.points.length);
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
    /* SECOND TIER: attribution by timing. A player's loads start shortly after
       they join -- measured on the calibration session, the first cluster load
       came 51s and 73s after the two joins -- so a track that begins inside a
       few minutes of exactly one join very probably belongs to that joiner.
       Each join can spawn only one track (consumed in start order), the name
       must actually appear in the track's roster window, and the result is
       marked uncertain: timing is evidence, not proof. */
    tracks.sort(function (a, b) { return a.startMs - b.startMs; });
    var joins = (model.transitions || []).filter(function (t) { return t.type === "join"; });
    var usedJoin = new Set();
    tracks.forEach(function (tr) {
      if (tr.player) return;
      var cands = [];
      for (var j = 0; j < joins.length; j++) {
        if (usedJoin.has(j)) continue;
        var J = joins[j];
        // start may precede the join by up to half a slice (midpoint timestamps)
        if (tr.startMs >= J.ms - sliceMs * 0.75 && tr.startMs <= J.ms + 240000 &&
            tr.candidates.indexOf(J.player) >= 0) {
          cands.push(j);
        }
      }
      if (cands.length === 1) {
        usedJoin.add(cands[0]);
        tr.player = joins[cands[0]].player;
        tr.confident = false;
        tr.attribution = "join-timing (+" +
          Math.max(0, Math.round((tr.startMs - joins[cands[0]].ms) / 1000)) + "s after their join)";
      }
    });

    // Label every leg and lift the impossible ones out as events.
    tracks.forEach(function (tr) { annotateTrack(tr, model, opts); });
    return tracks;
  }

  /* Single-linkage grouping within one time slice. Cheap (slices hold a handful
     of tiles) and it does the one job needed: keep a player's disc together
     without merging two players who loaded at the same moment. */
  function clusterTiles(pts, radius) {
    var groups = [];
    for (var i = 0; i < pts.length; i++) {
      var hit = [];
      for (var g = 0; g < groups.length; g++) {
        for (var j = 0; j < groups[g].length; j++) {
          if (Math.hypot(pts[i].x - groups[g][j].x, pts[i].z - groups[g][j].z) <= radius) {
            hit.push(g); break;
          }
        }
      }
      if (!hit.length) { groups.push([pts[i]]); continue; }
      groups[hit[0]].push(pts[i]);
      // this point bridges several groups: merge them
      for (var h = hit.length - 1; h >= 1; h--) {
        groups[hit[0]] = groups[hit[0]].concat(groups[hit[h]]);
        groups.splice(hit[h], 1);
      }
    }
    return groups;
  }

  /* ==========================================================================
     HOW a player moved, and the EVENTS between
     --------------------------------------------------------------------------
     Speeds are measured, not assumed. Over 42.7h of single-player stretches the
     centroid-to-centroid speed distribution came out:

         p10 0.9 | p25 2.4 | p50 4.5 | p75 7.3 | p90 10.6 | p95 16.5 | p99 129

     The median of 4.5 blocks/s is Minecraft's walking speed (4.317), which is
     the strongest evidence available that these paths are real movement and not
     an artefact. The bands below are cut at the game's own speeds.

     The 1% above 80 b/s cannot be a player moving through the overworld at all,
     so it is an EVENT rather than travel. Two kinds are distinguishable:

       * dimension change -- loads stop entirely, then resume far away. The
         nether is 8:1, so a 500-block overworld jump is only ~60 blocks walked;
         of the 7 such reappearances in this data the implied nether speed is
         3.1 b/s, i.e. an ordinary walk. Overworld loads stop because the player
         is not in the overworld to cause any.
       * teleport -- a jump with no gap in loading. An ender pearl is capped at
         about 50 blocks, so a long instant jump is a command or a portal pair.

     And a player standing still generates NO loads: only 71% of 20s slices in a
     solo stretch contain any. Silence is therefore information, and the gap is
     labelled "stationary" rather than being drawn as a straight line across the
     map to wherever they turned up next.
     ======================================================================== */

  var MODES = [
    { name: "stationary", max: 1.0,  note: "not moving; the loads are the edge of the disc flickering" },
    { name: "walking",    max: 5.0,  note: "walking is 4.3 blocks/s" },
    { name: "sprinting",  max: 8.0,  note: "sprinting 5.6, sprint-jumping ~7.1" },
    { name: "horse/boat", max: 15.0, note: "boat 8, horse up to ~14" },
    { name: "fast",       max: 80.0, note: "ice boat or elytra" },
    { name: "event",      max: Infinity, note: "faster than anything on foot: a teleport or a dimension change" }
  ];
  // Not a speed band: assigned when loading stopped long enough that we simply
  // did not observe the movement, however ordinary it may have been.
  var UNOBSERVED = { name: "unobserved", note: "no loads for a while -- they were still, elsewhere, or in another dimension" };

  function classifySpeed(bps) {
    for (var i = 0; i < MODES.length; i++) if (bps < MODES[i].max) return MODES[i].name;
    return "event";
  }

  /* Walk a track's points and label each leg, turning the impossible ones into
     events. `portals` (from the Nelt tables, in NETHER coordinates) lets a
     dimension change name the portal it probably came out of. */
  function annotateTrack(tr, model, opts) {
    opts = opts || {};
    var bpt = model.blocksPerTile;
    // A leg one slice long is continuous observation, not a gap; the threshold
    // must scale with the slicing or coarser slices turn all walking into
    // "unobserved" (measured: 67% of all time, walking 0%).
    var slice = opts.sliceMs === undefined ? 60000 : opts.sliceMs;
    var gapMs = opts.stationaryGapMs === undefined ? Math.max(45000, slice * 1.75) : opts.stationaryGapMs;
    var portals = opts.portals || null;
    var legs = [], events = [], modeTime = {};

    for (var i = 1; i < tr.points.length; i++) {
      var a = tr.points[i - 1], b = tr.points[i];
      var dt = (b.ms - a.ms) / 1000;
      var dist = Math.hypot(b.tx - a.tx, b.tz - a.tz);   // already blocks
      if (dt <= 0) continue;
      var bps = dist / dt;
      var gapped = (b.ms - a.ms) > gapMs;

      /* RESOLUTION LIMIT, measured not assumed. In the calibration session the
         centroid of a STANDING player's loads wandered 12-36 blocks per minute,
         and a real 52-block sprint plus a 64-block walk both stayed inside that
         noise -- movement smaller than the combined position error of the two
         estimates is indistinguishable from standing still. So a leg is only
         called movement when the displacement clears that bar; below it, the
         honest label is stationary, whatever the raw speed arithmetic says. */
      var sig = Math.max(24, Math.hypot(a.err || 0, b.err || 0));
      if (dist < sig && bps < 80) {
        legs.push({ ms: a.ms, mode: "stationary", bps: bps, blocks: Math.round(dist), belowNoise: true });
        modeTime.stationary = (modeTime.stationary || 0) + dt;
        continue;
      }

      /* Only an IMPOSSIBLE speed is an event. A gap on its own is not: losing
         sight of someone for a minute while they walk 70 blocks is just a quiet
         minute, and calling that a dimension change (an earlier version did)
         labelled a quarter of all track time as teleporting. What a gap does
         cost is certainty -- we did not see how they got there -- so a plausible
         move across a gap is "unobserved" rather than a claim about walking. */
      var mode;
      if (bps >= 80) mode = "event";
      else if (gapped) mode = (dist < bpt * 2) ? "stationary" : "unobserved";
      else mode = classifySpeed(bps);

      if (mode === "event") {
        var ev = {
          ms: a.ms, endMs: b.ms, fromTx: a.tx, fromTz: a.tz, toTx: b.tx, toTz: b.tz,
          blocks: Math.round(dist), gapSec: Math.round(dt), bps: bps,
          kind: gapped ? "dimension" : "teleport"
        };
        /* Through the nether the same journey is an eighth as far. That only
           EXPLAINS the jump if the implied nether pace is itself a pace someone
           could travel at -- too slow and they never needed the nether, too fast
           and the nether does not account for it either. */
        ev.netherBps = (dist / 8) / dt;
        if (ev.kind === "dimension" && ev.netherBps >= 2 && ev.netherBps <= 40) {
          ev.explains = "consistent with the nether at " + ev.netherBps.toFixed(1) +
            " blocks/s (8:1, so " + Math.round(dist / 8) + " blocks travelled there)";
        }
        if (dist <= 50 && dt < 5) { ev.kind = "pearl"; ev.explains = "within ender-pearl range"; }
        if (portals) {
          ev.nearestPortal = nearestPortal(portals, b.tx, b.tz);
          if (ev.nearestPortal && ev.nearestPortal.distBlocks <= PORTAL_CONFIRM_BLOCKS) {
            ev.explains = (ev.explains ? ev.explains + "; " : "") +
              "arrives " + Math.round(ev.nearestPortal.distBlocks) + " blocks from the public portal \"" +
              ev.nearestPortal.name + "\"";
          }
        }
        events.push(ev);
      }
      legs.push({ ms: a.ms, mode: mode, bps: bps, blocks: Math.round(dist) });
      modeTime[mode] = (modeTime[mode] || 0) + dt;
    }

    tr.legs = legs;
    tr.events = events;
    tr.modeTime = modeTime;
    var best = null;
    for (var m in modeTime) if (!best || modeTime[m] > modeTime[best]) best = m;
    tr.dominantMode = best || "stationary";
    // Time actually spent moving, as opposed to elapsed.
    tr.movingSec = 0;
    for (m in modeTime) if (m !== "stationary" && m !== "event" && m !== "unobserved") tr.movingSec += modeTime[m];
    return tr;
  }

  /* Events happen BETWEEN tracks, not inside them.

     The linker refuses to join two centroids further apart than a player could
     travel, so a teleport or a nether crossing does not appear as a fast leg --
     it ends one track and starts another. Looking for events only inside tracks
     therefore finds none by construction, which is exactly what the first
     version did. So pair up consecutive tracks that could belong to the same
     player and ask whether the jump between them needs explaining. */
  function linkEvents(tracks, model, opts) {
    opts = opts || {};
    var bpt = model.blocksPerTile;
    var maxGapMs = opts.eventGapMs === undefined ? 600000 : opts.eventGapMs;  // 10 min
    var portals = opts.portals || null;
    var out = [];

    var byStart = tracks.slice().sort(function (a, b) { return a.startMs - b.startMs; });
    for (var i = 0; i < byStart.length; i++) {
      var a = byStart[i];
      var best = null;
      for (var j = i + 1; j < byStart.length; j++) {
        var b = byStart[j];
        if (b.startMs < a.lastMs) continue;
        if (b.startMs - a.lastMs > maxGapMs) break;
        // Same player, as far as the roster can say. If either end is
        // unattributed, fall back to requiring that no one else was online.
        if (a.player && b.player && a.player !== b.player) continue;
        if (!best || b.startMs < best.startMs) best = b;
      }
      if (!best) continue;

      var dt = (best.startMs - a.lastMs) / 1000;
      var dist = Math.hypot(best.points[0].tx - a.lastTx, best.points[0].tz - a.lastTz);
      if (dt <= 0) continue;
      var bps = dist / dt;
      // A plausible walk across the gap needs no special explanation.
      if (bps < 8 && dist < 512) continue;

      var ev = {
        ms: a.lastMs, endMs: best.startMs, gapSec: Math.round(dt),
        fromTx: a.lastTx, fromTz: a.lastTz, toTx: best.points[0].tx, toTz: best.points[0].tz,
        blocks: Math.round(dist), bps: bps,
        fromTrack: a.id, toTrack: best.id,
        player: a.player || best.player || null,
        kind: bps >= 80 ? "teleport" : "dimension"
      };
      ev.netherBps = (dist / 8) / dt;
      if (ev.netherBps >= 2 && ev.netherBps <= 40) {
        ev.kind = "dimension";
        ev.explains = "consistent with the nether at " + ev.netherBps.toFixed(1) +
          " blocks/s (8:1, so about " + Math.round(dist / 8) + " blocks travelled there)";
      } else if (bps >= 80) {
        ev.explains = dist <= 50 ? "within ender-pearl range"
                                 : "too fast for any overworld travel; a portal pair or a command";
        if (dist <= 50) ev.kind = "pearl";
      }
      if (portals) {
        var pFrom = nearestPortal(portals, a.lastTx, a.lastTz);
        var pTo = nearestPortal(portals, ev.toTx, ev.toTz);
        ev.portalFrom = pFrom; ev.portalTo = pTo;
        /* Both ends near a public portal is the strongest confirmation available
           without server logs: the player vanished by one and reappeared by
           another, which is what using the highway looks like from outside. */
        /* Only claim a portal when the player really was AT it: within 16 blocks,
           and with a position estimate good enough for 16 blocks to mean
           something. At the 256 blocks this used, half the map qualifies and
           several portals are usually in range at once -- it named a portal for
           92 events on coincidence alone. */
        var errFrom = positionError(a.points[a.points.length - 1]);
        var errTo = positionError(best.points[0]);
        ev.posErrorBlocks = Math.round(Math.max(errFrom, errTo));
        var sureFrom = pFrom && pFrom.distBlocks <= PORTAL_CONFIRM_BLOCKS && errFrom <= PORTAL_CONFIRM_BLOCKS;
        var sureTo = pTo && pTo.distBlocks <= PORTAL_CONFIRM_BLOCKS && errTo <= PORTAL_CONFIRM_BLOCKS;
        if (sureFrom && sureTo) {
          ev.kind = "portal";
          ev.explains = "left \"" + pFrom.name + "\" and arrived at \"" + pTo.name +
            "\" (" + Math.round(pFrom.distBlocks) + " and " + Math.round(pTo.distBlocks) + " blocks away)";
        } else if (sureTo) {
          ev.explains = (ev.explains ? ev.explains + "; " : "") +
            "arrives " + Math.round(pTo.distBlocks) + " blocks from the public portal \"" + pTo.name + "\"";
        }
      }
      out.push(ev);
    }
    return out;
  }

  /* Nelt portals are published in NETHER coordinates; the overworld position is
     eight times that. */
  function nearestPortal(portals, wx, wz) {
    var best = null;
    for (var i = 0; i < portals.length; i++) {
      var p = portals[i];
      var ox = p.x * 8, oz = p.z * 8;
      var d = Math.hypot(ox - wx, oz - wz);
      if (!best || d < best.distBlocks) best = { name: p.name, x: ox, z: oz, distBlocks: d, entity: p.entity };
    }
    return best;
  }

  /* How close a player must be before we will say they used a given portal.
     A portal is a single block: standing "near" one at 256 blocks means nothing,
     and at that range several portals are usually in reach anyway. */
  var PORTAL_CONFIRM_BLOCKS = 16;

  /* Our position estimate is the centroid of a disc of loaded chunks, so it
     carries real error. Claiming a 16-block coincidence is only honest when the
     estimate is itself good to about that, which needs enough loads to average
     the disc down. */
  function positionError(point) {
    if (point && point.err) return point.err;
    var r = (point && point.radius) || 0;              // blocks
    return Math.max(12, r * 0.6);
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

  /* Parse the Nelt tables (tab separated, nether coordinates). */

  function splitLines(text) {
    return String(text).split("\n").map(function (l) {
      return l.charAt(l.length - 1) === "\r" ? l.slice(0, -1) : l;
    }).filter(function (l) { return l.trim(); });
  }

  function parsePortals(tsv) {
    var lines = splitLines(tsv);
    if (!lines.length) return [];
    var head = lines[0].split("	");
    var iName = head.indexOf("Name"), iX = head.indexOf("X"), iZ = head.indexOf("Z");
    var iEnt = head.indexOf("Political Entity"), iHide = head.indexOf("Hide");
    var out = [];
    for (var i = 1; i < lines.length; i++) {
      var c = lines[i].split("	");
      if (iHide >= 0 && c[iHide] === "1") continue;
      var x = parseInt(c[iX], 10), z = parseInt(c[iZ], 10);
      if (isNaN(x) || isNaN(z)) continue;
      out.push({ name: c[iName] || "?", x: x, z: z, entity: iEnt >= 0 ? c[iEnt] : "" });
    }
    return out;
  }

  function parseHighways(tsv) {
    var lines = splitLines(tsv);
    if (!lines.length) return [];
    var head = lines[0].split("	");
    function idx(n) { return head.indexOf(n); }
    var i1 = idx("X Position 1"), j1 = idx("Z Position 1"), i2 = idx("X Position 2"), j2 = idx("Z Position 2");
    var iId = idx("ID"), iMain = idx("Main");
    var out = [];
    for (var i = 1; i < lines.length; i++) {
      var c = lines[i].split("	");
      var a = parseInt(c[i1], 10), b = parseInt(c[j1], 10), d = parseInt(c[i2], 10), e = parseInt(c[j2], 10);
      if ([a, b, d, e].some(isNaN)) continue;
      out.push({ x1: a, z1: b, x2: d, z2: e, id: c[iId] || "", main: c[iMain] === "1" });
    }
    return out;
  }

  DV.infer = {
    worldToTile: worldToTile, worldPoints: worldPoints, projector: projector, heightBand: heightBand, inferHeights: inferHeights,
    buildTracks: buildTracks, scoreTracks: scoreTracks,
    annotateTrack: annotateTrack, classifySpeed: classifySpeed, MODES: MODES,
    nearestPortal: nearestPortal, parsePortals: parsePortals, parseHighways: parseHighways,
    linkEvents: linkEvents
  };
})(window.DV);

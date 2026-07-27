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
    markFresh(out, opts.chunkHoldMs);
    return out;
  }

  /* ==========================================================================
     A CHUNK LOADING IS NEWS; A CHUNK STAYING LOADED IS NOT
     --------------------------------------------------------------------------
     Renders only fire in LOADED chunks, so a render says "this chunk was
     loaded" -- but that is a state, not an event, and only the moment it
     BECAME loaded locates anybody. A chunk held loaded for an hour keeps
     re-rendering as things grow and decay inside it, from a spot the player
     left long ago.

     The two populations are cleanly separated in this log. Splitting each
     chunk's renders into visits at a 5-minute gap gives 19,428 visits over
     34,256 flat tiles, and 75% of those visits are a SINGLE render lasting
     0-3s: a player passed through, the chunk drew once, done. The tail is the
     other thing entirely -- p90 is 267s and p99 is 1,110s of continuous
     re-rendering from one chunk.

     So each point is marked with whether its chunk was already loaded. Keyed
     per map type, because the five maps each render the same physical chunk
     independently and would otherwise mark each other as repeats.
     ======================================================================== */
  var CHUNK_HOLD_MS = 300000;

  function markFresh(pts, holdMs) {
    var hold = holdMs === undefined ? CHUNK_HOLD_MS : holdMs;
    var last = new Map();
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      var k = p.map + "|" + Math.floor(p.x / 16) + "," + Math.floor(p.z / 16);
      var prev = last.get(k);
      p.fresh = prev === undefined || (p.ms - prev) > hold;
      last.set(k, p.ms);
    }
    return pts;
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
        var chunks = new Map(), fresh = new Map(), maps = {};
        var sw = 0;
        var minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (var k = 0; k < grp.length; k++) {
          sw += 1 / Math.max(1, grp[k].err * grp[k].err);
          if (grp[k].x < minX) minX = grp[k].x;
          if (grp[k].x > maxX) maxX = grp[k].x;
          if (grp[k].z < minZ) minZ = grp[k].z;
          if (grp[k].z > maxZ) maxZ = grp[k].z;
          var ck = Math.floor(grp[k].x / 16) + "," + Math.floor(grp[k].z / 16);
          chunks.set(ck, true);
          if (grp[k].fresh) fresh.set(ck, true);
          maps[grp[k].map] = (maps[grp[k].map] || 0) + 1;
        }
        var cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
        var rad = 0;
        for (k = 0; k < grp.length; k++) rad += Math.hypot(grp[k].x - cx, grp[k].z - cz);
        nodes.push({
          ms: sliceStart + sliceMs / 2, cx: cx, cz: cz,      // WORLD blocks
          tiles: grp.length, chunks: chunks.size, maps: maps,
          // Chunks that went from unloaded to loaded here -- the moving edge of
          // somebody's view distance, as opposed to ground already held open.
          frontier: fresh.size, chunkKeys: Array.from(chunks.keys()),
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

    /* ---- 1b. throw out the ground that is merely being held open ------- */
    var held = findHeldSites(nodes, clusterRadius, opts, sliceMs);
    nodes = held.nodes;

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
        /* Held ground never joins a journey. Without this the linker happily
           steps farm -> player -> farm, which is where the 1,100-block minute
           legs came from: it is not that the gate was too loose, it is that one
           of the two endpoints was never a person. A held track may only extend
           itself, and only within its own site. */
        if (!!open[k2].held !== !!nd.held) continue;
        if (nd.held && open[k2].episode !== nd.episode) continue;
        var elapsed = Math.max(1, (nd.ms - open[k2].lastMs) / sliceMs);
        var d = Math.hypot(nd.cx - open[k2].lastTx, nd.cz - open[k2].lastTz);
        if (d <= maxStep * elapsed && d < bestD) { bestD = d; best = open[k2]; }
      }
      if (!best) {
        best = { id: nextId++, points: [], startMs: nd.ms, lastMs: nd.ms,
                 lastTx: nd.cx, lastTz: nd.cz, minTx: nd.cx, maxTx: nd.cx,
                 minTz: nd.cz, maxTz: nd.cz, dist: 0, chunks: 0,
                 held: !!nd.held, episode: nd.episode, site: nd.site };
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
          // Same rule as the linker: held ground and a player are not one thing.
          if (!!A.held !== !!B.held) continue;
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
    });
    attributeTracks(tracks, model, opts, sliceMs);

    // Label every leg and lift the impossible ones out as events.
    tracks.forEach(function (tr) { annotateTrack(tr, model, opts); });
    /* Carried on the array rather than wrapped in an object: every caller
       already treats the return value as the track list. */
    tracks.heldSites = held.sites;
    tracks.sites = held.allSites;
    return tracks;
  }

  /* ==========================================================================
     WHOSE TRACK IS IT -- BY ELIMINATION, AND AFTER THE FACT
     --------------------------------------------------------------------------
     The old rule was "one player online for the whole track, and exactly one
     name in the roster". That answers almost nothing on a server that usually
     has three or four people on: it named 27 of 417 tracks confidently.

     Two things it was throwing away.

     FIRST, absence is evidence. The candidate list was the UNION of every name
     seen anywhere along the track, which lets someone who logged in halfway
     through own a path that started before they arrived. Take the intersection
     instead: a player can only own a track they were online for at every point
     of. That one change eliminates most candidates outright.

     SECOND, and this is the user's: the answer usually arrives late. While
     three people are on there may be nothing to separate them, and the track
     may well be attributed wrongly or not at all. Then someone leaves -- and
     the leave is a hard, clean edge. Any track still producing points after it
     is not theirs; a track that stops right at it very likely is. So this runs
     over the WHOLE window and works backwards from the edges, rather than
     deciding as it goes.

     Elimination then propagates, because a person is in one place at a time: as
     soon as a track is pinned to someone, every other track overlapping it in
     time loses that name, which can leave a neighbour with a single candidate,
     and so on to a fixed point. That is how a busy evening resolves -- not from
     the middle, but inward from whoever left first.

     Held ground takes no name at all. It is not a person, and letting it
     consume a candidate would push a real track onto the wrong player.
     ======================================================================== */

  /* How close a track's end has to sit to a leave before the two are treated as
     the same event. Generous, because loading stops when the player stops
     moving, not when they disconnect -- someone can stand still for minutes
     before logging out. This only ever ADDS evidence; it never eliminates. */
  var EDGE_WINDOW_MS = 300000;

  function attributeTracks(tracks, model, opts, sliceMs) {
    opts = opts || {};
    var edge = opts.edgeWindowMs === undefined ? EDGE_WINDOW_MS : opts.edgeWindowMs;
    var snaps = model.snapshots || [];
    var free = [];

    /* Viability is decided against each player's ONLINE INTERVAL, not by
       intersecting the rosters attached to the track's points. Point-wise
       intersection looked equivalent and was not: a track's first slice
       midpoint routinely lands a few seconds before the join it belongs to --
       tile times are shifted back by the render-queue delay, and a slice is
       stamped at its middle -- so the roster there is empty and the
       intersection eliminates everybody. On the calibration session it left
       every candidate set empty and the harness placed 0 of 11 points.

       Intervals also say the thing we actually mean: was this person online for
       the whole stretch the track covers. */
    var spans = onlineSpans(snaps);
    var slack = sliceMs;                     // one slice of edge slop, both ends
    tracks.forEach(function (tr) {
      tr.candidates = []; tr.viable = []; tr.player = null; tr.confident = false;
      tr.attribution = "";
      if (tr.held) return;                       // a place, not a person
      free.push(tr);

      var lo = tr.startMs + slack, hi = tr.lastMs - slack;
      if (lo > hi) { lo = hi = (tr.startMs + tr.lastMs) / 2; }
      var seen = new Map();
      tr.points.forEach(function (p) {
        var s = M.atOrBefore(snaps, p.ms);
        if (!s) return;
        for (var i = 0; i < s.roster.length; i++) seen.set(s.roster[i], (seen.get(s.roster[i]) || 0) + 1);
      });
      tr.candidates = Array.from(seen.entries())
        .sort(function (a, b) { return b[1] - a[1]; })
        .map(function (e) { return e[0]; });
      tr.viable = tr.candidates.filter(function (nm) {
        var list = spans.get(nm) || [];
        for (var i = 0; i < list.length; i++) if (list[i][0] <= lo && list[i][1] >= hi) return true;
        return false;
      });
      /* Nobody covers the whole span. That happens where the roster itself is
         unreliable (a capped sample, a ping outage mid-track), and eliminating
         everyone would be reading a hole in the data as a fact about people. */
      if (!tr.viable.length) tr.viable = tr.candidates.slice();
    });

    /* ---- the hard edges: joins and leaves -------------------------------- */
    var trans = model.transitions || [];
    function edgeNames(type, ms, before) {
      var out = [];
      for (var i = 0; i < trans.length; i++) {
        var t = trans[i];
        if (t.type !== type) continue;
        // A track's timestamps are slice midpoints, so allow half a slice either
        // way on top of the window.
        var lo = before ? t.ms - edge : t.ms - sliceMs * 0.75;
        var hi = before ? t.ms + sliceMs * 0.75 : t.ms + edge;
        if (ms >= lo && ms <= hi) out.push({ player: t.player, uncertain: t.uncertain, ms: t.ms });
      }
      return out;
    }
    free.forEach(function (tr) {
      tr.startsAtJoin = edgeNames("join", tr.startMs, false);
      tr.endsAtLeave = edgeNames("leave", tr.lastMs, true);
    });

    /* ---- assign, then propagate the exclusion ---------------------------- */
    function overlap(a, b) {
      return Math.min(a.lastMs, b.lastMs) >= Math.max(a.startMs, b.startMs);
    }
    /* Would this name have to be in two places at once?

       Elimination is only as good as its premise, which is that everyone online
       is loading overworld chunks somewhere. Someone in the nether is not, so
       their share of the overworld goes unclaimed and the argument "nobody else
       is left, so it must be them" hands it to whoever happens to be missing --
       which is exactly the person who cannot have made it. Caught by the
       calibration: bigboytrain360 stepped into a portal at 14:38 and came out
       at Jaune four minutes later, and the leftover track 6,441 blocks away was
       confidently assigned to them.

       So the weaker rules have to answer for the geometry: a name is only
       accepted if getting there from wherever we already put them is possible
       at all. The threshold is the one MODES already calls impossible on foot;
       what falls out is left unattributed rather than guessed, and linkEvents
       still surfaces the jump for anyone reading it. */
    var maxBps = opts.maxAttributionBps === undefined ? 80 : opts.maxAttributionBps;
    function reachable(tr, name) {
      for (var i = 0; i < free.length; i++) {
        var u = free[i];
        if (u === tr || u.player !== name || !u.points.length) continue;
        var gapMs, d;
        if (u.lastMs <= tr.startMs) {
          gapMs = tr.startMs - u.lastMs;
          d = Math.hypot(tr.points[0].tx - u.lastTx, tr.points[0].tz - u.lastTz);
        } else if (u.startMs >= tr.lastMs) {
          gapMs = u.startMs - tr.lastMs;
          d = Math.hypot(u.points[0].tx - tr.lastTx, u.points[0].tz - tr.lastTz);
        } else {
          return false;                       // overlapping in time: one person, one place
        }
        if (d / Math.max(1, gapMs / 1000) > maxBps) return false;
      }
      return true;
    }

    function assign(tr, name, how, confident) {
      tr.player = name;
      tr.confident = !!confident;
      tr.attribution = how;
      /* One person, one place. Every other track running at the same time just
         lost this candidate -- which is what turns a single certainty into a
         chain of them. */
      for (var i = 0; i < free.length; i++) {
        var u = free[i];
        if (u === tr || u.player) continue;
        if (!overlap(tr, u)) continue;
        var k = u.viable.indexOf(name);
        if (k >= 0) u.viable.splice(k, 1);
      }
    }

    /* One round can only resolve so much, and every resolution can unlock
       another, so the cap has to scale with the work rather than be a round
       number. At 20 it silently starved: the edge rule assigns at most a few
       tracks per round and a four-day log has hundreds, so most of the log
       never got its turn -- the calibration session's own track sat there with
       a single matching leave, unclaimed. */
    var changed = true, rounds = 0, maxRounds = free.length + 20;
    while (changed && rounds++ < maxRounds) {
      changed = false;

      // (a) one candidate left standing
      for (var i = 0; i < free.length; i++) {
        var tr = free[i];
        if (tr.player || tr.viable.length !== 1) continue;
        assign(tr, tr.viable[0],
          tr.candidates.length === 1
            ? "the only player online for the whole track"
            : "the only candidate left once the others were ruled out", true);
        changed = true;
      }
      if (changed) continue;

      /* (b) the edges. A track that stops exactly when someone leaves, and only
         one of its candidates left then, is theirs -- this is the case that only
         becomes decidable after the fact, which is the whole reason this pass
         runs over the finished window rather than as tracks are built. */
      for (i = 0; i < free.length; i++) {
        tr = free[i];
        if (tr.player) continue;
        var hit = edgeMatch(tr.endsAtLeave, tr.viable);
        if (hit && !reachable(tr, hit.player)) hit = null;
        if (hit) {
          assign(tr, hit.player, "ends when " + hit.player + " left" +
            (hit.uncertain ? " (a leave the roster is not sure of)" : ""), false);
          changed = true;
          continue;
        }
        hit = edgeMatch(tr.startsAtJoin, tr.viable);
        if (hit && !reachable(tr, hit.player)) hit = null;
        if (hit) {
          assign(tr, hit.player, "starts " +
            Math.max(0, Math.round((tr.startMs - hit.ms) / 1000)) + "s after " + hit.player + " joined" +
            (hit.uncertain ? " (a join the roster is not sure of)" : ""), false);
          changed = true;
        }
      }
      if (changed) continue;

      /* (c) from the player's side. If someone is a candidate on exactly one
         unclaimed track anywhere in the window, that track is theirs: they were
         online and they loaded chunks somewhere. */
      var byName = new Map();
      for (i = 0; i < free.length; i++) {
        if (free[i].player) continue;
        for (var j = 0; j < free[i].viable.length; j++) {
          var nm = free[i].viable[j];
          if (!byName.has(nm)) byName.set(nm, []);
          byName.get(nm).push(free[i]);
        }
      }
      byName.forEach(function (list, nm) {
        if (changed || list.length !== 1) return;
        if (list[0].player || !reachable(list[0], nm)) return;
        assign(list[0], nm, "the only track " + nm + " could have made while they were online", false);
        changed = true;
      });
    }

    /* Ordering is a presentation detail, but it is also what makes the two
       feeds line up: the panel and the map both walk this list. */
    tracks.sort(function (a, b) { return a.startMs - b.startMs; });
    return tracks;
  }

  /* Every stretch each player was continuously online, from the snapshots.
     A truncated sample (the server capping its name list) is not a disconnect,
     so it never closes a span -- treating it as one chopped long sessions into
     dozens of fragments, none of which covered any track. */
  function onlineSpans(snaps) {
    var open = new Map(), out = new Map();
    function close(name, endMs) {
      if (!out.has(name)) out.set(name, []);
      out.get(name).push([open.get(name), endMs]);
      open.delete(name);
    }
    for (var i = 0; i < snaps.length; i++) {
      var s = snaps[i], now = new Set(s.roster);
      if (!s.truncated) {
        Array.from(open.keys()).forEach(function (nm) { if (!now.has(nm)) close(nm, s.ms); });
      }
      now.forEach(function (nm) { if (!open.has(nm)) open.set(nm, s.ms); });
    }
    // Still listed in the last snapshot: still online, so the span has no end.
    Array.from(open.keys()).forEach(function (nm) { close(nm, Infinity); });
    return out;
  }

  /* Exactly one of the edge's names is still viable -> that is the answer. Two
     is a coincidence we cannot resolve and zero is no evidence at all; both are
     left alone rather than guessed at. */
  function edgeMatch(edges, viable) {
    var hit = null;
    for (var i = 0; i < (edges || []).length; i++) {
      if (viable.indexOf(edges[i].player) < 0) continue;
      if (hit && hit.player !== edges[i].player) return null;
      if (!hit) hit = edges[i];
    }
    return hit;
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
     CHUNK LOADERS, AND WHY THE ROSTER IS ENOUGH TO FIND THEM
     --------------------------------------------------------------------------
     A chunk loader (or spawn chunks, or any farm someone left running) keeps a
     patch of world loaded with nobody near it, so it renders forever from a
     fixed spot. Those renders are indistinguishable from a stationary player
     LOCALLY -- and that is what was wrecking the tracks: one player online, two
     places rendering, and the linker dutifully walking a path back and forth
     between them every minute.

     The observation that settles it, and it is the user's: a loader cannot
     switch itself on. Something has to load it once, and after that it stays
     up whether anyone is there or not. So within a stretch of log:

       * a patch that is only active for PART of a session, discovering chunks
         it has not seen before, is a player -- they arrived and left;
       * a patch still going while the fresh loading is demonstrably somewhere
         else, when only one person is online, is being held open. It cannot be
         the player, because the player is over there.

     Counting is what makes it falsifiable: if a slice has more active places
     than the server has people, the surplus is not people. Rank the places by
     how much NEW ground each is loading and the surplus is the ones re-drawing
     chunks they already had.

     Worked example, 2026-07-27, blocdac alone from 12:04 to 13:03:

       (3900,-2900)   88 renders over 22 chunks (4.0 each) spread across the
                      whole 54 minutes -- a base, held open
       (4020,-4020)   63 renders over 34 chunks (1.9 each) in two bursts
       (3100,-3800)   33 renders over 30 chunks (1.1 each) inside 3 minutes
       (-3300,5100)   186 renders over 133 chunks (1.4 each) in 10 minutes,
                      the pale-oak forest -- someone walking through it

     The first is a holder and the rest are a player moving. Before this, the
     model read all four as one person and drew 7,600 blocks of imaginary
     pacing; the tracks in that hour travelled 800-2,200 blocks each without
     leaving a 200-block box.

     ONCE HELD, ALWAYS HELD -- retroactively. The evidence usually arrives after
     the fact: at 12:04 there is nothing to compare (3900,-2900) against, and
     only at 12:23, when the player turns up 1,100 blocks away, does the first
     twenty minutes become interpretable. So the votes are counted over the
     whole window first and applied backwards, which is the only ordering that
     uses what the log actually knows.

     WHAT IS KEPT. The activation itself: a loader had to be loaded by someone,
     so the first couple of slices at a site are a real visit and stay. It is
     the sustained afterwards that is thrown out.
     ======================================================================== */

  /* How far apart two active patches have to be before the roster argument can
     be made at all. One player's loads sit a median 86 blocks from their centre
     and the disc wanders another hundred or so between slices, so anything
     inside a few hundred blocks is one person and the merge pass downstream
     will fold it. 512 is well outside that, and the contradiction it flags --
     two places, one player -- is then a real one. Voting at the 176-block
     clustering radius instead accused players of being their own chunk loaders:
     it condemned the pale-oak sweep's own trailing fragment. */
  var SITE_SEPARATION = 512;
  /* A site has to be RE-drawing ground it already holds before "held" is even on
     the table, whatever the roster says. Measured on the 2026-07-27 sessions,
     renders per distinct chunk separates the two populations without ambiguity:

         (3900,-2900)  4.0   base held open all session
         (650,-1700)   3.1   base, occupied
         (4020,-4020)  1.9   player, two visits
         (-3300,5100)  1.4   player walking through the pale-oak forest
         (3100,-3800)  1.1   player crossing at speed

     Below 2 the site is mostly discovering new ground, which no chunk loader
     does -- a loader's chunks are already loaded, that is the entire point. This
     guard is what stops a long exploration session being demoted because it
     happened to be the quieter of two places for a couple of minutes. */
  var HELD_REPEAT_RATE = 2.0;
  /* How many separate slices have to say so. One slice is a coincidence --
     two players can trade places for a minute. Repetition is not. */
  var HELD_MIN_VOTES = 2;
  /* A site is judged per VISIT, not once for all time, and this is the quiet
     gap that ends a visit.

     Getting this wrong is not a tuning detail, it is the difference between
     the feature working and destroying the data. Judged globally, a place
     someone has stood in for four days accumulates a vote sooner or later --
     one busy evening where it was the quieter of two places is enough -- and
     the verdict then reaches back and demotes every visit they ever made to
     their own base. That is what happened: the whole-log build classified the
     calibration site as held ground and the harness went from placing 9 of 11
     ground-truth points to 0.

     Per visit, the same site can be a player on Saturday and a machine left
     running on Sunday, which is what it actually is. 15 minutes: long enough
     that a lull in a session does not split it, short enough that two visits a
     day apart are never one. */
  var EPISODE_GAP_MS = 900000;

  function findHeldSites(nodes, radius, opts, sliceMs) {
    opts = opts || {};
    if (opts.heldSites === false) return { nodes: nodes, sites: [] };
    var minVotes = opts.heldMinVotes === undefined ? HELD_MIN_VOTES : opts.heldMinVotes;
    var repeat = opts.heldRepeatRate === undefined ? HELD_REPEAT_RATE : opts.heldRepeatRate;
    var sep = opts.siteSeparation === undefined ? SITE_SEPARATION : opts.siteSeparation;
    var episodeGap = opts.episodeGapMs === undefined ? EPISODE_GAP_MS : opts.episodeGapMs;
    var activationMs = opts.activationMs === undefined ? sliceMs * 2 : opts.activationMs;

    /* ---- a site is a place that keeps being active, across slices --------
       Nearest-centre assignment rather than single linkage: over days of log,
       linkage chains one busy area into the next until the whole inhabited
       half of the map is one "site" and nothing can be compared to anything. */
    var sites = [];
    for (var i = 0; i < nodes.length; i++) {
      var nd = nodes[i], best = null, bestD = sep / 2;
      for (var s = 0; s < sites.length; s++) {
        var d = Math.hypot(nd.cx - sites[s].cx, nd.cz - sites[s].cz);
        if (d <= bestD) { bestD = d; best = sites[s]; }
      }
      if (!best) {
        best = { id: sites.length + 1, cx: nd.cx, cz: nd.cz, n: 0,
                 firstMs: nd.ms, lastMs: nd.ms, episodes: [] };
        sites.push(best);
      }
      best.n++;
      best.cx += (nd.cx - best.cx) / best.n;      // running mean
      best.cz += (nd.cz - best.cz) / best.n;
      if (nd.ms < best.firstMs) best.firstMs = nd.ms;
      if (nd.ms > best.lastMs) best.lastMs = nd.ms;
      nd.site = best;

      /* ---- and which VISIT to the site this is ----------------------------
         Nodes arrive in time order, so the open episode is always the last one. */
      var ep = best.episodes[best.episodes.length - 1];
      if (!ep || nd.ms - ep.lastMs > episodeGap) {
        ep = { site: best, cx: nd.cx, cz: nd.cz, n: 0, renders: 0, chunkSet: new Set(),
               firstMs: nd.ms, lastMs: nd.ms, votes: 0, frontier: 0, held: false };
        best.episodes.push(ep);
      }
      ep.n++;
      ep.renders += nd.tiles;
      ep.frontier += nd.frontier;
      for (var c = 0; c < nd.chunkKeys.length; c++) ep.chunkSet.add(nd.chunkKeys[c]);
      ep.cx += (nd.cx - ep.cx) / ep.n;
      ep.cz += (nd.cz - ep.cz) / ep.n;
      ep.lastMs = nd.ms;
      nd.episode = ep;
    }
    var episodes = [];
    for (s = 0; s < sites.length; s++) {
      for (var e = 0; e < sites[s].episodes.length; e++) {
        var epi = sites[s].episodes[e];
        epi.chunks = epi.chunkSet.size;
        epi.repeatRate = epi.renders / Math.max(1, epi.chunks);
        epi.chunkSet = null;                       // done with it; do not retain
        episodes.push(epi);
      }
    }

    /* ---- more places than people: the surplus is not people ------------- */
    var bySlice = new Map();
    for (i = 0; i < nodes.length; i++) {
      if (!bySlice.has(nodes[i].ms)) bySlice.set(nodes[i].ms, []);
      bySlice.get(nodes[i].ms).push(nodes[i]);
    }
    bySlice.forEach(function (grp) {
      /* By SITE, not by node. One player's disc regularly fragments into two or
         three nodes in a slice (that is what the merge pass downstream is for),
         and counting those fragments as separate places would accuse a player
         of being their own chunk loader. */
      var perSite = new Map();
      for (var j = 0; j < grp.length; j++) {
        var st = grp[j].site, pe = perSite.get(st);
        if (!pe) { pe = { site: st, episode: grp[j].episode, frontier: 0 }; perSite.set(st, pe); }
        pe.frontier += grp[j].frontier;
      }
      var places = Array.from(perSite.values());
      /* The roster is the constraint. A null count (before the first player
         snapshot) is not evidence of an empty server, and a zero count still
         has to allow one place -- the render queue drains for a minute or so
         after the last player leaves. */
      var online = grp[0].online;
      var allow = Math.max(1, online === null || online === undefined ? 1 : online);
      if (places.length <= allow) return;
      places.sort(function (a, b) {
        // most new ground first; tie-break toward the visit that only just
        // started, since a holder by definition has been going a while
        return b.frontier - a.frontier || b.episode.firstMs - a.episode.firstMs;
      });
      /* Everything past the head-count loses. No margin is demanded on the
         frontier counts themselves: at 60s slices a place contributes one to
         four new chunks and the two candidates are routinely tied, so requiring
         the loser to be clearly quieter (an earlier version wanted half) meant
         the vote almost never fired -- the (3900,-2900) base scored zero votes
         across the very hour it was demonstrably holding itself open. The tie
         is broken on age instead, which is the actual physics: whichever place
         has been going longer is the one that had time to be switched on. What
         keeps this from condemning quiet players is the repeat-rate gate below,
         not the margin. */
      for (j = allow; j < places.length; j++) places[j].episode.votes++;
    });

    var heldSites = [];
    for (i = 0; i < episodes.length; i++) {
      if (episodes[i].votes >= minVotes && episodes[i].repeatRate >= repeat) {
        episodes[i].held = true; heldSites.push(episodes[i]);
      }
    }

    /* ---- apply it, backwards over the whole window ----------------------
       MARKED, NOT DELETED. Deleting held nodes outright was the first attempt
       and it threw away something real: a site being held means its renders do
       not prove anyone is standing there, not that nothing happened. What has
       to stop is the LINKING -- a path that steps from a farm to a player and
       back every minute is the fiction. So held nodes stay, and the linker
       below refuses to join them to anything but their own site, which leaves
       them as a stationary blob at a fixed place instead of a leg of somebody's
       journey. */
    for (i = 0; i < nodes.length; i++) {
      var n2 = nodes[i];
      if (!n2.episode.held) continue;
      // The visit that switched it on is real; everything after is the machine.
      if (n2.ms <= n2.episode.firstMs + activationMs) n2.activation = true;
      else n2.held = true;
    }
    return { nodes: nodes, sites: heldSites, allSites: episodes };
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
  // Also not a speed band: ground held loaded by something other than presence.
  var HELD = { name: "held", note: "a place being kept loaded -- renders here locate the loader, not a player" };

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

    /* Ground someone is holding open. The renders wander a couple of hundred
       blocks around the site as different corners of it tick, and reading that
       wander as walking is exactly the mistake this whole pass exists to stop.
       One mode, no speeds, no events. */
    if (tr.held) {
      for (var h = 1; h < tr.points.length; h++) {
        var dth = (tr.points[h].ms - tr.points[h - 1].ms) / 1000;
        legs.push({ ms: tr.points[h - 1].ms, mode: "held", bps: 0, blocks: 0 });
        modeTime.held = (modeTime.held || 0) + Math.max(0, dth);
      }
      tr.legs = legs; tr.events = []; tr.modeTime = modeTime;
      tr.dominantMode = "held"; tr.movingSec = 0;
      tr.blocksTravelled = 0;
      return tr;
    }

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

    /* Held ground has no arrivals and no departures: nobody travelled to or
       from it, it was simply switched on. Pairing it up manufactures teleports
       between a farm and whoever happened to be moving next. */
    var byStart = tracks.filter(function (t) { return !t.held; })
                        .sort(function (a, b) { return a.startMs - b.startMs; });
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

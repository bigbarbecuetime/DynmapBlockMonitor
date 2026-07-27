/* ============================================================================
   tiles.js -- the map stage: a pan/zoom grid of Dynmap tiles, drawn either as
   real tile art, as a heatmap of how often each tile changed, or both.
   ----------------------------------------------------------------------------
   Two things worth knowing before editing:

   1. Heat is always accumulated from a tile's CORRECTED tile_time (when it
      really re-rendered), never from the capture time we happened to poll at.
      Using capture time smears activity forward by the render lag and, because
      the two clocks differ, can even reorder it.

   2. Tile images are fetched preferentially from the tracker's own saved
      history (data/chunks/, written when SAVE_IMAGES=true) so a replay shows the
      map as it looked THEN. Only when no snapshot exists do we fall back to the
      server's live tile, which shows the world as it is NOW -- that difference is
      surfaced in the tooltip rather than quietly blended.
   ========================================================================= */

window.DV = window.DV || {};

(function (DV) {
  "use strict";

  var M = DV.model;

  /* Colours live in CSS so the two themes stay in one place; canvas needs them
     as strings, so read them once and re-read when the theme changes. */
  function readPalette(el) {
    var cs = getComputedStyle(el);
    function v(n) { return cs.getPropertyValue(n).trim(); }
    return {
      bg: v("--map-bg"), grid: v("--map-grid"),
      text3: v("--text-3"), text2: v("--text-2"), text1: v("--text-1"),
      border: v("--border"), surface1: v("--surface-1"),
      tiles: v("--series-tiles"), players: v("--series-players"),
      critical: v("--status-critical"), warning: v("--status-warning"),
      /* One ramp per heat measure, so the colour says which question the map is
         answering. Keyed by the metric name used in state.heatMetric. */
      ramps: {
        count:   [v("--heat-0"), v("--heat-1"), v("--heat-2"), v("--heat-3"), v("--heat-4"), v("--heat-5")],
        last:    [v("--newest-0"), v("--newest-1"), v("--newest-2"), v("--newest-3"), v("--newest-4"), v("--newest-5")],
        recency: [v("--decay-0"), v("--decay-1"), v("--decay-2"), v("--decay-3"), v("--decay-4"), v("--decay-5")]
      }
    };
  }

  /* Each ramp starts at white for its lowest bin. Left fully opaque, a white low
     end glares on the dark map plane and the sparse majority would shout over the
     dense minority, so the bottom bins are drawn back toward the surface. */
  var BIN_ALPHA = [0.30, 0.48, 0.66, 0.82, 0.93, 1.0];

  var HEAT_BINS = 6;
  /* Above this many visible cells we stop requesting tile art: it would be
     hundreds of HTTP requests for tiles a few pixels across. The heat layer
     still renders, and the caller is told so it can say why. */
  var MAX_IMAGE_CELLS = 700;
  var MAX_INFLIGHT = 6;
  var CACHE_LIMIT = 900;

  function createMap(canvas, opts) {
    opts = opts || {};
    var ctx = canvas.getContext("2d");
    var pal = readPalette(canvas);

    var state = {
      model: null,
      t0: 0, t1: 0, cursor: 0,
      mode: "hybrid",            // heat | images | hybrid | tracks
      heatMetric: "count",       // count | recency | last
      heatScale: "sqrt",         // linear | sqrt | log
      halfLifeMs: 300000,
      imageSource: "auto",       // auto | historical | current | off
      fillContext: false,        // also fetch tiles that never changed, for context
      /* Kept in state (not read from the captured opts) so that changing the data
         folder actually redirects saved-snapshot lookups. Reading it from the
         construction-time opts meant a reload pointed the CSVs at a new folder
         while snapshot URLs still resolved against the old one -- every image
         404'd while the tooltip claimed "saved snapshot from this run". */
      dataBase: opts.dataBase || "../data",
      mapCfg: null,             // the SELECTED map type's Dynmap projection

      showGrid: true,
      showRuler: true,
      showMarkers: true,        // Dynmap's marker layer (world border, spawn, ...)
      tileKinds: "all",         // all | edits | loads  -- see the classification note in model.js
      trackFilter: "",          // show only tracks for this player (substring, case-insensitive)
      selectedTrack: null,      // id of the track whose details are open
      showTracks: false,        // inferred player tracks (see infer.js)
      showPortals: false,       // public nether portals + highway (the Nelt)
      political: null,          // {date, tiles:Set} historical political map beneath
      // view: grid units (gx = tx, gy = -tz) at centre, plus px-per-tile
      gx: 0, gy: 0, scale: 6,
      hover: null, selected: null
    };

    var heat = new Map();        // "tx,tz" -> {v, n, lastMs, firstMs}
    var heatMax = 0, heatCount = 0;
    var images = new Map();      // url -> {img, ok, loading}
    var queue = [], inflight = 0;
    var historical = null;       // Set of available data/chunks filenames, or null
    var urlTemplate = null;      // for tiles that never appear in the CSV
    var sessionStamp = Date.now();  // stable cache-buster; bumped only on demand
    var markers = null;             // Dynmap's marker layer, once fetched
    var tracks = null;              // inferred player tracks, if built
    var trackEvents = null;         // teleports / nether crossings between them
    var portals = null, highways = null;
    var politicalDrawn = 0, politicalLodUsed = -1;
    var suppressedImages = false;
    var needsDraw = false;

    /* --------------------------------------------------------------- sizing */

    function resize() {
      var dpr = Math.min(2.5, window.devicePixelRatio || 1);
      var r = canvas.getBoundingClientRect();
      var w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr; canvas.height = h * dpr;
      }
      state.w = w; state.h = h; state.dpr = dpr;
    }

    /* ------------------------------------------------------------ transform */

    function toScreen(gx, gy) {
      return { x: (gx - state.gx) * state.scale + state.w / 2,
               y: (gy - state.gy) * state.scale + state.h / 2 };
    }
    function toGrid(px, py) {
      return { gx: (px - state.w / 2) / state.scale + state.gx,
               gy: (py - state.h / 2) / state.scale + state.gy };
    }
    /* grid <-> tile: gy is -tz so that north (higher tileY) draws upward. */
    function cellAt(px, py) {
      var g = toGrid(px, py);
      return { tx: Math.floor(g.gx), tz: -Math.floor(g.gy) - 1 };
    }
    function cellRect(tx, tz) {
      var p = toScreen(tx, -tz - 1);
      return { x: p.x, y: p.y, s: state.scale };
    }

    function visibleRange() {
      var a = toGrid(0, 0), b = toGrid(state.w, state.h);
      return {
        tx0: Math.floor(a.gx) - 1, tx1: Math.ceil(b.gx) + 1,
        tz0: -Math.ceil(b.gy) - 1, tz1: -Math.floor(a.gy) + 1
      };
    }

    /* ------------------------------------------------------------ heat calc */

    function lowerBound(arr, ms) { return M.lowerBound(arr, ms, "tileMs"); }

    /* Accumulation state, so playback does not re-walk the whole tile list every
       frame. Heat only ever GROWS as the cursor advances with a fixed window
       start, so a forward step just folds in the tiles between the old cursor and
       the new one; anything else (window start moved, cursor jumped backwards,
       new model, metric changed) falls back to a full rebuild. */
    var acc = { t0: NaN, cursor: NaN, metric: null, halfLifeMs: NaN, model: null, idx: 0, kinds: null };

    /* Only tiles whose corrected render time falls in [windowStart, cursor]
       contribute, so scrubbing the cursor genuinely rewinds the map instead of
       just dimming it. */
    function recomputeHeat() {
      var m = state.model;
      var from = state.t0, to = state.cursor;
      var tau = state.halfLifeMs / Math.LN2;

      var full = !m || m !== acc.model || from !== acc.t0 ||
                 state.heatMetric !== acc.metric || state.halfLifeMs !== acc.halfLifeMs ||
                 state.tileKinds !== acc.kinds || !(to >= acc.cursor);
      if (full) {
        heat.clear();
        acc.model = m; acc.t0 = from; acc.metric = state.heatMetric;
        acc.halfLifeMs = state.halfLifeMs; acc.kinds = state.tileKinds;
        acc.idx = m && m.tiles.length ? lowerBound(m.tiles, from) : 0;
      }
      acc.cursor = to;

      heatMax = 0; heatCount = 0;
      if (!m || !m.tiles.length) return;

      var tiles = m.tiles, i = acc.idx;
      for (; i < tiles.length; i++) {
        var t = tiles[i];
        if (t.tileMs > to) break;
        // Chunk loads swamp real edits ~3:1, so they can be filtered out here.
        if (state.tileKinds === "edits" && t.kind === "load") continue;
        if (state.tileKinds === "loads" && t.kind !== "load") continue;
        var k = t.tx + "," + t.tz;
        var c = heat.get(k);
        if (!c) {
          c = { v: 0, n: 0, lastMs: -Infinity, firstMs: t.tileMs, tx: t.tx, tz: t.tz, last: null,
                accum: 0, accumAt: t.tileMs };
          heat.set(k, c);
        }
        c.n++;
        c.lastMs = t.tileMs;
        c.last = t;
        if (state.heatMetric === "recency") {
          /* Decay-then-add, carrying its own reference time. This is what makes
             recency incremental: the value at any later moment is
             accum * exp(-(now - accumAt)/tau), so we never have to revisit older
             tiles. Rescaling relative to the cell's own last change also keeps
             the exponent small -- factoring out a shared epoch instead would
             overflow, since a 21h span over a 5min half-life is exp(174). */
          c.accum = c.accum * Math.exp(-(t.tileMs - c.accumAt) / tau) + 1;
          c.accumAt = t.tileMs;
        }
      }
      acc.idx = i;

      /* Finalise over CELLS (a couple of thousand) rather than tiles (tens of
         thousands). Both recency and "last" depend on the cursor for every cell,
         so this pass cannot be skipped -- but it is an order of magnitude smaller
         than the old full-tile walk. */
      var metric = state.heatMetric, span = Math.max(1, to - from);
      heat.forEach(function (c) {
        if (metric === "count") c.v = c.n;
        else if (metric === "recency") c.v = c.accum * Math.exp(-(to - c.accumAt) / tau);
        else c.v = Math.max(0, 1 - (to - c.lastMs) / span);  // newest = hottest
        if (c.v > heatMax) heatMax = c.v;
        heatCount++;
      });
    }

    function heatBin(v) {
      if (!(v > 0) || !(heatMax > 0)) return -1;
      var f = v / heatMax;
      if (state.heatScale === "sqrt") f = Math.sqrt(f);
      else if (state.heatScale === "log") f = Math.log1p(f * 9) / Math.LN10;
      var b = Math.floor(f * HEAT_BINS);
      return Math.max(0, Math.min(HEAT_BINS - 1, b));
    }

    /* Thresholds behind each ramp step, so the legend can print real numbers
       instead of an unlabelled gradient. */
    function heatLegend() {
      var out = [];
      for (var b = 0; b < HEAT_BINS; b++) {
        var lo = (b) / HEAT_BINS, hi = (b + 1) / HEAT_BINS;
        if (state.heatScale === "sqrt") { lo = lo * lo; hi = hi * hi; }
        else if (state.heatScale === "log") { lo = (Math.pow(10, lo) - 1) / 9; hi = (Math.pow(10, hi) - 1) / 9; }
        out.push({ bin: b, lo: lo * heatMax, hi: hi * heatMax });
      }
      return { bins: out, max: heatMax, cells: heatCount, metric: state.heatMetric };
    }

    /* --------------------------------------------------------- tile images */

    function bestUrl(tx, tz) {
      var cell = heat.get(tx + "," + tz);
      var src = state.imageSource;
      if (src === "off") return null;

      // Prefer a saved snapshot from the run itself -- that is the map as it was.
      if (cell && cell.last && (src === "auto" || src === "historical")) {
        var name = M.historicalName(cell.last);
        if (historical && historical.has(name)) {
          return { url: state.dataBase + "/chunks/" + name, historical: true, name: name };
        }
        if (src === "historical") return null;
      }
      if (cell && cell.last) return { url: cell.last.url, historical: false, name: cell.last.name };
      // Never-changed tile: only fetched when the user asks for surrounding
      // context, and always the server's current render.
      if (state.fillContext && urlTemplate) {
        return { url: urlTemplate(tx, tz), historical: false, name: "current" };
      }
      return null;
    }

    function getImage(url) {
      var e = images.get(url);
      if (e) return e;
      e = { img: null, ok: false, loading: true };
      images.set(url, e);
      queue.push({ url: url, e: e });
      pump();
      return e;
    }

    function pump() {
      while (inflight < MAX_INFLIGHT && queue.length) {
        // let, not var: these are captured by the onload/onerror closures below.
        // Function-scoped vars would be SHARED by every handler created in this
        // loop, so whenever it iterates more than once each handler would write
        // the last image into the last cache entry -- painting one tile's art at
        // another tile's coordinates and leaving the rest stuck "loading" forever.
        let job = queue.shift();
        inflight++;
        let img = new Image();
        // No crossOrigin: we only ever draw these, never read pixels back, so a
        // tainted canvas costs us nothing and this avoids needing CORS headers
        // on the Dynmap host.
        img.decoding = "async";
        img.onload = function () { job.e.img = img; job.e.ok = true; job.e.loading = false; inflight--; pump(); invalidate(); };
        img.onerror = function () { job.e.ok = false; job.e.loading = false; inflight--; pump(); invalidate(); };
        img.src = job.url;
      }
      if (images.size > CACHE_LIMIT) {
        /* Drop the oldest inserted entries (Map preserves insertion order), but
           never one that is still in flight: evicting a loading entry orphans its
           download -- the handler completes into an object nothing references, and
           the next draw re-queues the identical URL. */
        var drop = images.size - CACHE_LIMIT;
        var keys = images.keys(), k;
        while (drop > 0 && (k = keys.next().value) !== undefined) {
          var e = images.get(k);
          if (e && e.loading) continue;
          images.delete(k);
          drop--;
        }
      }
    }

    /* ------------------------------------------------------------- painting */

    function invalidate() {
      if (needsDraw) return;
      needsDraw = true;
      requestAnimationFrame(function () { needsDraw = false; draw(); });
    }

    /* Draw right now, ignoring the coalescing flag. Needed because a browser
       stops servicing requestAnimationFrame while the tab is hidden: if an
       invalidate() lands in that window the flag latches true and every later
       invalidate() no-ops, leaving a permanently stale canvas. The app calls
       this when the page becomes visible again. */
    function flush() { needsDraw = false; draw(); }

    function draw() {
      resize();
      var w = state.w, h = state.h, s = state.scale;
      ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = pal.bg;
      ctx.fillRect(0, 0, w, h);

      drawPolitical();

      var vis = visibleRange();
      var cells = Math.max(0, (vis.tx1 - vis.tx0) * (vis.tz1 - vis.tz0));
      var wantImages = state.mode !== "heat" && state.imageSource !== "off";
      suppressedImages = wantImages && cells > MAX_IMAGE_CELLS;
      var drawImages = wantImages && !suppressedImages;

      /* --- tile art ---------------------------------------------------- */
      if (drawImages) {
        ctx.imageSmoothingEnabled = s < 8;   // pixel art: only smooth when shrunk
        for (var tz = vis.tz0; tz <= vis.tz1; tz++) {
          for (var tx = vis.tx0; tx <= vis.tx1; tx++) {
            var pick = bestUrl(tx, tz);
            if (!pick) continue;
            var e = getImage(pick.url);
            if (!e.ok || !e.img) continue;
            var r = cellRect(tx, tz);
            // +1 covers sub-pixel seams between adjacent tiles when zoomed out.
            ctx.drawImage(e.img, r.x, r.y, r.s + 1, r.s + 1);
          }
        }
        if (state.mode === "hybrid") {
          // Knock the art back so the heat layer on top stays readable.
          ctx.fillStyle = pal.bg;
          ctx.globalAlpha = 0.45;
          ctx.fillRect(0, 0, w, h);
          ctx.globalAlpha = 1;
        }
      }

      /* --- heat -------------------------------------------------------- */
      if (state.mode !== "images") {
        var alpha = state.mode === "hybrid" ? 0.82 : 1;
        // 2px surface gap between filled cells once they are big enough to show
        // one, so adjacent hot tiles read as separate cells and not one blob.
        var gap = s >= 10 ? 2 : 0;
        var ramp = pal.ramps[state.heatMetric] || pal.ramps.count;
        heat.forEach(function (c) {
          if (c.tx < vis.tx0 || c.tx > vis.tx1 || c.tz < vis.tz0 || c.tz > vis.tz1) return;
          var b = heatBin(c.v);
          if (b < 0) return;
          var r = cellRect(c.tx, c.tz);
          ctx.globalAlpha = alpha * BIN_ALPHA[b];
          ctx.fillStyle = ramp[b];
          ctx.fillRect(r.x + gap / 2, r.y + gap / 2, Math.max(1, r.s - gap), Math.max(1, r.s - gap));
        });
        ctx.globalAlpha = 1;
      }

      /* --- grid -------------------------------------------------------- */
      if (state.showGrid && s >= 4) {
        var vis2 = vis;
        /* Two grids at once. The fine one is the 8x8 tile Dynmap actually
           publishes; the heavier one every second line is the 16x16 CHUNK, which
           is the unit the game loads and the unit the load/edit classification
           is really about. Chunk boundaries fall on even tile coordinates, since
           two tiles span one chunk. */
        function gridLines(step, style, width) {
          ctx.strokeStyle = style;
          ctx.lineWidth = width;
          ctx.beginPath();
          var gx0 = Math.ceil(vis2.tx0 / step) * step;
          for (var gx = gx0; gx <= vis2.tx1; gx += step) {
            var p = toScreen(gx, 0);
            var x = Math.round(p.x) + 0.5;
            ctx.moveTo(x, 0); ctx.lineTo(x, h);
          }
          var gy0 = Math.ceil(-vis2.tz1 / step) * step;
          for (var gy = gy0; gy <= -vis2.tz0; gy += step) {
            var q = toScreen(0, gy);
            var y = Math.round(q.y) + 0.5;
            ctx.moveTo(0, y); ctx.lineTo(w, y);
          }
          ctx.stroke();
        }
        if (s >= 7) gridLines(1, pal.grid, 1);          // 8x8 tiles, once there is room
        gridLines(2, pal.text3, s >= 7 ? 1 : 0.6);      // 16x16 chunks, always
      }

      /* --- world origin ------------------------------------------------ */
      var o = toScreen(0, 0);
      if (o.x > -40 && o.x < w + 40 && o.y > -40 && o.y < h + 40) {
        ctx.strokeStyle = pal.text3;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(Math.round(o.x) + 0.5, 0); ctx.lineTo(Math.round(o.x) + 0.5, h);
        ctx.moveTo(0, Math.round(o.y) + 0.5); ctx.lineTo(w, Math.round(o.y) + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      /* --- the tile(s) changing right at the cursor -------------------- */
      var m = state.model;
      if (m) {
        var lit = tilesAt(state.cursor, Math.max(1500, m.pollMs));
        ctx.strokeStyle = pal.tiles;
        ctx.lineWidth = 2;
        for (var i = 0; i < lit.length; i++) {
          var rr = cellRect(lit[i].tx, lit[i].tz);
          var pad = Math.max(2, Math.min(6, rr.s * 0.35));
          ctx.strokeRect(rr.x - pad, rr.y - pad, rr.s + pad * 2, rr.s + pad * 2);
        }
      }

      /* --- inferred tracks, then server-published markers ---------------- */
      drawTracks();
      drawTrackEvents();
      drawPortals();
      drawMarkers();

      /* --- selection + hover ------------------------------------------- */
      if (state.selected) outline(state.selected, pal.players, 2);
      if (state.hover) outline(state.hover, pal.text1, 1);

      if (state.showRuler) drawRuler(vis);
    }

    /* ------------------------------------------------ political layer ---- */

    /* Historical political maps from craftix (mccivmap). Their metadata reports
       topLeft {-5504,-5504} at scale 1 -- ONE PIXEL PER BLOCK -- so a lod0 tile
       of 512px covers exactly 512 blocks, i.e. 64 of our 8-block tiles. No
       projection is needed, just a divide, which is why these line up with the
       flat map exactly. Only meaningful under a flat projection: the political
       map is drawn top-down, so it cannot be laid under a skewed view. */
    /* The pyramid is small -- 484 tiles at lod0 down to 4 at lod4, where two by
       two covers the entire 11008-block world -- so there is never a reason to
       stop drawing. Step UP a level as you zoom out instead of bailing: each
       level doubles the blocks per tile, so the number on screen stays in single
       or double digits at every zoom. */
    function politicalLod(pol, bpt) {
      var maxLod = pol.maxLod === undefined ? 4 : pol.maxLod;
      /* Measure the projection rather than assuming state.scale is screen pixels
         per grid unit -- that only holds overhead. The isometric matrix magnifies
         by 11.31 where flat2 uses 16, so the same overlay tile lands about 30%
         smaller and the wrong LOD would be chosen. */
      var o = projGrid(0, 0), ux = projGrid(1, 0);
      var pxPerGrid = Math.hypot(ux.x - o.x, ux.y - o.y) || state.scale;
      // Aim for tiles at least ~256px on screen; smaller means we are fetching
      // far more of them than the detail is worth.
      var lod = 0;
      while (lod < maxLod && (512 * Math.pow(2, lod) / bpt) * pxPerGrid < 256) lod++;
      return lod;
    }

    function drawPolitical() {
      var pol = state.political;
      if (!pol || !pol.date) return;
      var bpt = state.model ? state.model.blocksPerTile : M.BLOCKS_PER_TILE;
      var lod = politicalLod(pol, bpt);
      var gridPerTile = (512 * Math.pow(2, lod)) / bpt;   // grid units per tile at this lod
      /* Range comes from the projected corners, not the screen rectangle: on a
         skewed map the visible world is a rotated quad, and reading only two
         opposite corners left the overlay clipped along the diagonals. */
      var box = visibleGridBox();
      var x0 = Math.floor(box.x0 / gridPerTile), x1 = Math.ceil(box.x1 / gridPerTile);
      var z0 = Math.floor(box.y0 / gridPerTile), z1 = Math.ceil(box.y1 / gridPerTile);
      ctx.globalAlpha = pol.opacity === undefined ? 0.55 : pol.opacity;
      ctx.imageSmoothingEnabled = true;
      politicalDrawn = 0;
      for (var tx = x0; tx <= x1; tx++) {
        for (var tz = z0; tz <= z1; tz++) {
          /* The extension is NOT uniform across the pyramid: lod0 is published as
             .png and every zoomed-out level as .jpg. Hardcoding .png made all of
             lod1-4 404, which looked exactly like "the overlay does not work when
             zoomed out". Take it from the published list instead of assuming. */
          var stem = "lod" + lod + "_x" + tx + "_z" + tz;
          var name = null;
          if (pol.tiles) {
            if (pol.tiles.has(stem + ".png")) name = stem + ".png";
            else if (pol.tiles.has(stem + ".jpg")) name = stem + ".jpg";
            else continue;
          } else {
            name = stem + (lod === 0 ? ".png" : ".jpg");
          }
          var e = getImage(pol.base + "/" + name);
          if (!e.ok || !e.img) continue;
          drawWarped(e.img, tx * gridPerTile, tz * gridPerTile,
                            (tx + 1) * gridPerTile, (tz + 1) * gridPerTile);
          politicalDrawn++;
        }
      }
      politicalLodUsed = lod;
      ctx.globalAlpha = 1;
    }

    /* --------------------------------------------------- the Nelt layer --- */

    /* Public nether portals and the highway, published in NETHER coordinates --
       so the overworld position is eight times each value. */
    function drawPortals() {
      if (!state.showPortals) return;
      var cs = getComputedStyle(canvas);
      if (highways) {
        ctx.strokeStyle = pal.critical;
        ctx.globalAlpha = 0.35;
        for (var i = 0; i < highways.length; i++) {
          var h = highways[i];
          ctx.lineWidth = h.main ? 2 : 1;
          var p1 = worldToScreen(h.x1 * 8, h.z1 * 8, 64), p2 = worldToScreen(h.x2 * 8, h.z2 * 8, 64);
          ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      if (portals && state.scale >= 0.6) {
        for (i = 0; i < portals.length; i++) {
          var q = worldToScreen(portals[i].x * 8, portals[i].z * 8, 64);
          if (q.x < -20 || q.x > state.w + 20 || q.y < -20 || q.y > state.h + 20) continue;
          ctx.fillStyle = pal.critical;
          ctx.beginPath(); ctx.arc(q.x, q.y, 3, 0, 6.2832); ctx.fill();
          if (state.scale >= 4) {
            ctx.font = "9px system-ui, sans-serif";
            ctx.textAlign = "center";
            ctx.fillStyle = pal.text2;
            ctx.fillText(portals[i].name, q.x, q.y - 6);
          }
        }
      }
    }

    /* ----------------------------------------------------- track layer ---- */

    /* Tracks are drawn as a path through the chunk loads that were linked
       together, brightest at the head so direction of travel is visible. Colour
       is per track, from the categorical slots, so two tracks crossing stay
       distinguishable. */
  /* Player colours are GENERATED, not picked from the categorical slots.
     Hashing names into a six-slot palette meant two players collided as soon as
     there were seven of them -- and well before that, because a hash lands
     wherever it lands, so three people could share one slot while three slots
     went unused. On a map where the whole point is telling one person's line
     from another's, that is the wrong failure.

     Instead give every player an index and space the indices around the hue
     circle by the golden angle (137.5 degrees). That angle is what makes any
     PREFIX of the sequence well spread, not just the full set: with four
     players the hues sit at 0, 137, 275 and 52, and adding a fifth moves
     nobody. Lightness cycles through three themed steps as well, because the
     hues that eventually come closest under a golden angle are the ones whose
     indices differ by a Fibonacci number -- 5, 8, 13 -- and none of those is
     divisible by 3, so every near-pair in hue is forced apart in value. A
     two-step cycle missed the even offsets: at ten players the closest pair sat
     20 degrees apart at the SAME lightness.

     Indices come from the sorted roster rather than track order, so a player
     keeps one colour across every track they own and across a rebuild. */
  /* Shortest distance from a point to a line SEGMENT (not the infinite line):
     clamping t to [0,1] is what stops a click far past the end of a short
     segment from registering as a hit on it. */
  function segDist(px, pz, ax, az, bx, bz) {
    var dx = bx - ax, dz = bz - az;
    var len2 = dx * dx + dz * dz;
    if (len2 < 1e-9) return Math.hypot(px - ax, pz - az);
    var t = ((px - ax) * dx + (pz - az) * dz) / len2;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
  }

  var hueIndex = Object.create(null), hueCount = 0;

  function registerPlayers(names) {
    var sorted = names.slice().sort();
    hueIndex = Object.create(null);
    for (var i = 0; i < sorted.length; i++) hueIndex[sorted[i]] = i;
    hueCount = sorted.length;
  }

  function playerColour(name, cs) {
    var i = hueIndex[name];
    if (i === undefined) {
      // Not in the roster (a filtered rebuild, say): fall back to a hash so the
      // colour is still stable rather than jumping between frames.
      var h = 0;
      for (var k = 0; k < name.length; k++) h = (h * 31 + name.charCodeAt(k)) >>> 0;
      i = hueCount + (h % 97);
    }
    var hue = (i * 137.508) % 360;
    var sat = cs.getPropertyValue("--track-sat").trim() || "74%";
    var step = ["--track-lum", "--track-lum-alt", "--track-lum-3"][i % 3];
    var lum = cs.getPropertyValue(step).trim() || "45%";
    return "hsl(" + hue.toFixed(1) + " " + sat + " " + lum + ")";
  }

  /* Returns a colour, not a variable name: generated hues have no CSS token to
     point at. Unattributed tracks stay on the muted ink so they never
     impersonate a named player. */
  function trackHue(tr, cs) {
    cs = cs || getComputedStyle(canvas);
    if (!tr || !tr.player) return cs.getPropertyValue("--text-3").trim() || "#898781";
    return playerColour(tr.player, cs);
  }

    function drawTracks() {
      if (!tracks || !state.showTracks || !tracks.length) return;
      var cs = getComputedStyle(canvas);
      ctx.save();
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      var filter = (state.trackFilter || "").toLowerCase();
      for (var i = 0; i < tracks.length; i++) {
        var tr = tracks[i];
        if (tr.lastMs < state.t0 || tr.startMs > state.cursor) continue;
        if (filter && (tr.player || "").toLowerCase().indexOf(filter) < 0) continue;
        /* Colour follows the PLAYER, not the track's position in the list. One
           person's separate visits are the same colour every time -- which is
           what makes "they left and came back here" legible -- and the colour
           does not change when an unrelated track appears earlier in the list.
           Unattributed tracks share one muted slot so they never impersonate a
           named player. */
        var col = trackHue(tr, cs);
        var pts = tr.points.filter(function (p) { return p.ms <= state.cursor; });
        if (pts.length < 2) continue;
        var isSel = state.selectedTrack === tr.id;
        /* HELD GROUND IS NOT A PATH. Somewhere kept loaded re-renders whichever
           corner of itself ticked next, so joining those points draws a scribble
           that reads as a person pacing -- which is precisely the thing that
           made the tracks look uncorrelated. Draw the place instead: one ring
           at the middle of everything it touched, and no line at all. */
        if (tr.held) { drawHeldGround(tr, pts, col, isSel); continue; }
        ctx.strokeStyle = col;
        ctx.lineWidth = isSel ? 4 : 2;
        // Unattributed tracks recede; the selected one is pulled forward.
        ctx.globalAlpha = isSel ? 1 : (tr.confident ? 0.9 : 0.5);
        ctx.beginPath();
        /* Track points are WORLD coordinates, so they go through the active
           map's projection like everything else -- which is what lets the same
           track draw correctly on the flat map and on a skewed isometric one. */
        for (var j = 0; j < pts.length; j++) {
          var q = worldToScreen(pts[j].tx, pts[j].tz, 64);
          if (j === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
        }
        ctx.stroke();

        var last = worldToScreen(pts[pts.length - 1].tx, pts[pts.length - 1].tz, 64);
        /* The head is drawn as the load DISC, not a dot: the estimate is the
           centre of a ring of loaded chunks about 86 blocks across, and drawing a
           point would claim a precision we do not have. */
        var rad = (pts[pts.length - 1].radius || 0);
        if (rad > 0 && state.scale >= 0.5) {
          var edge = worldToScreen(pts[pts.length - 1].tx + rad, pts[pts.length - 1].tz, 64);
          var rpx = Math.abs(edge.x - last.x);
          if (rpx > 3 && rpx < 400) {
            ctx.globalAlpha = 0.13;
            ctx.fillStyle = col;
            ctx.beginPath(); ctx.arc(last.x, last.y, rpx, 0, 6.2832); ctx.fill();
          }
        }
        ctx.globalAlpha = 1;
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(last.x, last.y, 4, 0, 6.2832);
        ctx.fill();
        if (tr.player && state.scale >= 1.5) {
          /* Say WHEN, not just who. Every track whose span overlaps the window
             is drawn, so an hour-old track sits on the map looking exactly like
             a live one -- a name alone reads as "this player is here now" and
             prompted exactly that complaint about someone who had been offline
             for an hour. The age is measured against the cursor, which is the
             moment the rest of the view is showing. */
          ctx.font = "10px system-ui, -apple-system, sans-serif";
          ctx.textAlign = "center";
          ctx.fillStyle = pal.text1;
          var age = state.cursor - tr.lastMs;
          var label = tr.player + (age > 90000 ? "  · " + M.fmtDur(age) + " ago" : "");
          ctx.fillText(label, last.x, last.y - 8);
        }
      }
      ctx.restore();
    }

    /* A place someone left running. Drawn as the extent it covers, dashed and
       unfilled so it never competes with a player track, and deliberately in the
       muted ink rather than a player colour -- nobody owns it. */
    function drawHeldGround(tr, pts, col, isSel) {
      var minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (var j = 0; j < pts.length; j++) {
        if (pts[j].tx < minX) minX = pts[j].tx;
        if (pts[j].tx > maxX) maxX = pts[j].tx;
        if (pts[j].tz < minZ) minZ = pts[j].tz;
        if (pts[j].tz > maxZ) maxZ = pts[j].tz;
      }
      var c = worldToScreen((minX + maxX) / 2, (minZ + maxZ) / 2, 64);
      var edge = worldToScreen((minX + maxX) / 2 + Math.max(48, (maxX - minX) / 2),
                               (minZ + maxZ) / 2, 64);
      var rpx = Math.min(300, Math.abs(edge.x - c.x));
      ctx.save();
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = col;
      ctx.lineWidth = isSel ? 2.5 : 1.5;
      ctx.globalAlpha = isSel ? 0.95 : 0.55;
      ctx.beginPath();
      ctx.arc(c.x, c.y, Math.max(4, rpx), 0, 6.2832);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(c.x - 4, c.y); ctx.lineTo(c.x + 4, c.y);
      ctx.moveTo(c.x, c.y - 4); ctx.lineTo(c.x, c.y + 4);
      ctx.stroke();
      if (state.scale >= 1.5) {
        ctx.font = "10px system-ui, -apple-system, sans-serif";
        ctx.textAlign = "center";
        ctx.globalAlpha = 0.8;
        ctx.fillStyle = pal.text1;
        ctx.fillText("held loaded", c.x, c.y - Math.max(4, rpx) - 4);
      }
      ctx.restore();
    }

    /* A teleport or nether crossing is NOT a path, so it is drawn as a dashed
       hop with both ends marked -- never as a line the player walked. */
    function drawTrackEvents() {
      if (!trackEvents || !state.showTracks) return;
      ctx.save();
      ctx.setLineDash([4, 4]);
      for (var i = 0; i < trackEvents.length; i++) {
        var e = trackEvents[i];
        if (e.endMs < state.t0 || e.ms > state.cursor) continue;
        var a = worldToScreen(e.fromTx, e.fromTz, 64);
        var b = worldToScreen(e.toTx, e.toTz, 64);
        /* Dash pattern carries confidence. A jump we can account for -- both ends
           by a public portal, a nether pace that works out, or a distance inside
           ender-pearl range -- gets an even dash: a real connection the player
           made, just not on foot. One we cannot account for gets a sparse dot,
           so it never reads as an explained route. */
        var explained = !!e.explains;
        ctx.setLineDash(explained ? [5, 4] : [1, 5]);
        ctx.strokeStyle = e.kind === "portal" ? pal.warning : pal.critical;
        ctx.lineWidth = explained ? 1.5 : 1;
        ctx.globalAlpha = explained ? 0.85 : 0.5;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = ctx.strokeStyle;
        ctx.beginPath(); ctx.arc(b.x, b.y, 3.5, 0, 6.2832); ctx.fill();
        ctx.setLineDash([4, 4]);
      }
      ctx.restore();
    }

    /* ---------------------------------------------------- marker layer ---- */

    /* World -> screen THROUGH THE SELECTED MAP'S OWN PROJECTION.
       A flat overhead map happens to reduce to a plain divide, but an isometric
       one does not: it rotates and shears, which is why Dynmap draws the world
       border as a diamond there rather than a square. Using the flat shortcut on
       an isometric map put every marker in the wrong place. The tile grid is
       already the map's pixel space divided by the tile size, so:

           gx =  mapX / tileSize        gy = -mapY / tileSize

       (gy is negated for the same reason gy = -tz: higher map Y draws upward.)
       Height matters on an isometric projection, hence the y argument. */
    function worldToScreen(wx, wz, wy) {
      var cfg = state.mapCfg;
      if (!cfg || !cfg.worldtomap) {
        var bpt = state.model ? state.model.blocksPerTile : M.BLOCKS_PER_TILE;
        return toScreen(wx / bpt, wz / bpt);
      }
      var a = cfg.worldtomap, size = 128 << (parseInt(cfg.tilescale, 10) || 0);
      var y = wy === undefined ? 64 : wy;
      var mx = a[0] * wx + a[1] * y + a[2] * wz;
      var my = a[3] * wx + a[4] * y + a[5] * wz;
      return toScreen(mx / size, -my / size);
    }

    /* Grid units through the active projection. The overlays were written in
       grid units against toScreen, which is only correct while the map is
       overhead; this is the same thing routed through worldtomap, and it
       collapses back to toScreen exactly when the projection is flat (grid
       (gx,gy) is world (gx*bpt, gy*bpt), and flat2's 16 px per block over a
       128px tile gives mx/size = gx, -my/size = gy). */
    function projGrid(gx, gy) {
      var bpt = state.model ? state.model.blocksPerTile : M.BLOCKS_PER_TILE;
      return worldToScreen(gx * bpt, gy * bpt, 64);
    }

    /* Inverse of projGrid at the same nominal height. Needed because on a
       skewed map the visible world region is a rotated quad, so the range of
       overlay tiles to draw cannot be read off the screen corners directly. */
    function screenToGrid(px, py) {
      var cfg = state.mapCfg;
      var bpt = state.model ? state.model.blocksPerTile : M.BLOCKS_PER_TILE;
      if (!cfg || !cfg.worldtomap) return toGrid(px, py);
      var a = cfg.worldtomap, size = 128 << (parseInt(cfg.tilescale, 10) || 0);
      var g = toGrid(px, py);
      var mx = g.gx * size, my = -g.gy * size, y = 64;
      var det = a[0] * a[5] - a[2] * a[3];
      if (Math.abs(det) < 1e-12) return toGrid(px, py);
      var u = mx - a[1] * y, v = my - a[4] * y;
      return { gx: (u * a[5] - v * a[2]) / det / bpt,
               gy: (a[0] * v - a[3] * u) / det / bpt };
    }

    /* Grid-space bounding box of everything currently on screen. On a flat map
       this is just the two opposite corners; on a skewed one all four matter,
       because the quad's extremes are not its diagonal. */
    function visibleGridBox() {
      var pts = [screenToGrid(0, 0), screenToGrid(state.w, 0),
                 screenToGrid(0, state.h), screenToGrid(state.w, state.h)];
      var b = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
      for (var i = 0; i < pts.length; i++) {
        if (pts[i].gx < b.x0) b.x0 = pts[i].gx;
        if (pts[i].gx > b.x1) b.x1 = pts[i].gx;
        if (pts[i].gy < b.y0) b.y0 = pts[i].gy;
        if (pts[i].gy > b.y1) b.y1 = pts[i].gy;
      }
      return b;
    }

    /* Paint an axis-aligned grid-space rectangle of image through the
       projection. The map matrix is linear in x and z at a fixed height, so the
       rectangle lands as a PARALLELOGRAM -- which canvas can draw directly by
       composing the transform, rather than us slicing the bitmap up. Columns of
       the matrix are the screen steps per image pixel along u and v. */
    function drawWarped(img, gx0, gy0, gx1, gy1) {
      var p00 = projGrid(gx0, gy0), p10 = projGrid(gx1, gy0), p01 = projGrid(gx0, gy1);
      var iw = img.naturalWidth || img.width || 1;
      var ih = img.naturalHeight || img.height || 1;
      // Overdraw by about one screen pixel so neighbours do not show a seam.
      var wpx = Math.hypot(p10.x - p00.x, p10.y - p00.y) || 1;
      var hpx = Math.hypot(p01.x - p00.x, p01.y - p00.y) || 1;
      var ou = 1 + 1 / wpx, ov = 1 + 1 / hpx;
      ctx.save();
      ctx.transform((p10.x - p00.x) / iw, (p10.y - p00.y) / iw,
                    (p01.x - p00.x) / ih, (p01.y - p00.y) / ih,
                    p00.x, p00.y);
      ctx.drawImage(img, 0, 0, iw * ou, ih * ov);
      ctx.restore();
    }

    /* Is the selected map a straight overhead view? Isometric maps fold height
       into their vertical axis, so a block-numbered ruler along the screen axes
       is meaningless on them. */
    function isFlatProjection() {
      var cfg = state.mapCfg;
      if (!cfg || !cfg.worldtomap) return true;
      return Math.abs(cfg.worldtomap[4]) < 1e-9;   // no y term in mapY
    }

    /* Draws whatever Dynmap publishes: areas (the world border is one), lines,
       circles and point markers. Their own colours are honoured rather than
       restyled -- this layer is "what the server says", and the world border in
       particular is meaningful precisely because it is the server's own. */
    function drawMarkers() {
      if (!markers || !state.showMarkers) return;
      var sets = markers.sets || {};
      ctx.save();
      for (var name in sets) {
        var set = sets[name];
        if (!set || set.hide) continue;
        eachValue(set.areas, drawArea);
        eachValue(set.lines, drawLine);
        eachValue(set.circles, drawCircle);
        eachValue(set.markers, drawPoint);
      }
      ctx.restore();
    }

    function eachValue(obj, fn) {
      if (!obj) return;
      for (var k in obj) if (obj[k]) fn(obj[k], k);
    }

    function drawArea(a) {
      if (!a.x || !a.z || a.x.length < 2) return;
      ctx.beginPath();
      for (var i = 0; i < a.x.length; i++) {
        var p = worldToScreen(a.x[i], a.z[i], a.ytop);
        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      if (a.fillopacity > 0) {
        ctx.globalAlpha = a.fillopacity;
        ctx.fillStyle = a.fillcolor || "#000000";
        ctx.fill();
      }
      ctx.globalAlpha = a.opacity === undefined ? 0.8 : a.opacity;
      ctx.strokeStyle = a.color || "#ff0000";
      ctx.lineWidth = Math.max(1, a.weight || 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    function drawLine(l) {
      if (!l.x || !l.z || l.x.length < 2) return;
      ctx.beginPath();
      for (var i = 0; i < l.x.length; i++) {
        var p = worldToScreen(l.x[i], l.z[i], l.ytop);
        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.globalAlpha = l.opacity === undefined ? 0.8 : l.opacity;
      ctx.strokeStyle = l.color || "#ff0000";
      ctx.lineWidth = Math.max(1, l.weight || 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    function drawCircle(c) {
      if (c.x === undefined || c.z === undefined) return;
      var bpt = state.model ? state.model.blocksPerTile : M.BLOCKS_PER_TILE;
      var p = worldToScreen(c.x, c.z, c.ytop);
      var rx = Math.abs((c.xr || 0) / bpt) * state.scale;
      var rz = Math.abs((c.zr || c.xr || 0) / bpt) * state.scale;
      if (rx < 0.5 && rz < 0.5) return;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, rx, rz, 0, 0, 6.2832);
      if (c.fillopacity > 0) {
        ctx.globalAlpha = c.fillopacity;
        ctx.fillStyle = c.fillcolor || "#000000";
        ctx.fill();
      }
      ctx.globalAlpha = c.opacity === undefined ? 0.8 : c.opacity;
      ctx.strokeStyle = c.color || "#ff0000";
      ctx.lineWidth = Math.max(1, c.weight || 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    /* Point markers (spawn, and whatever else the server publishes). Drawn as a
       small ring + label rather than fetching Dynmap's icon sprites, which would
       be a lot of extra requests for decoration. */
    function drawPoint(mk) {
      if (mk.x === undefined || mk.z === undefined) return;
      var p = worldToScreen(mk.x, mk.z, mk.y);
      if (p.x < -40 || p.x > state.w + 40 || p.y < -40 || p.y > state.h + 40) return;
      ctx.strokeStyle = pal.text1;
      ctx.fillStyle = pal.surface1;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, 6.2832); ctx.fill(); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p.x - 7, p.y); ctx.lineTo(p.x + 7, p.y);
      ctx.moveTo(p.x, p.y - 7); ctx.lineTo(p.x, p.y + 7);
      ctx.stroke();
      if (mk.label && state.scale >= 2) {
        ctx.font = "10px system-ui, -apple-system, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        var w = ctx.measureText(mk.label).width;
        ctx.fillStyle = pal.surface1;
        ctx.globalAlpha = 0.85;
        ctx.fillRect(p.x - w / 2 - 3, p.y - 22, w + 6, 13);
        ctx.globalAlpha = 1;
        ctx.fillStyle = pal.text1;
        ctx.fillText(mk.label, p.x, p.y - 11);
      }
    }

    function outline(cell, color, lw) {
      var r = cellRect(cell.tx, cell.tz);
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.strokeRect(Math.round(r.x) - 0.5, Math.round(r.y) - 0.5, Math.round(r.s) + 1, Math.round(r.s) + 1);
    }

    /* Recessive world-coordinate ruler down the top and left edges. Labels are
       in BLOCKS, which is what a player actually reads off F3, with the tile
       number in the tooltip for anyone matching against a filename. */
    function drawRuler(vis) {
      var bpt = state.model ? state.model.blocksPerTile : M.BLOCKS_PER_TILE;
      var w = state.w, h = state.h;
      ctx.font = "10px ui-monospace, SFMono-Regular, Consolas, monospace";
      ctx.fillStyle = pal.text3;
      ctx.textBaseline = "top";

      /* On an isometric map the screen axes are not world axes -- X and Z both
         run diagonally and height shifts things vertically -- so numbering the
         edges in blocks would be a lie. Draw the world grid PROJECTED instead,
         the way Dynmap does, and label the tile numbers. */
      if (!isFlatProjection()) {
        drawProjectedWorldGrid();
        ctx.textAlign = "right";
        ctx.fillStyle = pal.text3;
        ctx.fillText("isometric view - world grid projected", w - 4, h - 14);
        return;
      }

      var stepBlocks = niceStep(bpt * 64 / state.scale);
      var stepTiles = Math.max(1, Math.round(stepBlocks / bpt));

      ctx.textAlign = "center";
      for (var tx = Math.ceil(vis.tx0 / stepTiles) * stepTiles; tx <= vis.tx1; tx += stepTiles) {
        var p = toScreen(tx, 0);
        if (p.x < 18 || p.x > w - 18) continue;
        ctx.fillText(String(tx * bpt), p.x, 3);
      }
      ctx.textAlign = "left";
      for (var tz = Math.ceil(vis.tz0 / stepTiles) * stepTiles; tz <= vis.tz1; tz += stepTiles) {
        var q = toScreen(0, -tz);
        if (q.y < 14 || q.y > h - 8) continue;
        ctx.fillText(String(-tz * bpt), 3, q.y + 2);
      }
      ctx.textAlign = "right";
      ctx.fillStyle = pal.text3;
      ctx.fillText("X →   ↓ Z   (blocks)", w - 4, h - 14);
    }

    /* Lines of constant world X and constant world Z, run through the map's own
       projection so they come out skewed -- which is what makes an isometric view
       readable as a world rather than as a grid of pictures. */
    function drawProjectedWorldGrid() {
      var a = toGrid(0, 0), b = toGrid(state.w, state.h);
      var cfg = state.mapCfg, size = 128 << (parseInt(cfg.tilescale, 10) || 0);
      // Convert the visible corners back to a generous world box.
      var reach = Math.max(Math.abs(a.gx), Math.abs(b.gx), Math.abs(a.gy), Math.abs(b.gy)) * size;
      var scaleGuess = Math.abs(cfg.worldtomap[0]) || 16;
      var extent = Math.ceil(reach / scaleGuess) + 256;
      var step = niceStep(extent / 6);
      if (!(step > 0)) return;

      ctx.strokeStyle = pal.grid;
      ctx.lineWidth = 1;
      ctx.font = "10px ui-monospace, SFMono-Regular, Consolas, monospace";
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";

      for (var v = -extent; v <= extent; v += step) {
        // constant X, varying Z
        var p1 = worldToScreen(v, -extent, 64), p2 = worldToScreen(v, extent, 64);
        ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
        // constant Z, varying X
        var q1 = worldToScreen(-extent, v, 64), q2 = worldToScreen(extent, v, 64);
        ctx.beginPath(); ctx.moveTo(q1.x, q1.y); ctx.lineTo(q2.x, q2.y); ctx.stroke();
      }
      // Label the two axes where they cross the visible area.
      ctx.fillStyle = pal.text3;
      var ox = worldToScreen(extent, 0, 64), oz = worldToScreen(0, extent, 64);
      if (ox.x > 0 && ox.x < state.w && ox.y > 0 && ox.y < state.h) ctx.fillText("+X", ox.x + 4, ox.y);
      if (oz.x > 0 && oz.x < state.w && oz.y > 0 && oz.y < state.h) ctx.fillText("+Z", oz.x + 4, oz.y);
    }

    function niceStep(v) {
      var pow = Math.pow(10, Math.floor(Math.log10(Math.max(1, v))));
      var n = v / pow;
      return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
    }

    /* Tiles whose corrected render time sits within tol of a moment -- used both
       for the cursor highlight and for "what just changed" readouts. */
    function tilesAt(ms, tol) {
      var m = state.model, out = [];
      if (!m) return out;
      var i = lowerBound(m.tiles, ms - tol);
      for (; i < m.tiles.length; i++) {
        if (m.tiles[i].tileMs > ms) break;
        out.push(m.tiles[i]);
      }
      return out;
    }

    /* ------------------------------------------------------------ interaction */

    var pointers = new Map(), dragged = false, pinch = null;

    canvas.addEventListener("pointerdown", function (ev) {
      canvas.setPointerCapture(ev.pointerId);
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY, sx: ev.clientX, sy: ev.clientY });
      dragged = false;
      if (pointers.size === 2) {
        var p = Array.from(pointers.values());
        pinch = { d: dist(p[0], p[1]), scale: state.scale };
      }
    });

    canvas.addEventListener("pointermove", function (ev) {
      var rect = canvas.getBoundingClientRect();
      var prev = pointers.get(ev.pointerId);

      if (!prev) {
        // Hover only: no button held.
        var c = cellAt(ev.clientX - rect.left, ev.clientY - rect.top);
        var changed = !state.hover || state.hover.tx !== c.tx || state.hover.tz !== c.tz;
        state.hover = c;
        if (changed) { invalidate(); if (opts.onHover) opts.onHover(describe(c.tx, c.tz), ev.clientX, ev.clientY); }
        return;
      }

      if (pointers.size === 2 && pinch) {
        pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY, sx: prev.sx, sy: prev.sy });
        var pp = Array.from(pointers.values());
        var d = dist(pp[0], pp[1]);
        if (pinch.d > 0) setScale(pinch.scale * (d / pinch.d), state.w / 2, state.h / 2);
        dragged = true;
        return;
      }

      var dx = ev.clientX - prev.x, dy = ev.clientY - prev.y;
      if (Math.abs(ev.clientX - prev.sx) > 3 || Math.abs(ev.clientY - prev.sy) > 3) dragged = true;
      state.gx -= dx / state.scale;
      state.gy -= dy / state.scale;
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY, sx: prev.sx, sy: prev.sy });
      invalidate();
    });

    function endPointer(ev) {
      var had = pointers.get(ev.pointerId);
      pointers.delete(ev.pointerId);
      if (pointers.size < 2) pinch = null;
      if (had && !dragged && ev.type === "pointerup") {
        var rect = canvas.getBoundingClientRect();
        var px = ev.clientX - rect.left, py = ev.clientY - rect.top;
        /* A track under the pointer wins over the tile beneath it: the track is
           the smaller, more deliberate target, and the tile is always available
           by clicking away from one. */
        if (state.showTracks && opts.onTrackSelect) {
          var g = toGrid(px, py);
          var bpt = state.model ? state.model.blocksPerTile : M.BLOCKS_PER_TILE;
          var hit = api.trackAt(g.gx * bpt, -g.gy * bpt);
          if (hit) {
            state.selectedTrack = hit.id;
            invalidate();
            opts.onTrackSelect(hit);
            return;
          }
        }
        var c = cellAt(px, py);
        state.selected = c;
        state.selectedTrack = null;
        invalidate();
        if (opts.onSelect) opts.onSelect(describe(c.tx, c.tz));
      }
      if (!pointers.size && opts.onHover && ev.pointerType !== "mouse") opts.onHover(null);
    }
    canvas.addEventListener("pointerup", endPointer);
    canvas.addEventListener("pointercancel", endPointer);
    canvas.addEventListener("pointerleave", function (ev) {
      if (!pointers.size) { state.hover = null; invalidate(); if (opts.onHover) opts.onHover(null); }
    });

    canvas.addEventListener("wheel", function (ev) {
      ev.preventDefault();
      var rect = canvas.getBoundingClientRect();
      var f = Math.pow(1.0015, -ev.deltaY * (ev.deltaMode === 1 ? 16 : 1));
      setScale(state.scale * f, ev.clientX - rect.left, ev.clientY - rect.top);
    }, { passive: false });

    function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

    /* Zoom about a screen point so the tile under the cursor stays put. */
    function setScale(next, ax, ay) {
      next = Math.max(0.4, Math.min(96, next));
      if (next === state.scale) return;
      var before = toGrid(ax, ay);
      state.scale = next;
      var after = toGrid(ax, ay);
      state.gx += before.gx - after.gx;
      state.gy += before.gy - after.gy;
      invalidate();
      if (opts.onView) opts.onView(view());
    }

    /* -------------------------------------------------------------- readout */

    function describe(tx, tz) {
      var bpt = state.model ? state.model.blocksPerTile : M.BLOCKS_PER_TILE;
      var wc = M.tileWorld(tx, tz, bpt), ch = M.tileChunk(tx, tz, bpt);
      var cell = heat.get(tx + "," + tz) || null;
      var all = state.model ? state.model.tileIndex.get(M.tileKey(tx, tz)) : null;
      var pick = bestUrl(tx, tz);
      return {
        tx: tx, tz: tz, world: wc, chunk: ch,
        inWindow: cell ? cell.n : 0,
        total: all ? all.events.length : 0,
        lastMs: cell ? cell.lastMs : NaN,
        firstMs: cell ? cell.firstMs : NaN,
        heat: cell ? cell.v : 0,
        bin: cell ? heatBin(cell.v) : -1,
        image: pick,
        last: cell ? cell.last : null,
        events: all ? all.events.map(function (i) { return state.model.tiles[i]; }) : []
      };
    }

    function view() { return { gx: state.gx, gy: state.gy, scale: state.scale }; }

    /* Frame the whole logged area, or a given tile, with a little margin. */
    function fit(box) {
      var m = state.model;
      var b = box || (m ? m.tileBounds : { minTx: -8, maxTx: 8, minTz: -8, maxTz: 8 });
      resize();
      var wTiles = Math.max(1, b.maxTx - b.minTx + 1), hTiles = Math.max(1, b.maxTz - b.minTz + 1);
      var sx = state.w / (wTiles * 1.08), sy = state.h / (hTiles * 1.08);
      state.scale = Math.max(0.4, Math.min(96, Math.min(sx, sy)));
      state.gx = (b.minTx + b.maxTx + 1) / 2;
      state.gy = -(b.minTz + b.maxTz + 1) / 2;
      invalidate();
      if (opts.onView) opts.onView(view());
    }

    function centerOn(tx, tz, scale) {
      state.gx = tx + 0.5;
      state.gy = -tz - 0.5;
      if (scale) state.scale = Math.max(0.4, Math.min(96, scale));
      invalidate();
    }

    /* Hottest cells in the current window -- feeds the "top tiles" table, which
       is also the non-colour route to the same ranking the heatmap encodes. */
    /* Bounded selection, not a full sort: this runs on the throttled render path
       several times a second, and sorting every lit cell to show the top dozen is
       most of the work thrown away. Keeps an ordered array of at most n. */
    function topCells(n) {
      var want = n || 10, best = [];
      heat.forEach(function (c) {
        if (best.length === want && c.v <= best[best.length - 1].v) return;
        var lo = 0, hi = best.length;
        while (lo < hi) { var mid = (lo + hi) >> 1; if (best[mid].v > c.v) lo = mid + 1; else hi = mid; }
        best.splice(lo, 0, c);
        if (best.length > want) best.pop();
      });
      return best.map(function (c) {
        var bpt = state.model ? state.model.blocksPerTile : M.BLOCKS_PER_TILE;
        return { tx: c.tx, tz: c.tz, n: c.n, v: c.v, bin: heatBin(c.v),
                 lastMs: c.lastMs, world: M.tileWorld(c.tx, c.tz, bpt) };
      });
    }

    var api = {
      canvas: canvas,
      setModel: function (m) {
        state.model = m;
        urlTemplate = null;
        if (m && m.tiles.length) {
          var t = m.tiles[0];
          /* Rebuild the tile URL pattern from a row we already have, so context
             fills work without the viewer having to be told the server address.

             The cache-buster is fixed for the life of the page, NOT per rebuild.
             Keying it off the model stamp minted fresh URLs for every unchanged
             context tile on every live poll -- up to ~700 refetches every few
             seconds, which also thrashed the image cache so nothing was ever
             reused. These are "current render" tiles; their staleness has nothing
             to do with how often the CSV grows. Use "Reload now" to refetch. */
          urlTemplate = function (tx, tz) {
            return t.origin + "/tiles/" + t.world + "/" + t.map + "/" +
                   (tx >> 5) + "_" + (tz >> 5) + "/" + tx + "_" + tz + ".png?v=" + sessionStamp;
          };
        }
        recomputeHeat(); invalidate();
      },
      setWindow: function (t0, t1, cursor) {
        state.t0 = t0; state.t1 = t1; state.cursor = cursor;
        recomputeHeat(); invalidate();
      },
      set: function (patch) {
        var reheat = false;
        for (var k in patch) {
          if (state[k] === patch[k]) continue;
          state[k] = patch[k];
          if (k === "heatMetric" || k === "halfLifeMs" || k === "heatScale" || k === "tileKinds") reheat = true;
        }
        if (reheat) recomputeHeat();
        invalidate();
      },
      get: function (k) { return state[k]; },
      setHistorical: function (set) { historical = set; images.clear(); invalidate(); },
      setMarkers: function (data) { markers = data; invalidate(); },
      setMapConfig: function (cfg) { state.mapCfg = cfg || null; invalidate(); },
      setTracks: function (t, evs) {
        tracks = t; trackEvents = evs || null;
        /* Re-derive the roster whenever the tracks change, so hue indices are a
           function of who is present rather than of build order. */
        var names = [], seen = Object.create(null);
        for (var i = 0; t && i < t.length; i++) {
          var p = t[i].player;
          if (p && !seen[p]) { seen[p] = 1; names.push(p); }
        }
        registerPlayers(names);
        invalidate();
      },
      trackHue: trackHue,
      /* Nearest track to a world point, for click-to-inspect. Threshold scales
         with zoom so the target stays roughly finger-sized on screen. */
      trackAt: function (wx, wz) {
        if (!tracks) return null;
        var filter = (state.trackFilter || "").toLowerCase();
        var tol = Math.max(24, 14 / Math.max(0.05, state.scale) * 8);
        var best = null, bestD = Infinity;
        for (var i = 0; i < tracks.length; i++) {
          var tr = tracks[i];
          if (tr.lastMs < state.t0 || tr.startMs > state.cursor) continue;
          if (filter && (tr.player || "").toLowerCase().indexOf(filter) < 0) continue;
          /* Hit-test the SEGMENTS, not just the vertices. Points are one per
             60s slice and neighbours sit hundreds of blocks apart, so testing
             vertices alone left almost the whole drawn line dead to the pointer
             -- you could see a track and not be able to click it, which is what
             "I can only click tiles" was. */
          var prev = null;
          for (var j = 0; j < tr.points.length; j++) {
            var p = tr.points[j];
            if (p.ms > state.cursor) break;
            var d = prev ? segDist(wx, wz, prev.tx, prev.tz, p.tx, p.tz)
                         : Math.hypot(p.tx - wx, p.tz - wz);
            if (d < tol && d < bestD) { bestD = d; best = tr; }
            prev = p;
          }
        }
        return best;
      },
      setNelt: function (p, h) { portals = p; highways = h; invalidate(); },
      setPolitical: function (cfg) { state.political = cfg; invalidate(); },
      markerSummary: function () {
        if (!markers || !markers.sets) return null;
        var areas = 0, points = 0, lines = 0, circles = 0, border = null;
        for (var n in markers.sets) {
          var s = markers.sets[n];
          for (var a in (s.areas || {})) {
            areas++;
            if (/worldborder/i.test(a)) border = s.areas[a];
          }
          for (var p in (s.markers || {})) points++;
          for (var l in (s.lines || {})) lines++;
          for (var c in (s.circles || {})) circles++;
        }
        return { areas: areas, points: points, lines: lines, circles: circles, border: border };
      },
      refreshPalette: function () { pal = readPalette(canvas); invalidate(); },
      clearImageCache: function () {
        images.clear(); queue.length = 0;
        sessionStamp = Date.now();   // an explicit reload should really refetch
        invalidate();
      },
      redraw: invalidate, flush: flush,
      resize: function () { resize(); invalidate(); },
      fit: fit, centerOn: centerOn, view: view,
      describe: describe, tilesAt: tilesAt, topCells: topCells,
      heatLegend: heatLegend,
      status: function () {
        return { cells: heatCount, max: heatMax, suppressedImages: suppressedImages,
                 scale: state.scale, loading: inflight + queue.length,
                 politicalLod: politicalLodUsed, politicalTiles: politicalDrawn };
      },
      zoomBy: function (f) { setScale(state.scale * f, state.w / 2, state.h / 2); }
    };
    return api;
  }

  DV.createMap = createMap;
})(window.DV);

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
      mode: "hybrid",            // heat | images | hybrid
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
      showGrid: true,
      showRuler: true,
      showMarkers: true,        // Dynmap's marker layer (world border, spawn, ...)
      tileKinds: "all",         // all | edits | loads  -- see the classification note in model.js
      showTracks: false,        // inferred player tracks (see infer.js)
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
      if (state.showGrid && s >= 7) {
        ctx.strokeStyle = pal.grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (var gx = vis.tx0; gx <= vis.tx1; gx++) {
          var p = toScreen(gx, 0);
          var x = Math.round(p.x) + 0.5;
          ctx.moveTo(x, 0); ctx.lineTo(x, h);
        }
        for (var gy = -vis.tz1; gy <= -vis.tz0; gy++) {
          var q = toScreen(0, gy);
          var y = Math.round(q.y) + 0.5;
          ctx.moveTo(0, y); ctx.lineTo(w, y);
        }
        ctx.stroke();
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
      drawMarkers();

      /* --- selection + hover ------------------------------------------- */
      if (state.selected) outline(state.selected, pal.players, 2);
      if (state.hover) outline(state.hover, pal.text1, 1);

      if (state.showRuler) drawRuler(vis);
    }

    /* ----------------------------------------------------- track layer ---- */

    /* Tracks are drawn as a path through the chunk loads that were linked
       together, brightest at the head so direction of travel is visible. Colour
       is per track, from the categorical slots, so two tracks crossing stay
       distinguishable. */
    var TRACK_HUES = ["--series-players", "--series-tiles", "--series-3",
                      "--status-good", "--status-warning", "--status-critical"];

    function drawTracks() {
      if (!tracks || !state.showTracks || !tracks.length) return;
      var cs = getComputedStyle(canvas);
      ctx.save();
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      for (var i = 0; i < tracks.length; i++) {
        var tr = tracks[i];
        if (tr.lastMs < state.t0 || tr.startMs > state.cursor) continue;
        var col = cs.getPropertyValue(TRACK_HUES[i % TRACK_HUES.length]).trim();
        var pts = tr.points.filter(function (p) { return p.ms <= state.cursor; });
        if (pts.length < 2) continue;
        ctx.strokeStyle = col;
        ctx.lineWidth = 2;
        ctx.globalAlpha = tr.confident ? 0.9 : 0.5;   // unattributed tracks recede
        ctx.beginPath();
        for (var j = 0; j < pts.length; j++) {
          var c = cellRect(pts[j].tx, pts[j].tz);
          var x = c.x + c.s / 2, y = c.y + c.s / 2;
          if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
        // head of the track = where it got to
        var last = cellRect(pts[pts.length - 1].tx, pts[pts.length - 1].tz);
        ctx.globalAlpha = 1;
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(last.x + last.s / 2, last.y + last.s / 2, 4, 0, 6.2832);
        ctx.fill();
        if (tr.player && state.scale >= 1.5) {
          ctx.font = "10px system-ui, -apple-system, sans-serif";
          ctx.textAlign = "center";
          ctx.fillStyle = pal.text1;
          ctx.fillText(tr.player, last.x + last.s / 2, last.y + last.s / 2 - 8);
        }
      }
      ctx.restore();
    }

    /* ---------------------------------------------------- marker layer ---- */

    /* World coordinates land on the tile grid by a plain divide, because the grid
       IS world space scaled by the tile size: gx = worldX/bpt and gy = worldZ/bpt
       (the Z inversion is already baked into gy = -tz). So markers, which Dynmap
       publishes in raw world coordinates, need no projection of their own. */
    function worldToScreen(wx, wz) {
      var bpt = state.model ? state.model.blocksPerTile : M.BLOCKS_PER_TILE;
      return toScreen(wx / bpt, wz / bpt);
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
        var p = worldToScreen(a.x[i], a.z[i]);
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
        var p = worldToScreen(l.x[i], l.z[i]);
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
      var p = worldToScreen(c.x, c.z);
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
      var p = worldToScreen(mk.x, mk.z);
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
      ctx.font = "10px " + "ui-monospace, SFMono-Regular, Consolas, monospace";
      ctx.fillStyle = pal.text3;
      ctx.textBaseline = "top";

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
        var c = cellAt(ev.clientX - rect.left, ev.clientY - rect.top);
        state.selected = c;
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

    return {
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
      setTracks: function (t) { tracks = t; invalidate(); },
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
                 scale: state.scale, loading: inflight + queue.length };
      },
      zoomBy: function (f) { setScale(state.scale * f, state.w / 2, state.h / 2); }
    };
  }

  DV.createMap = createMap;
})(window.DV);

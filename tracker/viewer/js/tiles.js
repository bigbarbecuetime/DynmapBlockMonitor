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
      heat: [v("--heat-0"), v("--heat-1"), v("--heat-2"), v("--heat-3"), v("--heat-4"), v("--heat-5")]
    };
  }

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

    function lowerBound(arr, ms) {
      var lo = 0, hi = arr.length;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (arr[mid].tileMs < ms) lo = mid + 1; else hi = mid; }
      return lo;
    }

    /* Recomputed whenever the window or cursor moves. Only tiles whose corrected
       render time falls in [windowStart, cursor] contribute, so scrubbing the
       cursor genuinely rewinds the map instead of just dimming it. */
    function recomputeHeat() {
      heat.clear(); heatMax = 0; heatCount = 0;
      var m = state.model;
      if (!m || !m.tiles.length) return;
      var from = state.t0, to = state.cursor;
      var i = lowerBound(m.tiles, from);
      var tau = state.halfLifeMs / Math.LN2;
      for (; i < m.tiles.length; i++) {
        var t = m.tiles[i];
        if (t.tileMs > to) break;
        var k = t.tx + "," + t.tz;
        var c = heat.get(k);
        if (!c) { c = { v: 0, n: 0, lastMs: -Infinity, firstMs: t.tileMs, tx: t.tx, tz: t.tz, last: null }; heat.set(k, c); }
        c.n++;
        c.lastMs = t.tileMs;
        c.last = t;
        if (state.heatMetric === "recency") c.v += Math.exp(-(to - t.tileMs) / tau);
        else c.v = c.n;
      }
      heat.forEach(function (c) {
        if (state.heatMetric === "last") {
          // Newest change = hottest. Age is inverted against the window length so
          // the ramp still runs low->high like every other metric.
          var span = Math.max(1, to - from);
          c.v = Math.max(0, 1 - (to - c.lastMs) / span);
        }
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
        // Cheap eviction: drop the oldest inserted entries (Map keeps order).
        var drop = images.size - CACHE_LIMIT, it = images.keys();
        for (var i = 0; i < drop; i++) { var k = it.next().value; if (k) images.delete(k); }
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
        ctx.globalAlpha = alpha;
        heat.forEach(function (c) {
          if (c.tx < vis.tx0 || c.tx > vis.tx1 || c.tz < vis.tz0 || c.tz > vis.tz1) return;
          var b = heatBin(c.v);
          if (b < 0) return;
          var r = cellRect(c.tx, c.tz);
          ctx.fillStyle = pal.heat[b];
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

      /* --- selection + hover ------------------------------------------- */
      if (state.selected) outline(state.selected, pal.players, 2);
      if (state.hover) outline(state.hover, pal.text1, 1);

      if (state.showRuler) drawRuler(vis);
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
    function topCells(n) {
      var arr = [];
      heat.forEach(function (c) { arr.push(c); });
      arr.sort(function (a, b) { return b.v - a.v || b.n - a.n; });
      return arr.slice(0, n || 10).map(function (c) {
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
          // Rebuild the tile URL pattern from a row we already have, so context
          // fills work without the viewer having to be told the server address.
          urlTemplate = function (tx, tz) {
            return t.origin + "/tiles/" + t.world + "/" + t.map + "/" +
                   (tx >> 5) + "_" + (tz >> 5) + "/" + tx + "_" + tz + ".png?ts=" + (m.stamp || 0);
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
          if (k === "heatMetric" || k === "halfLifeMs" || k === "heatScale") reheat = true;
        }
        if (reheat) recomputeHeat();
        invalidate();
      },
      get: function (k) { return state[k]; },
      setHistorical: function (set) { historical = set; images.clear(); invalidate(); },
      refreshPalette: function () { pal = readPalette(canvas); invalidate(); },
      clearImageCache: function () { images.clear(); queue.length = 0; invalidate(); },
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

/* ============================================================================
   timeline.js -- the scrubber, and the playback clock that drives everything.
   ----------------------------------------------------------------------------
   Two measures share this strip: tile changes per bucket, and players online.
   They are drawn as two STACKED BANDS with their own y scales, never as one
   plot with two y axes -- a dual-axis chart lets you imply any correlation you
   like by sliding one scale against the other, which is exactly the claim this
   viewer exists to test honestly.

   Layout, top to bottom:
     overview   full file span, with the selected window marked (focus+context)
     tiles band tile changes per bucket, bucketed on CORRECTED tile time
     players    online count as a step function, with join/leave ticks
   ========================================================================= */

window.DV = window.DV || {};

(function (DV) {
  "use strict";

  var M = DV.model;

  var H_OVERVIEW = 16, H_TILES = 40, H_PLAYERS = 34, H_GUTTER = 3;

  function createTimeline(canvas, opts) {
    opts = opts || {};
    var ctx = canvas.getContext("2d");
    var pal = null;

    var st = {
      model: null,
      viewA: 0, viewB: 1,     // the visible span of the main bands
      viewInit: false,        // has the view ever been framed to real data?
      t0: 0, t1: 1,           // the selected analysis window
      cursor: 0,
      compact: false,
      hoverX: null
    };

    function palette() {
      var cs = getComputedStyle(canvas);
      function v(n) { return cs.getPropertyValue(n).trim(); }
      return {
        surface: v("--surface-1"), inset: v("--surface-2"),
        text1: v("--text-1"), text2: v("--text-2"), text3: v("--text-3"),
        grid: v("--grid"), axis: v("--axis"), border: v("--border"),
        tiles: v("--series-tiles"), players: v("--series-players"),
        good: v("--status-good"), warning: v("--status-warning"),
        serious: v("--status-serious"), critical: v("--status-critical")
      };
    }

    function heights() {
      return st.compact
        ? { ov: 12, tiles: 26, players: 24 }
        : { ov: H_OVERVIEW, tiles: H_TILES, players: H_PLAYERS };
    }

    function totalHeight() {
      var h = heights();
      return h.ov + H_GUTTER + h.tiles + H_GUTTER + h.players;
    }

    function resize() {
      var dpr = Math.min(2.5, window.devicePixelRatio || 1);
      var r = canvas.getBoundingClientRect();
      var w = Math.max(1, Math.round(r.width));
      var h = totalHeight();
      canvas.style.height = h + "px";
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr; canvas.height = h * dpr;
      }
      st.w = w; st.h = h; st.dpr = dpr;
    }

    /* ------------------------------------------------------------ geometry */

    function xOf(ms) { return (ms - st.viewA) / Math.max(1, st.viewB - st.viewA) * st.w; }
    function msOf(x) { return st.viewA + (x / Math.max(1, st.w)) * (st.viewB - st.viewA); }
    function xOfOv(ms) {
      var b = st.model ? st.model.bounds : { minMs: 0, maxMs: 1 };
      return (ms - b.minMs) / Math.max(1, b.maxMs - b.minMs) * st.w;
    }
    function msOfOv(x) {
      var b = st.model ? st.model.bounds : { minMs: 0, maxMs: 1 };
      return b.minMs + (x / Math.max(1, st.w)) * (b.maxMs - b.minMs);
    }

    function bands() {
      var h = heights();
      var y = 0;
      var ov = { y: y, h: h.ov }; y += h.ov + H_GUTTER;
      var tiles = { y: y, h: h.tiles }; y += h.tiles + H_GUTTER;
      var players = { y: y, h: h.players };
      return { ov: ov, tiles: tiles, players: players };
    }

    /* ------------------------------------------------------------ bucketing */

    var buckets = null, bucketW = 3, bucketMs = 1, playerMax = 1;

    function rebucket() {
      var m = st.model;
      buckets = null;
      if (!m) return;
      var n = Math.max(1, Math.floor(st.w / bucketW));
      bucketMs = Math.max(1, (st.viewB - st.viewA) / n);
      var arr = new Float64Array(n);
      var tiles = m.tiles;
      // Bucketed on tileMs -- the corrected render time. Using capture time here
      // would slide the whole histogram right by the render lag.
      var lo = lowerBoundTiles(tiles, st.viewA);
      for (var i = lo; i < tiles.length; i++) {
        var t = tiles[i];
        if (t.tileMs > st.viewB) break;
        var b = Math.floor((t.tileMs - st.viewA) / bucketMs);
        if (b >= 0 && b < n) arr[b]++;
      }
      var max = 0;
      for (i = 0; i < n; i++) if (arr[i] > max) max = arr[i];
      buckets = { arr: arr, n: n, max: max };

      playerMax = 1;
      for (i = 0; i < m.snapshots.length; i++) {
        var s = m.snapshots[i];
        if (s.ms < st.viewA - 60000 || s.ms > st.viewB + 60000) continue;
        if (s.count > playerMax) playerMax = s.count;
      }
    }

    function lowerBoundTiles(arr, ms) {
      var lo = 0, hi = arr.length;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (arr[mid].tileMs < ms) lo = mid + 1; else hi = mid; }
      return lo;
    }

    /* -------------------------------------------------------------- drawing */

    var pending = false;
    function invalidate() {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () { pending = false; draw(); });
    }

    /* See tiles.js flush(): requestAnimationFrame is not serviced while the tab
       is hidden, so the coalescing flag can latch and strand the canvas. */
    function flush() { pending = false; draw(); }

    function draw() {
      if (!pal) pal = palette();
      resize();
      rebucket();
      var w = st.w, b = bands();
      ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
      ctx.clearRect(0, 0, w, st.h);

      drawOverview(b.ov);
      drawTiles(b.tiles);
      drawPlayers(b.players);
      drawCursor(b);
    }

    /* --- overview: whole file, window highlighted ---------------------- */
    function drawOverview(band) {
      var m = st.model;
      ctx.fillStyle = pal.inset;
      ctx.fillRect(0, band.y, st.w, band.h);
      if (!m) return;

      hatchGaps(band, xOfOv, m.bounds.minMs, m.bounds.maxMs);

      // A coarse activity sparkline so the overview shows where the data is.
      var n = Math.max(1, Math.floor(st.w / 2));
      var span = Math.max(1, m.bounds.maxMs - m.bounds.minMs);
      var acc = new Float64Array(n), max = 0;
      for (var i = 0; i < m.tiles.length; i++) {
        var k = Math.floor((m.tiles[i].tileMs - m.bounds.minMs) / span * n);
        if (k >= 0 && k < n) acc[k]++;
      }
      for (i = 0; i < n; i++) if (acc[i] > max) max = acc[i];
      if (max > 0) {
        ctx.fillStyle = pal.tiles;
        ctx.globalAlpha = 0.55;
        for (i = 0; i < n; i++) {
          if (!acc[i]) continue;
          var hh = Math.max(1, acc[i] / max * (band.h - 2));
          ctx.fillRect(i * 2, band.y + band.h - hh - 1, 2, hh);
        }
        ctx.globalAlpha = 1;
      }

      // Selected window: dim what is outside it rather than tinting what is in,
      // so the sparkline colour inside stays true.
      var xa = Math.max(0, xOfOv(st.t0)), xb = Math.min(st.w, xOfOv(st.t1));
      ctx.fillStyle = pal.surface;
      ctx.globalAlpha = 0.66;
      ctx.fillRect(0, band.y, xa, band.h);
      ctx.fillRect(xb, band.y, st.w - xb, band.h);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = pal.players;
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(xa) + 0.5, band.y + 0.5, Math.max(1, Math.round(xb - xa) - 1), band.h - 1);
    }

    /* --- tiles band ---------------------------------------------------- */
    function drawTiles(band) {
      var m = st.model;
      ctx.fillStyle = pal.surface;
      ctx.fillRect(0, band.y, st.w, band.h);
      if (!m) return;

      hatchGaps(band, xOf, st.viewA, st.viewB);
      gridlines(band, buckets ? buckets.max : 0);

      if (buckets && buckets.max > 0) {
        ctx.fillStyle = pal.tiles;
        var gap = bucketW >= 3 ? 1 : 0;             // 1px surface gap between bars
        var r = bucketW >= 4 ? 1.5 : 0;
        for (var i = 0; i < buckets.n; i++) {
          var v = buckets.arr[i];
          if (!v) continue;
          var hh = Math.max(1.5, v / buckets.max * (band.h - 4));
          var x = i * bucketW, bw = Math.max(1, bucketW - gap);
          var y = band.y + band.h - hh;
          if (r && ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(x, y, bw, hh, [r, r, 0, 0]);   // rounded data-end only
            ctx.fill();
          } else {
            ctx.fillRect(x, y, bw, hh);
          }
        }
      }

      // Dynmap poll outages. A run longer than the feed's retention buffer
      // actually lost tiles; a short one was recovered, so they are drawn
      // differently and both are labelled in the tooltip.
      for (var j = 0; j < m.chunkWindows.length; j++) {
        var wd = m.chunkWindows[j];
        var xa = xOf(wd.startMs), xb = xOf(wd.endMs);
        if (xb < 0 || xa > st.w) continue;
        ctx.fillStyle = wd.lossy ? pal.critical : pal.warning;
        ctx.globalAlpha = wd.lossy ? 0.3 : 0.22;
        ctx.fillRect(xa, band.y, Math.max(2, xb - xa), band.h);
        ctx.globalAlpha = 1;
        ctx.fillRect(xa, band.y, Math.max(2, xb - xa), 2);
      }

      label(band, "Tile changes", buckets && buckets.max ? buckets.max + " / " + M.fmtDur(bucketMs) : "none");
    }

    /* --- players band -------------------------------------------------- */
    function drawPlayers(band) {
      var m = st.model;
      ctx.fillStyle = pal.surface;
      ctx.fillRect(0, band.y, st.w, band.h);
      if (!m) return;

      hatchGaps(band, xOf, st.viewA, st.viewB);
      gridlines(band, playerMax);

      var tickH = 6, plotH = band.h - tickH - 3;
      function yOf(c) { return band.y + 2 + (1 - c / Math.max(1, playerMax)) * (plotH - 2); }

      /* players.csv is only written when the value CHANGES, so it is a step
         function: the value holds until the next row. Drawing it as a sloped
         line would invent gradual change that never happened. */
      var snaps = m.snapshots;
      if (snaps.length) {
        ctx.strokeStyle = pal.players;
        ctx.lineWidth = 2;
        ctx.lineJoin = "round";
        ctx.beginPath();
        var started = false, lastX = null, lastY = null;
        for (var i = 0; i < snaps.length; i++) {
          var s = snaps[i];
          var x = xOf(s.ms), y = yOf(s.count);
          if (x < -20) { lastX = x; lastY = y; started = false; continue; }
          if (x > st.w + 20) {
            if (lastY !== null) { ctx.lineTo(st.w, lastY); }
            break;
          }
          if (!started) {
            if (lastY !== null) { ctx.moveTo(Math.max(0, lastX), lastY); ctx.lineTo(x, lastY); ctx.lineTo(x, y); }
            else { ctx.moveTo(x, y); }
            started = true;
          } else {
            ctx.lineTo(x, lastY);   // hold the previous value...
            ctx.lineTo(x, y);       // ...then step to the new one
          }
          lastX = x; lastY = y;
        }
        if (started && lastY !== null) {
          // Carry the last known value to the edge of coverage, not past it.
          var endMs = Math.min(st.viewB, lastCoverageEnd(m, snaps[snaps.length - 1].ms));
          ctx.lineTo(Math.min(st.w, xOf(endMs)), lastY);
        }
        ctx.stroke();

        // Snapshot markers, only when there is room for them to mean anything.
        var spacing = snaps.length > 1 ? st.w / snaps.length : 99;
        if (spacing > 9) {
          for (i = 0; i < snaps.length; i++) {
            var sx = xOf(snaps[i].ms);
            if (sx < -4 || sx > st.w + 4) continue;
            var sy = yOf(snaps[i].count);
            ctx.fillStyle = pal.surface;
            ctx.beginPath(); ctx.arc(sx, sy, 3.5, 0, 6.2832); ctx.fill();  // 2px surface ring
            ctx.fillStyle = pal.players;
            ctx.beginPath(); ctx.arc(sx, sy, 2.2, 0, 6.2832); ctx.fill();
          }
        }
      }

      // Join/leave ticks: direction carries the meaning (up = join, down =
      // leave) so colour is never the only channel. Uncertain ones are hollow.
      var ty = band.y + band.h - tickH;
      for (var k = 0; k < m.transitions.length; k++) {
        var tr = m.transitions[k];
        var tx = xOf(tr.ms);
        if (tx < -3 || tx > st.w + 3) continue;
        var up = tr.type === "join";
        ctx.beginPath();
        if (up) { ctx.moveTo(tx, ty); ctx.lineTo(tx - 3, ty + tickH); ctx.lineTo(tx + 3, ty + tickH); }
        else { ctx.moveTo(tx, ty + tickH); ctx.lineTo(tx - 3, ty); ctx.lineTo(tx + 3, ty); }
        ctx.closePath();
        if (tr.uncertain) {
          ctx.strokeStyle = up ? pal.good : pal.serious;
          ctx.lineWidth = 1;
          ctx.stroke();
        } else {
          ctx.fillStyle = up ? pal.good : pal.serious;
          ctx.fill();
        }
      }

      // Player-ping outages: a hole in a point-sampled series, so mark the
      // instant rather than shading a span we can't characterise.
      for (var e = 0; e < m.playerWindows.length; e++) {
        var pw = m.playerWindows[e];
        var px = xOf(pw.startMs);
        if (px < 0 || px > st.w) continue;
        ctx.fillStyle = pal.critical;
        ctx.fillRect(px - 1, band.y, 2, band.h);
      }

      label(band, "Players online", playerMax ? "peak " + playerMax : "0");
    }

    /* --- shared chrome -------------------------------------------------- */

    /* Outside a tracker run there is no data at all. That is categorically
       different from "no activity", so it gets a hatch, never an empty axis. */
    function hatchGaps(band, xfn, a, bMs) {
      var m = st.model;
      if (!m) return;
      var covers = m.coverage;
      var spans = [];
      var prev = a;
      for (var i = 0; i < covers.length; i++) {
        var c = covers[i];
        if (c.startMs > prev) spans.push([prev, Math.min(c.startMs, bMs)]);
        prev = Math.max(prev, c.endMs);
      }
      if (prev < bMs) spans.push([prev, bMs]);

      ctx.save();
      ctx.beginPath();
      for (i = 0; i < spans.length; i++) {
        var xa = xfn(spans[i][0]), xb = xfn(spans[i][1]);
        if (xb <= xa) continue;
        ctx.rect(xa, band.y, xb - xa, band.h);
      }
      ctx.clip();
      ctx.fillStyle = pal.inset;
      ctx.fillRect(0, band.y, st.w, band.h);
      ctx.strokeStyle = pal.border;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (var x = -band.h; x < st.w + band.h; x += 6) {
        ctx.moveTo(x, band.y + band.h);
        ctx.lineTo(x + band.h, band.y);
      }
      ctx.stroke();
      ctx.restore();
    }

    function gridlines(band, max) {
      ctx.strokeStyle = pal.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      var y = Math.round(band.y + band.h) - 0.5;
      ctx.moveTo(0, y); ctx.lineTo(st.w, y);          // baseline
      if (max > 0) {
        var mid = Math.round(band.y + band.h / 2) - 0.5;
        ctx.moveTo(0, mid); ctx.lineTo(st.w, mid);
      }
      ctx.stroke();
    }

    /* Each band names its own series -- two single-series charts, so a legend
       box would add nothing that the labels don't already say. */
    function label(band, name, value) {
      ctx.font = "10px system-ui, -apple-system, sans-serif";
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      ctx.fillStyle = pal.text3;
      ctx.fillText(name, 4, band.y + 2);
      ctx.textAlign = "right";
      ctx.fillText(value, st.w - 4, band.y + 2);
    }

    function drawCursor(b) {
      var x = xOf(st.cursor);
      if (x < 0 || x > st.w) return;
      var rx = Math.round(x) + 0.5;
      ctx.strokeStyle = pal.text1;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(rx, b.tiles.y); ctx.lineTo(rx, b.players.y + b.players.h);
      ctx.stroke();
      ctx.fillStyle = pal.text1;
      ctx.beginPath();
      ctx.moveTo(rx, b.tiles.y); ctx.lineTo(rx - 4, b.tiles.y - 5); ctx.lineTo(rx + 4, b.tiles.y - 5);
      ctx.closePath(); ctx.fill();
    }

    function lastCoverageEnd(m, ms) {
      for (var i = 0; i < m.coverage.length; i++) {
        var c = m.coverage[i];
        if (ms >= c.startMs && ms <= c.endMs) return c.endMs;
      }
      return ms;
    }

    /* ---------------------------------------------------------- interaction */

    var mode = null, ptrs = new Map(), pinchStart = null;

    function localX(ev) { return ev.clientX - canvas.getBoundingClientRect().left; }
    function localY(ev) { return ev.clientY - canvas.getBoundingClientRect().top; }

    canvas.addEventListener("pointerdown", function (ev) {
      canvas.setPointerCapture(ev.pointerId);
      ptrs.set(ev.pointerId, { x: localX(ev) });
      if (ptrs.size === 2) {
        var xs = Array.from(ptrs.values()).map(function (p) { return p.x; });
        pinchStart = { d: Math.abs(xs[0] - xs[1]), a: st.viewA, b: st.viewB,
                       mid: msOf((xs[0] + xs[1]) / 2) };
        mode = "pinch";
        return;
      }
      var y = localY(ev), b = bands();
      if (y <= b.ov.y + b.ov.h) {
        // Overview: jump the window to where you tapped, keeping its length.
        mode = "window";
        moveWindowTo(msOfOv(localX(ev)));
      } else if (ev.shiftKey) {
        mode = "select";
        st.selAnchor = msOf(localX(ev));
      } else {
        mode = "scrub";
        setCursor(msOf(localX(ev)));
      }
    });

    canvas.addEventListener("pointermove", function (ev) {
      var x = localX(ev);
      if (ptrs.has(ev.pointerId)) ptrs.set(ev.pointerId, { x: x });

      if (mode === "pinch" && ptrs.size === 2 && pinchStart) {
        var xs = Array.from(ptrs.values()).map(function (p) { return p.x; });
        var d = Math.abs(xs[0] - xs[1]);
        if (pinchStart.d > 4 && d > 4) {
          var f = pinchStart.d / d;
          var span = (pinchStart.b - pinchStart.a) * f;
          zoomTo(pinchStart.mid, span);
        }
        return;
      }
      if (mode === "scrub") { setCursor(msOf(x)); return; }
      if (mode === "window") { moveWindowTo(msOfOv(x)); return; }
      if (mode === "select") {
        var a = Math.min(st.selAnchor, msOf(x)), c = Math.max(st.selAnchor, msOf(x));
        if (c - a > 1000 && opts.onWindow) opts.onWindow(a, c);
        return;
      }
      // Hover readout when nothing is being dragged.
      st.hoverX = x;
      if (opts.onHover) opts.onHover(msOf(x), ev.clientX, ev.clientY, localY(ev) > bands().tiles.y);
    });

    function release(ev) {
      ptrs.delete(ev.pointerId);
      if (ptrs.size < 2) pinchStart = null;
      if (!ptrs.size) mode = null;
    }
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);
    canvas.addEventListener("pointerleave", function () {
      st.hoverX = null;
      if (opts.onHover) opts.onHover(null);
    });

    canvas.addEventListener("wheel", function (ev) {
      ev.preventDefault();
      var at = msOf(localX(ev));
      var f = Math.pow(1.0018, ev.deltaY * (ev.deltaMode === 1 ? 16 : 1));
      zoomTo(at, (st.viewB - st.viewA) * f);
    }, { passive: false });

    canvas.addEventListener("dblclick", function () { if (opts.onResetView) opts.onResetView(); });

    function setCursor(ms) { if (opts.onCursor) opts.onCursor(ms); }

    function moveWindowTo(centreMs) {
      var len = st.t1 - st.t0;
      if (opts.onWindow) opts.onWindow(centreMs - len / 2, centreMs + len / 2);
    }

    function zoomTo(anchorMs, span) {
      var m = st.model;
      var minSpan = 2000;
      var maxSpan = m ? Math.max(minSpan, (m.bounds.maxMs - m.bounds.minMs) * 1.2) : 1e12;
      span = Math.max(minSpan, Math.min(maxSpan, span));
      var frac = (anchorMs - st.viewA) / Math.max(1, st.viewB - st.viewA);
      st.viewA = anchorMs - frac * span;
      st.viewB = st.viewA + span;
      invalidate();
      if (opts.onViewChange) opts.onViewChange(st.viewA, st.viewB);
    }

    /* ------------------------------------------------------------- summary */

    /* What the user is pointing at, for the hover tooltip. */
    function probe(ms) {
      var m = st.model;
      if (!m) return null;
      var half = Math.max(bucketMs, 1) / 2;
      var n = 0, from = ms - half, to = ms + half;
      var i = lowerBoundTiles(m.tiles, from);
      for (; i < m.tiles.length; i++) { if (m.tiles[i].tileMs > to) break; n++; }
      var snap = snapshotAt(m, ms);
      var gap = !m.covered(ms);
      var err = null;
      for (var j = 0; j < m.chunkWindows.length; j++) {
        var wd = m.chunkWindows[j];
        if (ms >= wd.startMs && ms <= wd.endMs) { err = wd; break; }
      }
      return { ms: ms, tiles: n, bucketMs: bucketMs, snapshot: snap, gap: gap, outage: err };
    }

    return {
      canvas: canvas,
      setModel: function (m) {
        st.model = m;
        /* Frame the view on the first real model only. This used to test
           "st.viewA === 0", which is true exactly once and never again, so live
           appends could not extend the view -- the bands and cursor silently
           froze at the load-time end. Keeping the view under the app's control
           after that is deliberate (the user may have zoomed); app.js slides it
           on append when follow mode is on. */
        if (m && isFinite(m.bounds.minMs) && (!st.viewInit || !isFinite(st.viewA))) {
          st.viewA = m.bounds.minMs;
          st.viewB = m.bounds.maxMs;
          st.viewInit = true;
        }
        invalidate();
      },
      setWindow: function (t0, t1) { st.t0 = t0; st.t1 = t1; invalidate(); },
      /* Notifies like zoomTo does: the axis labels are rendered by the app from
         this view, so a silent change here leaves them a step behind. */
      setView: function (a, b) {
        st.viewA = a; st.viewB = b;
        invalidate();
        if (opts.onViewChange) opts.onViewChange(a, b);
      },
      view: function () { return { a: st.viewA, b: st.viewB }; },
      setCursor: function (ms) { st.cursor = ms; invalidate(); },
      setCompact: function (v) { st.compact = !!v; invalidate(); },
      refreshPalette: function () { pal = palette(); invalidate(); },
      redraw: invalidate, flush: flush,
      height: totalHeight,
      probe: probe,
      xOf: xOf, msOf: msOf
    };
  }

  /* The snapshot in force at a moment. players.csv holds its value until the
     next row, so "the value at t" is the last row at or before t -- never an
     interpolation between neighbours. */
  function snapshotAt(m, ms) {
    var lo = 0, hi = m.snapshots.length - 1, best = null;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (m.snapshots[mid].ms <= ms) { best = m.snapshots[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
  }

  /* ==========================================================================
     Transport: the playback clock.
     --------------------------------------------------------------------------
     Speed is expressed in DATA seconds per REAL second, which is the only unit
     that means anything when a file spans 21 hours. Negative runs the replay
     backwards; the map and every panel are pure functions of the cursor, so
     reverse needs no special handling anywhere else.
     ======================================================================== */

  var SPEEDS = [-3600, -1800, -600, -300, -120, -60, -30, -10, -5, -2, -1,
                1, 2, 5, 10, 30, 60, 120, 300, 600, 1800, 3600];

  function createTransport(opts) {
    opts = opts || {};
    var st = {
      model: null,
      t0: 0, t1: 1, cursor: 0,
      playing: false,
      speedIdx: SPEEDS.indexOf(60),
      loop: true,
      follow: true,          // live mode: keep the cursor pinned to the newest data
      last: 0, raf: 0
    };

    function speed() { return SPEEDS[st.speedIdx]; }

    function tick(now) {
      st.raf = 0;
      if (!st.playing) return;
      var dt = st.last ? Math.min(250, now - st.last) : 16;
      st.last = now;
      var next = st.cursor + dt / 1000 * speed();
      if (next > st.t1) {
        if (st.loop) next = st.t0; else { next = st.t1; st.playing = false; }
      } else if (next < st.t0) {
        if (st.loop) next = st.t1; else { next = st.t0; st.playing = false; }
      }
      st.cursor = next;
      emit();
      if (st.playing) st.raf = requestAnimationFrame(tick);
    }

    function start() {
      if (st.raf) return;
      st.last = 0;
      st.raf = requestAnimationFrame(tick);
    }

    function emit() { if (opts.onChange) opts.onChange(api); }

    /* Step to the next/previous logged data point. This is the fine control the
       arrow keys drive: it lands exactly on real events instead of nudging the
       clock by an arbitrary amount and possibly landing between them. */
    function step(dir, count, kinds) {
      var m = st.model;
      if (!m || !m.steps.length) return;
      count = Math.max(1, count || 1);
      var eps = 1;
      var pos = st.cursor;
      for (var c = 0; c < count; c++) {
        var found = null;
        if (dir > 0) {
          for (var i = idxAfter(m.steps, pos + eps); i < m.steps.length; i++) {
            if (m.steps[i].ms > st.t1) break;
            if (!kinds || kinds.indexOf(m.steps[i].kind) >= 0) { found = m.steps[i]; break; }
          }
        } else {
          for (var j = idxAfter(m.steps, pos - eps) - 1; j >= 0; j--) {
            if (m.steps[j].ms < st.t0) break;
            if (!kinds || kinds.indexOf(m.steps[j].kind) >= 0) { found = m.steps[j]; break; }
          }
        }
        if (!found) break;
        pos = found.ms;
      }
      st.cursor = Math.max(st.t0, Math.min(st.t1, pos));
      emit();
    }

    function idxAfter(steps, ms) {
      var lo = 0, hi = steps.length;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (steps[mid].ms < ms) lo = mid + 1; else hi = mid; }
      return lo;
    }

    var api = {
      speeds: SPEEDS,
      state: st,
      get cursor() { return st.cursor; },
      get playing() { return st.playing; },
      get speed() { return speed(); },
      setModel: function (m) {
        st.model = m;
        if (m && isFinite(m.bounds.minMs)) {
          if (!st.t1 || st.t1 <= 1) { st.t0 = m.bounds.minMs; st.t1 = m.bounds.maxMs; st.cursor = m.bounds.maxMs; }
          else {
            st.t1 = Math.max(st.t1, st.follow ? m.bounds.maxMs : st.t1);
            if (st.follow) st.cursor = st.t1;
          }
        }
        emit();
      },
      window: function () { return { t0: st.t0, t1: st.t1 }; },
      setWindow: function (t0, t1, keepCursor) {
        var m = st.model;
        var lo = m && isFinite(m.bounds.minMs) ? m.bounds.minMs : t0;
        var hi = m && isFinite(m.bounds.maxMs) ? m.bounds.maxMs : t1;
        if (t1 - t0 < 1000) t1 = t0 + 1000;
        st.t0 = Math.max(lo - 1000, Math.min(t0, hi));
        st.t1 = Math.min(hi + 1000, Math.max(t1, st.t0 + 1000));
        if (!keepCursor || st.cursor < st.t0 || st.cursor > st.t1) {
          st.cursor = Math.max(st.t0, Math.min(st.t1, st.cursor));
        }
        emit();
      },
      setCursor: function (ms) {
        st.cursor = Math.max(st.t0, Math.min(st.t1, ms));
        st.follow = false;
        emit();
      },
      play: function () { if (!st.playing) { st.playing = true; start(); emit(); } },
      pause: function () { st.playing = false; if (st.raf) cancelAnimationFrame(st.raf); st.raf = 0; emit(); },
      toggle: function () { st.playing ? api.pause() : api.play(); },
      faster: function () { st.speedIdx = Math.min(SPEEDS.length - 1, st.speedIdx + 1); emit(); },
      slower: function () { st.speedIdx = Math.max(0, st.speedIdx - 1); emit(); },
      setSpeedIndex: function (i) { st.speedIdx = Math.max(0, Math.min(SPEEDS.length - 1, i)); emit(); },
      reverse: function () {
        // Mirror the ladder around its centre so the magnitude is preserved.
        var s = -speed();
        var best = 0, bd = Infinity;
        for (var i = 0; i < SPEEDS.length; i++) { var d = Math.abs(SPEEDS[i] - s); if (d < bd) { bd = d; best = i; } }
        st.speedIdx = best;
        emit();
      },
      step: step,
      toStart: function () { st.cursor = st.t0; st.follow = false; emit(); },
      toEnd: function () { st.cursor = st.t1; emit(); },
      setLoop: function (v) { st.loop = !!v; emit(); },
      get loop() { return st.loop; },
      setFollow: function (v) { st.follow = !!v; if (v && st.model) { st.t1 = st.model.bounds.maxMs; st.cursor = st.t1; } emit(); },
      get follow() { return st.follow; },
      get speedIdx() { return st.speedIdx; }
    };
    return api;
  }

  DV.createTimeline = createTimeline;
  DV.createTransport = createTransport;
  DV.snapshotAt = snapshotAt;
  DV.SPEEDS = SPEEDS;
})(window.DV);

/* ============================================================================
   app.js -- wiring. Loads the CSVs, owns the single source of truth (the model
   plus the transport's cursor/window), and pushes both into the map, the
   timeline and the panels.
   ----------------------------------------------------------------------------
   Render is split into a fast path and a slow path on purpose: during playback
   the transport fires every animation frame, and rebuilding a few hundred DOM
   rows at 60fps would drop the frame rate for no benefit. The canvases take the
   fast path; the HTML panels are throttled.
   ========================================================================= */

(function (DV) {
  "use strict";

  var M = DV.model;
  var P = DV.panels;

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    chunkRows: [], playerRows: [],
    model: null,
    skewOverride: null,      // null = estimate from the data
    blocksPerTile: 8,
    corrWindowMs: 60000,
    dataBase: "../data",
    mapType: null,           // null = let the model pick the most-logged type
    parseCache: {},          // memoised row parse, reused across rebuilds
    live: false, livePollMs: 5000, liveTimer: 0,
    tailChunks: null, tailPlayers: null,
    historical: null,
    loadedFrom: "",
    lastError: ""
  };

  var map, timeline, transport;

  /* ------------------------------------------------------------- settings -- */

  var SETTINGS_KEY = "dv.settings.v1";

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        mode: map.get("mode"), heatMetric: map.get("heatMetric"), heatScale: map.get("heatScale"),
        halfLifeMs: map.get("halfLifeMs"), imageSource: map.get("imageSource"),
        fillContext: map.get("fillContext"), showGrid: map.get("showGrid"), showRuler: map.get("showRuler"),
        skewOverride: state.skewOverride, blocksPerTile: state.blocksPerTile, mapType: state.mapType,
        corrWindowMs: state.corrWindowMs, dataBase: state.dataBase, livePollMs: state.livePollMs,
        theme: document.documentElement.getAttribute("data-theme") || "",
        speedIdx: transport.speedIdx, loop: transport.loop
      }));
    } catch (e) { /* private mode: settings just don't persist */ }
  }

  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (e) { return {}; }
  }

  /* ---------------------------------------------------------------- theme -- */

  function applyTheme(t) {
    if (t) document.documentElement.setAttribute("data-theme", t);
    else document.documentElement.removeAttribute("data-theme");
    // Canvas can't read CSS variables live, so both renderers re-sample them.
    if (map) map.refreshPalette();
    if (timeline) timeline.refreshPalette();
  }

  function currentTheme() {
    var t = document.documentElement.getAttribute("data-theme");
    if (t) return t;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  /* ----------------------------------------------------------- data loading */

  function rebuild(keepView) {
    var prevWindow = transport ? transport.window() : null;
    var prevBounds = state.model ? state.model.bounds : null;
    var prevView = timeline ? timeline.view() : null;

    state.model = M.build(state.chunkRows, state.playerRows, {
      skewMs: state.skewOverride,
      blocksPerTile: state.blocksPerTile,
      mapType: state.mapType,
      /* Reused across rebuilds so a live poll only parses the rows that arrived,
         instead of re-running a regex and a URL split over every row in the file.
         Safe because the row arrays are appended to in place -- see the PARSE
         CACHE note in model.js. */
      cache: state.parseCache
    });
    state.model.stamp = Date.now();

    transport.setModel(state.model);
    map.setModel(state.model);
    timeline.setModel(state.model);

    if (!keepView) {
      var b = state.model.bounds;
      transport.setWindow(b.minMs, b.maxMs);
      timeline.setView(b.minMs, b.maxMs);
      map.fit();
    } else if (prevWindow) {
      transport.setWindow(prevWindow.t0, transport.follow ? state.model.bounds.maxMs : prevWindow.t1, true);
      if (transport.follow && prevBounds && prevView) slideView(prevBounds, prevView);
    }
    syncMapTypeUI();
    syncSkewUI();
    renderSlow();
    renderFast();
    updateStatus();
  }

  /* Live appends extend the data past the right edge of the timeline's view. The
     view is the user's to zoom, so only move it when they were already looking at
     the leading edge -- otherwise someone inspecting an outage an hour back would
     be yanked to "now" every poll. */
  function slideView(prevBounds, prevView) {
    var nb = state.model.bounds;
    if (!isFinite(nb.maxMs) || nb.maxMs <= prevBounds.maxMs) return;
    var span = prevView.b - prevView.a;
    var slack = Math.max(2000, span * 0.02);
    if (prevView.a <= prevBounds.minMs + slack && prevView.b >= prevBounds.maxMs - slack) {
      timeline.setView(nb.minMs, nb.maxMs);          // was showing the whole file
    } else if (prevView.b >= prevBounds.maxMs - slack) {
      timeline.setView(nb.maxMs - span, nb.maxMs);   // was pinned to the leading edge
    }
  }

  function loadFromServer() {
    var base = state.dataBase.replace(/\/+$/, "");
    state.tailChunks = new DV.csv.Tailer(base + "/chunks.csv");
    state.tailPlayers = new DV.csv.Tailer(base + "/players.csv");
    setStatus("loading", "loading…");

    /* Reading the files and rendering them are reported separately on purpose:
       a rendering bug used to surface as "could not read the CSVs", which sends
       you looking at the wrong thing entirely. */
    var HANDLED = {};
    return Promise.all([state.tailChunks.poll(), state.tailPlayers.poll()])
      .then(function (r) {
        state.chunkRows = r[0].rows;
        state.playerRows = r[1].rows;
        state.loadedFrom = "server (" + base + ")";
        state.lastError = "";
      }, function (e) {
        state.lastError = e.message || String(e);
        setStatus("err", "load failed");
        $("dropErr").textContent = "Could not read the CSVs from " + base + ": " + state.lastError +
          ". If you opened this page directly from disk, use the file pickers instead.";
        showDrop();
        /* Drop the tailers. They were constructed before the first poll, so
           leaving them in place made state.tailChunks read as "this source can go
           live" for a source that never loaded -- Live would latch on and poll a
           dead URL forever. */
        state.tailChunks = state.tailPlayers = null;
        return Promise.reject(HANDLED);
      })
      .then(function () {
        rebuild(false);
        hideDrop();
        return probeHistorical(base);
      })
      .then(function () { return true; })          // loaded and drawn
      .catch(function (e) {
        if (e === HANDLED) return false;
        console.error("viewer render failed", e);
        state.lastError = e && e.message ? e.message : String(e);
        setStatus("err", "render error");
        $("dropErr").textContent = "The CSVs loaded but the viewer failed to draw them: " +
          state.lastError + " (details in the browser console).";
        showDrop();
        return false;
      });
  }

  /* Historical tile images are only usable if we can find out which ones exist:
     a plain static server gives no directory listing, so we look for an index
     (serve.py provides one) and otherwise fall back to live tiles. */
  function probeHistorical(base) {
    var tries = ["/api/images", "/chunks/index.json"];
    var i = 0;
    function next() {
      if (i >= tries.length) { state.historical = null; map.setHistorical(null); updateSourceNote(); return; }
      var url = (tries[i].charAt(0) === "/" && tries[i].indexOf("/api") === 0) ? tries[i] : base + tries[i];
      i++;
      return fetch(url, { cache: "no-store" }).then(function (res) {
        if (!res.ok) throw new Error("no");
        return res.json();
      }).then(function (list) {
        var names = Array.isArray(list) ? list : (list.images || list.files || []);
        state.historical = new Set(names);
        map.setHistorical(state.historical);
        updateSourceNote();
      }).catch(next);
    }
    return next();
  }

  function readFile(file) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(String(fr.result)); };
      fr.onerror = function () { rej(fr.error || new Error("read failed")); };
      fr.readAsText(file);
    });
  }

  /* Files are identified by their header, not their filename, so a renamed or
     drag-dropped export still lands in the right slot. */
  function ingestText(text, hintName) {
    var parsed = DV.csv.parse(text);
    var f = parsed.fields.join(",");
    if (/tile/.test(f)) { state.chunkRows = parsed.rows; return "chunks"; }
    if (/player|count/.test(f)) { state.playerRows = parsed.rows; return "players"; }
    throw new Error("Unrecognised CSV header in " + (hintName || "file") + ": " + f);
  }

  function markDropFile(kind, name) {
    var box = kind === "chunks" ? $("dropChunks") : $("dropPlayers");
    box.classList.add("is-loaded");
    box.querySelector(".name").textContent = name;
  }

  function handleFiles(files) {
    var jobs = [];
    for (var i = 0; i < files.length; i++) {
      (function (file) {
        jobs.push(readFile(file).then(function (text) {
          var kind = ingestText(text, file.name);
          markDropFile(kind, file.name);
          return kind;
        }));
      })(files[i]);
    }
    return Promise.all(jobs).then(function () {
      stopLive();
      state.loadedFrom = "local files";
      state.tailChunks = state.tailPlayers = null;
      state.historical = null;
      map.setHistorical(null);
      rebuild(false);
      if (state.chunkRows.length || state.playerRows.length) hideDrop();
      updateSourceNote();
    }).catch(function (e) {
      $("dropErr").textContent = e.message || String(e);
    });
  }

  /* ------------------------------------------------------------ live mode -- */

  function startLive() {
    if (!state.tailChunks) {
      // Live follow needs an HTTP source; local file handles are a snapshot.
      $("dropErr").textContent = "Live mode needs the CSVs served over HTTP. Use “Load from server”.";
      showDrop();
      return false;
    }
    state.live = true;
    $("liveBtn").setAttribute("aria-pressed", "true");
    transport.setFollow(true);
    tickLive();
    return true;
  }

  function stopLive() {
    state.live = false;
    $("liveBtn").setAttribute("aria-pressed", "false");
    if (state.liveTimer) clearTimeout(state.liveTimer);
    state.liveTimer = 0;
    updateStatus();
  }

  function tickLive() {
    if (!state.live) return;
    /* allSettled, NOT all: a Tailer that resolved has ALREADY advanced its byte
       cursor past the rows it handed back, so those rows exist nowhere else. With
       Promise.all, one file's rejection skipped the success handler and dropped
       the other file's rows permanently -- the next poll asks from the advanced
       offset and never sees them again. Each source is applied on its own. */
    Promise.allSettled([state.tailChunks.poll(), state.tailPlayers.poll()])
      .then(function (res) {
        var added = 0, reset = false, errs = [];

        if (res[0].status === "fulfilled") {
          var c = res[0].value;
          if (c.reset) { state.chunkRows = c.rows; reset = true; }
          else if (c.rows.length) push(state.chunkRows, c.rows);
          added += c.rows.length;
        } else errs.push("chunks: " + reason(res[0]));

        if (res[1].status === "fulfilled") {
          var p = res[1].value;
          if (p.reset) { state.playerRows = p.rows; reset = true; }
          else if (p.rows.length) push(state.playerRows, p.rows);
          added += p.rows.length;
        } else errs.push("players: " + reason(res[1]));

        // A poll failure is not fatal: the tracker may be mid-write or briefly
        // unreachable. Surface it and keep polling -- but still absorb whatever
        // the other source did return.
        state.lastError = errs.join("; ");
        if (added || reset) rebuild(true);
        else updateStatus();
      })
      .then(function () {
        if (state.live) state.liveTimer = setTimeout(tickLive, state.livePollMs);
      });
  }

  function reason(r) { return r.reason && r.reason.message ? r.reason.message : String(r.reason); }

  /* In-place append. concat() would allocate a fresh copy of the whole row array
     on every poll, which grows without bound as the tracker runs. */
  function push(target, rows) {
    for (var i = 0; i < rows.length; i += 4096) {
      target.push.apply(target, rows.slice(i, i + 4096));  // chunked: avoids arg-count limits
    }
  }

  /* ------------------------------------------------------------- rendering - */

  var slowTimer = 0;
  function scheduleSlow() {
    if (slowTimer) return;
    slowTimer = setTimeout(function () { slowTimer = 0; renderSlow(); }, 140);
  }

  /* Canvas + a couple of labels: cheap enough to run every frame. */
  function renderFast() {
    var w = transport.window();
    var c = transport.cursor;
    map.setWindow(w.t0, w.t1, c);
    timeline.setWindow(w.t0, w.t1);
    timeline.setCursor(c);

    $("cursorLabel").textContent = M.fmtStamp(c);
    var sp = transport.speed;
    $("speedLabel").textContent = (sp < 0 ? "◀ " : "") + Math.abs(sp) + "×";
    $("playBtn").innerHTML = transport.playing ? "&#9208;" : "&#9205;";
    $("playBtn").classList.toggle("is-on", transport.playing);

    var v = timeline.view();
    $("axisA").textContent = M.fmtStamp(v.a);
    $("axisB").textContent = M.fmtStamp(v.b);
    $("axisMid").textContent = "span " + M.fmtDur(v.b - v.a);

    updateBadge();
    scheduleSlow();
  }

  /* DOM panels: throttled.
     Split by what each panel actually depends on. Rebuilding all eight several
     times a second during playback meant creating and discarding ~4,000 elements
     and the same number of click closures per second -- and three of them cannot
     change unless the model does. */
  var lastModelRendered = null, lastWindowRendered = "";

  function renderSlow() {
    var m = state.model;
    if (!m) return;
    var w = transport.window(), c = transport.cursor;

    // --- model-only: lifecycle events and the quality report
    if (m !== lastModelRendered) {
      lastModelRendered = m;
      P.renderQuality($("qualityPanel"), m);
      $("qualityCount").textContent = m.quality.length ? m.quality.length + " notes" : "";
      P.renderEvents($("eventFeed"), m, seek);
    }

    // --- window-only: the sample table is a list of rows in the window
    var wkey = m.stamp + "|" + w.t0 + "|" + w.t1;
    if (wkey !== lastWindowRendered) {
      lastWindowRendered = wkey;
      P.renderSnapshotTable($("snapTable"), m, w.t0, w.t1, c, seek);
      var n = P.renderTransitions($("transFeed"), m, w.t0, w.t1, c, seek);
      $("transCount").textContent = n ? n + " in window" : "";
    }

    // --- cursor-dependent
    P.renderNow($("nowPanel"), m, c);
    P.renderCorrelation($("corrPanel"), m, c, state.corrWindowMs);
    P.renderTopTiles($("topTiles"), map.topCells(14), m, function (r) {
      map.centerOn(r.tx, r.tz, Math.max(map.view().scale, 14));
      selectTile(map.describe(r.tx, r.tz));
    });
    if (selected) P.renderTileDetail($("tilePanel"), map.describe(selected.tx, selected.tz), m, c, seek);

    renderHeatLegend();
    syncRangeInputs();
  }

  /* Force the panels that are otherwise change-gated to redraw (theme switch,
     tab switch, anything that replaces their DOM out from under us). */
  function invalidatePanels() { lastModelRendered = null; lastWindowRendered = ""; }

  function renderHeatLegend() {
    var lg = map.heatLegend();
    var root = $("heatLegend");
    root.innerHTML = "";
    if (!lg.max) {
      /* Two very different reasons the ramp has no range, and saying "no changes"
         for the second one is a lie: with a short half-life and the cursor well
         after the last change, every cell has simply decayed to zero. */
      if (lg.cells && lg.metric === "recency") {
        root.innerHTML = '<span style="color:var(--text-3)">All decayed to zero.</span>';
        $("heatLegendNote").textContent =
          lg.cells.toLocaleString() + " tiles changed in this window, but the newest is far enough " +
          "before the cursor that a " + M.fmtDur(map.get("halfLifeMs")) +
          " half-life leaves nothing to show. Raise the half-life, or move the cursor to where the activity is.";
      } else {
        root.innerHTML = '<span style="color:var(--text-3)">No tile changes in this window.</span>';
        $("heatLegendNote").textContent = "";
      }
      return;
    }
    var ramp = document.createElement("div");
    ramp.className = "legend__ramp";
    lg.bins.forEach(function (b) {
      var i2 = document.createElement("i");
      i2.style.background = "var(--heat-" + b.bin + ")";
      i2.title = fmtBin(b, lg.metric);
      ramp.appendChild(i2);
    });
    root.appendChild(ramp);
    var lo = document.createElement("span");
    lo.textContent = "low";
    var hi = document.createElement("span");
    hi.textContent = lg.metric === "count" ? Math.round(lg.max) + " changes" :
                     lg.metric === "last" ? "newest" : "hottest";
    root.insertBefore(lo, ramp);
    root.appendChild(hi);

    $("heatLegendNote").textContent =
      lg.cells.toLocaleString() + " tiles changed in this window" +
      (lg.metric === "count" ? "; darkest step is " + Math.round(lg.max) + " change(s) on one tile."
       : lg.metric === "recency" ? "; heat decays with a " + M.fmtDur(map.get("halfLifeMs")) + " half-life from the cursor."
       : "; brightest is the most recently changed.");
  }

  function fmtBin(b, metric) {
    if (metric === "count") return Math.ceil(b.lo) + "–" + Math.round(b.hi) + " changes";
    return b.lo.toFixed(2) + "–" + b.hi.toFixed(2);
  }

  function updateBadge() {
    var m = state.model;
    if (!m) { $("mapBadge").textContent = "no data"; return; }
    var s = map.status();
    var w = transport.window();
    var covered = m.covered(transport.cursor);
    $("mapBadge").innerHTML =
      "<b>" + s.cells.toLocaleString() + "</b> tiles lit &middot; window <b>" + M.fmtDur(w.t1 - w.t0) + "</b>" +
      (s.loading ? " &middot; loading " + s.loading + " image(s)" : "") +
      (covered ? "" : ' &middot; <span style="color:var(--status-serious)">tracker off at cursor</span>');

    var warn = $("mapWarn");
    if (s.suppressedImages) {
      warn.hidden = false;
      warn.innerHTML = "Zoom in to load tile images &mdash; too many tiles on screen to fetch.";
    } else { warn.hidden = true; }
  }

  function updateStatus() {
    var m = state.model;
    if (!m) { setStatus("", "no data"); return; }
    var rows = state.chunkRows.length + state.playerRows.length;
    if (state.lastError) { setStatus("err", "poll error: " + state.lastError); return; }
    if (state.live) {
      setStatus("live", "live · " + m.tiles.length.toLocaleString() + " tiles · to " + M.fmtTime(m.bounds.maxMs));
    } else {
      setStatus("", rows.toLocaleString() + " rows · " + m.tiles.length.toLocaleString() + " tiles · " +
        m.snapshots.length + " samples");
    }
  }

  function setStatus(kind, text) {
    var pill = $("statusPill");
    pill.className = "pill" + (kind === "live" ? " pill--live" : kind === "err" ? " pill--err" : "");
    $("statusText").textContent = text;
  }

  function updateSourceNote() {
    var bits = [];
    bits.push("Loaded from " + (state.loadedFrom || "nothing yet") + ".");
    /* Three states, because the first poll deliberately sends no Range header and
       so cannot tell us anything: null = not yet probed. */
    if (state.tailChunks) {
      if (state.tailChunks.ranged === false) {
        bits.push("This server ignores Range requests, so live mode re-reads the whole file each poll.");
      } else if (state.tailChunks.ranged === true) {
        bits.push("Live mode tails only the newly appended bytes.");
      } else {
        bits.push("Whether this server supports byte-range tailing is determined on the first live poll.");
      }
    }
    // An empty Set is truthy, so test the size: "0 saved tile images available"
    // reads as though replay were possible when it isn't.
    if (state.historical && state.historical.size) {
      bits.push(state.historical.size.toLocaleString() + " saved tile images available for historical replay.");
    } else {
      bits.push("No saved tile images found — tile art comes from the server's current render, which shows the world now rather than at the cursor. Run the tracker with SAVE_IMAGES=true for true historical tiles.");
    }
    $("sourceNote").textContent = bits.join(" ");
  }

  /* --------------------------------------------------------------- seeking - */

  function seek(ms) {
    var w = transport.window();
    if (ms < w.t0 || ms > w.t1) {
      // Seeking outside the window would silently clamp; widen instead so the
      // click actually takes you where you clicked.
      var pad = Math.max(30000, (w.t1 - w.t0) * 0.1);
      transport.setWindow(Math.min(w.t0, ms - pad), Math.max(w.t1, ms + pad), true);
    }
    transport.setCursor(ms);
  }

  var selected = null;
  function selectTile(info) {
    selected = info ? { tx: info.tx, tz: info.tz } : null;
    $("tileGroup").open = true;
    P.renderTileDetail($("tilePanel"), info, state.model, transport.cursor, seek);
  }

  /* ------------------------------------------------------------- tooltips -- */

  function showTip(tipEl, host, html, clientX, clientY) {
    if (!html) { tipEl.hidden = true; return; }
    tipEl.innerHTML = html;
    tipEl.hidden = false;
    var hr = host.getBoundingClientRect();
    var tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
    var x = clientX - hr.left + 12, y = clientY - hr.top + 12;
    if (x + tw > hr.width - 4) x = clientX - hr.left - tw - 12;
    if (y + th > hr.height - 4) y = clientY - hr.top - th - 12;
    tipEl.style.left = Math.max(4, x) + "px";
    tipEl.style.top = Math.max(4, y) + "px";
  }

  function tileTipHtml(info) {
    var m = state.model;
    var w = info.world;
    var rows = [
      ["World X", w.x0 + " … " + (w.x1 - 1)],
      ["World Z", w.z0 + " … " + (w.z1 - 1)],
      ["Chunk", info.chunk.cx + ", " + info.chunk.cz],
      ["Changes (window)", String(info.inWindow)],
      ["Changes (all)", String(info.total)]
    ];
    if (isFinite(info.lastMs)) rows.push(["Last change", M.fmtTime(info.lastMs)]);
    if (info.last) rows.push(["Observed lag", M.fmtDur(info.last.lagMs)]);
    if (info.last && info.last.online !== null) {
      rows.push(["Online then", info.last.online + (info.last.roster.length ? " (" + P.esc(info.last.roster.join(", ")) + ")" : "")]);
    }
    var html = '<div class="tip__h">tile ' + info.tx + ", " + info.tz + "</div>";
    rows.forEach(function (r) {
      html += '<div class="tip__r"><span>' + r[0] + "</span><b>" + r[1] + "</b></div>";
    });
    if (info.image) {
      html += '<img src="' + P.esc(info.image.url) + '" alt="">';
      html += '<div class="tip__r" style="margin-top:2px"><span>' +
        (info.image.historical ? "saved snapshot" : "live tile (now)") + "</span></div>";
    }
    return html;
  }

  function timeTipHtml(p) {
    if (!p) return "";
    var html = '<div class="tip__h">' + M.fmtStamp(p.ms) + "</div>";
    html += '<div class="tip__r"><span>Tile changes</span><b>' + p.tiles + " / " + M.fmtDur(p.bucketMs) + "</b></div>";
    if (p.snapshot) {
      html += '<div class="tip__r"><span>Players</span><b>' + p.snapshot.count + "</b></div>";
      if (p.snapshot.roster.length) {
        html += '<div class="tip__r"><span>' + P.esc(p.snapshot.roster.join(", ")) + "</span></div>";
      }
      html += '<div class="tip__r"><span>Sampled</span><b>' + M.fmtTime(p.snapshot.ms) + "</b></div>";
    }
    if (p.gap) html += '<div class="tip__r" style="color:var(--status-serious)"><span>▲ tracker not running</span></div>';
    if (p.outage) {
      html += '<div class="tip__r" style="color:' + (p.outage.lossy ? "var(--status-critical)" : "var(--status-warning)") +
        '"><span>' + (p.outage.lossy ? "✖ tiles lost" : "⚠ poll outage, recovered") +
        "</span><b>" + M.fmtDur(p.outage.spanMs) + "</b></div>";
    }
    return html;
  }

  /* ------------------------------------------------------------------ init - */

  function init() {
    var s = loadSettings();
    if (s.theme) applyTheme(s.theme);
    if (s.dataBase) state.dataBase = s.dataBase;
    if (s.blocksPerTile) state.blocksPerTile = s.blocksPerTile;
    if (s.corrWindowMs) state.corrWindowMs = s.corrWindowMs;
    if (s.livePollMs) state.livePollMs = s.livePollMs;
    if (s.skewOverride !== undefined) state.skewOverride = s.skewOverride;
    if (s.mapType) state.mapType = s.mapType;

    map = DV.createMap($("mapCanvas"), {
      dataBase: state.dataBase,
      onHover: function (info, cx, cy) {
        if (!info) { $("mapTip").hidden = true; return; }
        showTip($("mapTip"), $("stage"), tileTipHtml(info), cx, cy);
      },
      onSelect: selectTile,
      onView: function () { updateBadge(); }
    });

    timeline = DV.createTimeline($("timeCanvas"), {
      onCursor: function (ms) { transport.setCursor(ms); },
      onWindow: function (a, b) { transport.setWindow(a, b, true); },
      onViewChange: function () { renderFast(); },
      onResetView: function () {
        var b = state.model ? state.model.bounds : null;
        if (b) { timeline.setView(b.minMs, b.maxMs); transport.setWindow(b.minMs, b.maxMs, true); }
      },
      onHover: function (ms, cx, cy) {
        if (ms === null) { $("timeTip").hidden = true; return; }
        showTip($("timeTip"), $("dock"), timeTipHtml(timeline.probe(ms)), cx, cy);
      }
    });

    transport = DV.createTransport({ onChange: renderFast });

    // Apply stored view settings now that the renderers exist.
    map.set({
      mode: s.mode || "hybrid",
      heatMetric: s.heatMetric || "count",
      heatScale: s.heatScale || "sqrt",
      halfLifeMs: s.halfLifeMs || 300000,
      imageSource: s.imageSource || "auto",
      fillContext: !!s.fillContext,
      showGrid: s.showGrid !== false,
      showRuler: s.showRuler !== false
    });
    if (typeof s.speedIdx === "number") transport.setSpeedIndex(s.speedIdx);
    if (s.loop === false) transport.setLoop(false);

    bindControls();
    bindKeys();
    bindDrop();
    bindMobile();

    applyCompact();
    window.addEventListener("resize", function () {
      applyCompact();
      map.resize();
      timeline.redraw();
    });
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
      if (!document.documentElement.getAttribute("data-theme")) applyTheme("");
    });

    /* Coming back to a backgrounded tab: requestAnimationFrame was not being
       serviced, so both canvases may hold a stale frame (and their coalescing
       flags a dropped callback). Force a real draw rather than trusting the
       queue to have survived. */
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState !== "visible") return;
      map.resize();
      map.flush();
      timeline.flush();
      invalidatePanels();
      renderFast();
      renderSlow();
    });

    $("dropPath").textContent = state.dataBase;
    $("dataBase").value = state.dataBase;
    $("livePoll").value = Math.round(state.livePollMs / 1000);
    $("blocksPerTile").value = state.blocksPerTile;
    $("corrWindow").value = Math.round(state.corrWindowMs / 1000);
    syncViewUI(s);

    /* Console handle. This is a diagnostic tool, so being able to poke the
       model and force a redraw from devtools is a feature, not a leak. */
    DV.app = {
      map: map, timeline: timeline, transport: transport, state: state,
      renderFast: renderFast, renderSlow: renderSlow, rebuild: rebuild,
      flush: function () { map.resize(); map.flush(); timeline.flush(); renderFast(); renderSlow(); }
    };

    // Try the server first; the picker only appears if that fails.
    if (location.protocol === "http:" || location.protocol === "https:") loadFromServer();
    else { showDrop(); updateSourceNote(); }
  }

  function applyCompact() {
    var mobile = window.matchMedia("(max-width: 900px)").matches;
    timeline.setCompact(mobile);
  }

  function syncViewUI(s) {
    Array.prototype.forEach.call(document.querySelectorAll("#modeSeg .btn"), function (b) {
      b.setAttribute("aria-pressed", b.dataset.mode === map.get("mode") ? "true" : "false");
    });
    $("heatMetric").value = map.get("heatMetric");
    $("heatScale").value = map.get("heatScale");
    $("imageSource").value = map.get("imageSource");
    $("fillContext").checked = map.get("fillContext");
    $("showGrid").checked = map.get("showGrid");
    $("showRuler").checked = map.get("showRuler");
    $("halfLife").value = Math.round(map.get("halfLifeMs") / 1000);
    $("halfLifeVal").textContent = M.fmtDur(map.get("halfLifeMs"));
    $("halfLifeRow").hidden = map.get("heatMetric") !== "recency";
    $("loopChk").checked = transport.loop;
  }

  function syncSkewUI() {
    var m = state.model;
    if (!m) return;
    $("skewInput").value = Math.round(m.skew.ms / 1000);
    var note = "Estimated " + M.fmtDur(m.skew.estimatedMs) + " from " + m.skew.samples.toLocaleString() +
      " tiles. Raw capture-minus-render ran " + M.fmtSigned(m.skew.rawMinMs) + " to " + M.fmtSigned(m.skew.rawMaxMs) +
      " (median " + M.fmtSigned(m.skew.rawMedianMs) + ").";
    if (m.lag.samples) {
      note += " After correction, render lag is median " + M.fmtDur(m.lag.medianMs) + ", 95th " +
        M.fmtDur(m.lag.p95Ms) + ", max " + M.fmtDur(m.lag.maxMs) +
        (m.lag.negative ? ", with " + m.lag.negative + " still negative." : ", none negative — consistent.");
    }
    $("skewNote").textContent = note;
  }

  /* The map builds saved-snapshot URLs from this, so it has to be told when the
     folder changes -- and any image cached under the old folder is now wrong. */
  function applyDataBase() {
    map.set({ dataBase: state.dataBase });
    map.clearImageCache();
    $("dropPath").textContent = state.dataBase;
  }

  /* The map-type picker only earns its space when the log actually holds more
     than one, which happens when the tracker ran with MAP_TYPE="". */
  function syncMapTypeUI() {
    var m = state.model, row = $("mapTypeRow"), sel = $("mapTypeSel");
    if (!m || m.mapTypes.length < 2) { row.hidden = true; return; }
    row.hidden = false;
    if (sel.options.length !== m.mapTypes.length ||
        sel.options[0].value !== m.mapTypes[0].map) {
      sel.innerHTML = "";
      m.mapTypes.forEach(function (t) {
        var o = document.createElement("option");
        o.value = t.map;
        o.textContent = t.map + " (" + t.count.toLocaleString() + " tiles)";
        sel.appendChild(o);
      });
    }
    sel.value = m.mapType;
  }

  var rangeSyncing = false;
  function syncRangeInputs() {
    var w = transport.window();
    rangeSyncing = true;
    $("rangeFrom").value = M.toLocalInput(w.t0);
    $("rangeTo").value = M.toLocalInput(w.t1);
    rangeSyncing = false;
  }

  /* ------------------------------------------------------------- controls -- */

  function bindControls() {
    $("themeBtn").addEventListener("click", function () {
      applyTheme(currentTheme() === "dark" ? "light" : "dark");
      saveSettings();
    });

    $("loadBtn").addEventListener("click", showDrop);
    $("reloadBtn").addEventListener("click", function () {
      state.dataBase = $("dataBase").value.trim() || "../data";
      applyDataBase();
      loadFromServer();
      saveSettings();
    });

    $("mapTypeSel").addEventListener("change", function () {
      state.mapType = this.value || null;
      rebuild(false);          // a different projection needs a fresh fit
      saveSettings();
    });

    $("liveBtn").addEventListener("click", function () {
      if (state.live) stopLive();
      else if (!state.tailChunks) {
        state.dataBase = $("dataBase").value.trim() || "../data";
        // Gate on the load's own verdict, not on a Tailer object that exists
        // regardless of whether the fetch ever succeeded.
        loadFromServer().then(function (ok) { if (ok) startLive(); });
      } else startLive();
    });

    $("livePoll").addEventListener("change", function () {
      state.livePollMs = Math.max(1, parseFloat(this.value) || 5) * 1000;
      saveSettings();
    });
    $("dataBase").addEventListener("change", function () {
      state.dataBase = this.value.trim() || "../data";
      $("dropPath").textContent = state.dataBase;
      applyDataBase();
      saveSettings();
    });

    // --- map controls
    Array.prototype.forEach.call(document.querySelectorAll("#modeSeg .btn"), function (b) {
      b.addEventListener("click", function () {
        map.set({ mode: b.dataset.mode });
        syncViewUI(); saveSettings(); updateBadge();
      });
    });
    $("heatMetric").addEventListener("change", function () {
      map.set({ heatMetric: this.value });
      $("halfLifeRow").hidden = this.value !== "recency";
      renderHeatLegend(); saveSettings();
    });
    $("heatScale").addEventListener("change", function () {
      map.set({ heatScale: this.value }); renderHeatLegend(); saveSettings();
    });
    $("halfLife").addEventListener("input", function () {
      map.set({ halfLifeMs: (parseFloat(this.value) || 300) * 1000 });
      $("halfLifeVal").textContent = M.fmtDur(map.get("halfLifeMs"));
      renderHeatLegend();
    });
    $("halfLife").addEventListener("change", saveSettings);
    $("imageSource").addEventListener("change", function () {
      map.set({ imageSource: this.value }); map.clearImageCache(); saveSettings();
    });
    $("fillContext").addEventListener("change", function () {
      map.set({ fillContext: this.checked }); saveSettings();
    });
    $("showGrid").addEventListener("change", function () { map.set({ showGrid: this.checked }); saveSettings(); });
    $("showRuler").addEventListener("change", function () { map.set({ showRuler: this.checked }); saveSettings(); });

    $("fitBtn").addEventListener("click", function () { map.fit(); });
    $("fitBtn2").addEventListener("click", function () { map.fit(); });
    $("zoomIn").addEventListener("click", function () { map.zoomBy(1.5); });
    $("zoomOut").addEventListener("click", function () { map.zoomBy(1 / 1.5); });
    $("zoomIn2").addEventListener("click", function () { map.zoomBy(1.5); });
    $("zoomOut2").addEventListener("click", function () { map.zoomBy(1 / 1.5); });

    // --- time base
    $("skewInput").addEventListener("change", function () {
      state.skewOverride = (parseFloat(this.value) || 0) * 1000;
      rebuild(true); saveSettings();
    });
    $("skewAuto").addEventListener("click", function () {
      state.skewOverride = null; rebuild(true); saveSettings();
    });
    $("skewZero").addEventListener("click", function () {
      state.skewOverride = 0; rebuild(true); saveSettings();
    });
    $("corrWindow").addEventListener("change", function () {
      state.corrWindowMs = Math.max(1, parseFloat(this.value) || 60) * 1000;
      renderSlow(); saveSettings();
    });
    $("blocksPerTile").addEventListener("change", function () {
      state.blocksPerTile = Math.max(1, parseInt(this.value, 10) || 8);
      rebuild(true); saveSettings();
    });

    // --- transport
    $("playBtn").addEventListener("click", function () { transport.toggle(); });
    $("stepFwd").addEventListener("click", function () { transport.pause(); transport.step(1, 1); });
    $("stepBack").addEventListener("click", function () { transport.pause(); transport.step(-1, 1); });
    $("toStart").addEventListener("click", function () { transport.toStart(); });
    $("toEnd").addEventListener("click", function () { transport.toEnd(); });
    $("faster").addEventListener("click", function () { transport.faster(); saveSettings(); });
    $("slower").addEventListener("click", function () { transport.slower(); saveSettings(); });
    $("revBtn").addEventListener("click", function () { transport.reverse(); saveSettings(); });
    $("loopChk").addEventListener("change", function () { transport.setLoop(this.checked); saveSettings(); });

    function applyRange() {
      if (rangeSyncing) return;
      var a = M.fromLocalInput($("rangeFrom").value), b = M.fromLocalInput($("rangeTo").value);
      if (!isFinite(a) || !isFinite(b) || b <= a) return;
      transport.setWindow(a, b, true);
      timeline.setView(a, b);
    }
    $("rangeFrom").addEventListener("change", applyRange);
    $("rangeTo").addEventListener("change", applyRange);

    $("rangeAll").addEventListener("click", function () {
      var b = state.model && state.model.bounds;
      if (!b) return;
      transport.setWindow(b.minMs, b.maxMs, true);
      timeline.setView(b.minMs, b.maxMs);
    });

    $("rangePreset").addEventListener("change", function () {
      var secs = parseFloat(this.value);
      this.value = "";
      if (!secs) return;
      var end = transport.cursor;
      transport.setWindow(end - secs * 1000, end, true);
      var v = transport.window();
      timeline.setView(v.t0, v.t1);
    });
  }

  /* Arrow-key stepping is the fine control the whole viewer is built around, so
     it stays live everywhere except while typing into a field. */
  function bindKeys() {
    document.addEventListener("keydown", function (ev) {
      var t = ev.target;
      if (t && (/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) || t.isContentEditable)) return;
      if (ev.ctrlKey || ev.metaKey) return;

      var big = ev.shiftKey ? 25 : 1;
      var kinds = ev.altKey ? ["join", "leave"] : null;

      switch (ev.key) {
        case "ArrowRight": transport.pause(); transport.step(1, big, kinds); break;
        case "ArrowLeft": transport.pause(); transport.step(-1, big, kinds); break;
        case "ArrowUp": transport.faster(); saveSettings(); break;
        case "ArrowDown": transport.slower(); saveSettings(); break;
        case " ": transport.toggle(); break;
        case "Home": transport.toStart(); break;
        case "End": transport.toEnd(); break;
        case "r": case "R": transport.reverse(); saveSettings(); break;
        case "l": case "L": state.live ? stopLive() : startLive(); break;
        case "h": case "H": {
          var order = ["heat", "hybrid", "images"];
          map.set({ mode: order[(order.indexOf(map.get("mode")) + 1) % order.length] });
          syncViewUI(); saveSettings(); updateBadge();
          break;
        }
        case "0": map.fit(); break;
        case "+": case "=": map.zoomBy(1.5); break;
        case "-": case "_": map.zoomBy(1 / 1.5); break;
        case "[": {
          var w = transport.window();
          transport.setWindow(transport.cursor, w.t1, true);
          break;
        }
        case "]": {
          var w2 = transport.window();
          transport.setWindow(w2.t0, transport.cursor, true);
          break;
        }
        default: return;
      }
      ev.preventDefault();
    });
  }

  /* --------------------------------------------------------------- loader UI */

  function showDrop() { $("drop").hidden = false; }
  function hideDrop() { $("drop").hidden = true; $("dropErr").textContent = ""; }

  function bindDrop() {
    $("dropClose").addEventListener("click", function () {
      if (state.model) hideDrop();
      else $("dropErr").textContent = "Load a CSV first — there is nothing to show yet.";
    });
    $("serverLoad").addEventListener("click", function () {
      state.dataBase = $("dataBase").value.trim() || "../data";
      loadFromServer();
    });
    $("fileChunks").addEventListener("change", function () { if (this.files.length) handleFiles(this.files); });
    $("filePlayers").addEventListener("change", function () { if (this.files.length) handleFiles(this.files); });

    // Page-wide drop, so you can drag both files in at once from anywhere.
    ["dragenter", "dragover"].forEach(function (t) {
      document.addEventListener(t, function (ev) {
        ev.preventDefault();
        showDrop();
        $("drop").classList.add("is-hot");
      });
    });
    document.addEventListener("dragleave", function (ev) {
      if (ev.relatedTarget) return;
      $("drop").classList.remove("is-hot");
    });
    document.addEventListener("drop", function (ev) {
      ev.preventDefault();
      $("drop").classList.remove("is-hot");
      if (ev.dataTransfer && ev.dataTransfer.files.length) handleFiles(ev.dataTransfer.files);
    });
  }

  /* ------------------------------------------------------------ mobile tabs */

  function bindMobile() {
    var tabs = $("mtabs");
    tabs.addEventListener("click", function (ev) {
      var b = ev.target.closest("button[data-view]");
      if (!b) return;
      var v = b.dataset.view;
      Array.prototype.forEach.call(tabs.querySelectorAll("button"), function (x) {
        x.setAttribute("aria-selected", x === b ? "true" : "false");
      });
      $("stage").dataset.active = v === "map" ? "true" : "false";
      $("panelRight").dataset.active = v === "right" ? "true" : "false";
      $("panelSide").dataset.active = v === "side" ? "true" : "false";
      if (v === "map") { map.resize(); }
      // The panel was display:none, so the change-gated ones must be rebuilt.
      if (v === "right") { invalidatePanels(); renderSlow(); }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})(window.DV);

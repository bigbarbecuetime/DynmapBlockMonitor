/* ============================================================================
   panels.js -- the read-out panels. Each function is a pure render: given the
   model and the cursor, build DOM. No panel keeps state of its own, which is
   what makes reverse playback and live appends work without special cases.
   ========================================================================= */

window.DV = window.DV || {};

(function (DV) {
  "use strict";

  var M = DV.model;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* Build one element from a string. This uses <template> rather than a throwaway
     <div> because the HTML parser enforces table content rules: a bare "<tr>…"
     assigned to div.innerHTML is silently DISCARDED, so firstElementChild comes
     back null and the caller's appendChild throws. Template content is parsed in
     template insertion mode, which accepts table fragments. */
  function el(html) {
    var t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  /* ------------------------------------------------------- players "now" ---- */

  /* The roster and count in force at the cursor. Two separate facts, because the
     server can disagree with itself about them -- so we show the count as the
     headline and say plainly when the name list doesn't back it up. */
  function renderNow(root, model, cursorMs) {
    if (!model) { root.innerHTML = '<div class="empty">No data loaded.</div>'; return; }
    var snap = DV.snapshotAt(model, cursorMs);
    var covered = model.covered(cursorMs);
    var stale = snap ? cursorMs - snap.ms : NaN;

    var parts = [];
    parts.push('<div class="stats">');
    parts.push(stat("Players online", !covered ? "&mdash;" : snap ? String(snap.count) : "&mdash;",
      !covered ? "tracker off" : snap ? "as of " + M.fmtTime(snap.ms) : "before first sample"));
    var lit = tilesInWindow(model, cursorMs, Math.max(60000, model.pollMs * 6));
    parts.push(stat("Tiles changed", String(lit), "in the last " + M.fmtDur(Math.max(60000, model.pollMs * 6))));
    parts.push("</div>");

    if (!covered) {
      parts.push(q("serious", "▲", "Tracker was not running",
        "Nothing was recorded at " + M.fmtStamp(cursorMs) + ". This is missing data, not an empty server."));
    } else if (!snap) {
      parts.push(q("info", "○", "Before the first player sample",
        "The tracker had started but had not yet logged a player snapshot."));
    } else {
      /* A held value is not a stale reading -- it is the answer. players.csv is
         only written when the roster changes, so "no row for 14 minutes" means
         "nobody came or went for 14 minutes", which is information rather than a
         caveat. Say that instead of implying the number is going off. */
      if (isFinite(stale) && stale > Math.max(120000, model.playerPollMs * 6)) {
        /* "Unchanged" only means something if we were watching the whole time.
           A held row on the far side of an outage is not evidence that nobody
           came or went -- it is evidence that nobody was looking. A 15.7h
           tracker outage was being reported as "no one has joined or left in
           14h 4m", with the reassurance that polling was ongoing. */
        var off = offBetween(model, snap.ms, cursorMs);
        if (off > Math.max(model.playerPollMs * 3, 60000)) {
          parts.push(q("serious", "▲", "No roster row for " + M.fmtDur(stale) + ", but the tracker was off for " + M.fmtDur(off),
            "The last row is from " + M.fmtTime(snap.ms) + ", on the far side of a gap in recording. " +
            "Players could have come and gone unseen; the roster shown is the last one observed, not a current reading."));
        } else {
          parts.push(q("good", "✓", "No one has joined or left in " + M.fmtDur(stale),
            "The roster has been unchanged since " + M.fmtTime(snap.ms) +
            ". The tracker is still polling every " + M.fmtDur(model.playerPollMs) +
            "; it only writes a row when the count or the names change."));
        }
      }
      if (snap.truncated) {
        parts.push(q("serious", "⚠", "Roster is incomplete",
          "The server reports " + snap.count + " online but named only " + snap.roster.length +
          ". Server List Ping caps its sample list, so some players cannot be named."));
      }
      if (snap.overfull) {
        parts.push(q("warning", "⚠", "Roster contradicts the count",
          "The count says " + snap.count + " but " + snap.roster.length +
          " name(s) are listed. The server's own status reply was inconsistent here."));
      }
    }

    root.innerHTML = parts.join("");

    if (snap && covered) {
      var r = document.createElement("div");
      r.className = "roster";
      if (!snap.roster.length) {
        r.innerHTML = '<span class="empty" style="padding:0">' +
          (snap.count ? esc(snap.count + " online, none named by the server") : "Nobody online") + "</span>";
      } else {
        snap.roster.forEach(function (n) {
          var p = document.createElement("span");
          p.className = "roster__p";
          p.textContent = n;
          r.appendChild(p);
        });
        if (snap.truncated) {
          var more = document.createElement("span");
          more.className = "roster__p";
          more.style.opacity = "0.7";
          more.textContent = "+" + (snap.count - snap.roster.length) + " unnamed";
          r.appendChild(more);
        }
      }
      root.appendChild(r);
    }
  }

  /* Milliseconds between a and b that no tracker run covers. The runs are built
     in order and do not overlap, so walking them and summing the holes is
     enough; anything outside every run is time nobody was recording. */
  function offBetween(model, aMs, bMs) {
    if (!model || !model.coverage || !(bMs > aMs)) return 0;
    var cov = model.coverage, on = 0;
    for (var i = 0; i < cov.length; i++) {
      var s = Math.max(aMs, cov[i].startMs), e = Math.min(bMs, cov[i].endMs);
      if (e > s) on += e - s;
    }
    return Math.max(0, (bMs - aMs) - on);
  }

  function stat(k, v, sub) {
    return '<div class="stat"><div class="stat__k">' + k + '</div><div class="stat__v">' + v +
      (sub ? ' <small>' + esc(sub) + "</small>" : "") + "</div></div>";
  }

  function q(sev, icon, title, detail) {
    return '<div class="q q--' + sev + '"><div class="q__icon" aria-hidden="true">' + icon +
      '</div><div><div class="q__title">' + esc(title) + '</div><div class="q__detail">' + detail + "</div></div></div>";
  }

  function tilesInWindow(model, cursorMs, spanMs) {
    var tiles = model.tiles;
    var i = M.lowerBound(tiles, cursorMs - spanMs, "tileMs");
    var n = 0;
    for (; i < tiles.length; i++) { if (tiles[i].tileMs > cursorMs) break; n++; }
    return n;
  }

  /* --------------------------------------------------- joins and leaves ---- */

  /* Every transition is derived by diffing two adjacent snapshots, so each one
     carries whether that diff was trustworthy. An uncertain row says why rather
     than being dropped or presented as fact. */
  function renderTransitions(root, model, t0, t1, cursorMs, onSeek) {
    root.innerHTML = "";
    if (!model) { root.innerHTML = '<div class="empty">No data loaded.</div>'; return 0; }
    /* Up to the CURSOR, not the end of the window: scrubbing should show what
       had happened by that moment, not spoil what happens later in the window. */
    var rows = M.sliceRange(model.transitions, t0, cursorMs);
    if (!rows.length) {
      root.innerHTML = '<div class="empty">No joins or leaves before the cursor.</div>';
      return 0;
    }
    // Newest first: when following live data the interesting end is the top.
    rows.slice().reverse().forEach(function (tr) {
      var item = document.createElement("div");
      item.className = "feed__item";
      if (Math.abs(tr.ms - cursorMs) < Math.max(2000, model.playerPollMs)) item.classList.add("is-cursor");
      item.innerHTML =
        '<span class="feed__t ts">' + M.fmtTime(tr.ms) + "</span>" +
        '<span class="feed__who">' + esc(tr.player) +
          (tr.uncertain ? ' <span title="' + esc(tr.reason) + '" style="opacity:.75">?</span>' : "") +
        "</span>" +
        '<span class="feed__tag feed__tag--' + tr.type + '">' +
          (tr.type === "join" ? "▲ join" : "▼ leave") + " " + tr.countBefore + "→" + tr.countAfter +
        "</span>";
      item.title = M.fmtStamp(tr.ms) + (tr.uncertain ? "\nUncertain: " + tr.reason : "");
      item.addEventListener("click", function () { if (onSeek) onSeek(tr.ms); });
      root.appendChild(item);
    });
    return rows.length;
  }

  /* Every polled snapshot as a table -- the non-colour, non-chart route to the
     same series the timeline draws, and the only place you can read the exact
     count/roster pair the server actually returned. */
  function renderSnapshotTable(root, model, t0, t1, cursorMs, onSeek) {
    root.innerHTML = "";
    if (!model) return;
    var rows = M.sliceRange(model.snapshots, t0, cursorMs);
    if (!rows.length) { root.innerHTML = '<div class="empty">No player samples before the cursor.</div>'; return; }
    var t = document.createElement("table");
    t.className = "tbl";
    t.innerHTML = "<thead><tr><th>Time (" + (M.getTimeMode() === "raw" ? "UTC" : "local") +
      ")</th><th class=num>Count</th><th>Named</th></tr></thead>";
    var tb = document.createElement("tbody");
    rows.slice().reverse().slice(0, 400).forEach(function (s) {
      var tr = document.createElement("tr");
      var flag = s.truncated ? ' <span title="sample capped by server">⚠</span>'
               : s.overfull ? ' <span title="count is below the number of names listed">⚠</span>' : "";
      tr.innerHTML = "<td>" + M.fmtDate(s.ms) + "</td><td class=num>" + s.count + flag + "</td><td>" +
        (s.roster.length ? esc(s.roster.join(", ")) : '<span style="opacity:.55">none</span>') + "</td>";
      if (Math.abs(s.ms - cursorMs) < 1000) tr.style.background = "color-mix(in srgb, var(--series-players) 14%, transparent)";
      tr.style.cursor = "pointer";
      tr.addEventListener("click", function () { if (onSeek) onSeek(s.ms); });
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    root.appendChild(t);
    if (rows.length > 400) root.appendChild(el('<p class="hint">Showing the newest 400 of ' + rows.length + " samples.</p>"));
  }

  /* ------------------------------------------------------- data quality ---- */

  var ICONS = { critical: "✖", serious: "⚠", warning: "⚠", good: "✓", info: "○" };

  function renderQuality(root, model) {
    root.innerHTML = "";
    if (!model) { root.innerHTML = '<div class="empty">No data loaded.</div>'; return; }
    if (!model.quality.length) { root.innerHTML = '<div class="empty">Nothing to report.</div>'; return; }
    model.quality.forEach(function (item) {
      root.appendChild(el(q(item.severity, ICONS[item.severity] || "○", item.title, esc(item.detail))));
    });
  }

  /* ------------------------------------------------ tile / correlation ----- */

  function renderTileDetail(root, info, model, cursorMs, onSeek) {
    root.innerHTML = "";
    if (!info) { root.innerHTML = '<div class="empty">Click a tile on the map to inspect it.</div>'; return; }
    var w = info.world, c = info.chunk;

    root.appendChild(el(
      '<div class="stats">' +
      stat("Tile", info.tx + ", " + info.tz, "") +
      stat("Changes", info.inWindow + " <small>/ " + info.total + "</small>", "window / all") +
      '<div class="stat stat--wide"><div class="stat__k">World area (blocks)</div>' +
      '<div class="stat__v" style="font-size:13px;font-family:var(--mono)">X ' + w.x0 + "…" + (w.x1 - 1) +
      "  Z " + w.z0 + "…" + (w.z1 - 1) + "</div>" +
      '<div class="stat__k" style="margin-top:4px">Chunk ' + c.cx + ", " + c.cz +
      " &middot; tile is " + w.size + "×" + w.size + " blocks</div></div>" +
      "</div>"
    ));

    if (info.image) {
      var fig = el('<div style="padding:10px 12px"></div>');
      var img = document.createElement("img");
      img.src = info.image.url;
      img.alt = "Tile " + info.tx + ", " + info.tz;
      img.style.cssText = "width:100%;max-width:200px;image-rendering:pixelated;border:1px solid var(--border);border-radius:4px;display:block";
      fig.appendChild(img);
      fig.appendChild(el('<p class="hint">' + (info.image.historical
        ? "Saved snapshot from this run (<code>" + esc(info.image.name) + "</code>) &mdash; the tile as it looked then."
        : "Live tile fetched from the server &mdash; shows the world <b>now</b>, not at the cursor. Run the tracker with <code>SAVE_IMAGES=true</code> to get historical tiles.") + "</p>"));
      root.appendChild(fig);
    }

    /* Notes about THIS tile rather than the whole file: a file-wide report says
       nothing about the square you just clicked, which is usually the question. */
    if (info.events.length) {
      var loads = 0, edits = 0, offline = 0, uncovered = 0;
      info.events.forEach(function (e) {
        if (e.kind === "load") loads++; else edits++;
        if (e.online === 0) offline++;
        if (!e.inCoverage) uncovered++;
      });
      var notes = [];
      if (edits === 0) {
        notes.push(q("info", "○", "Every change here looks like a chunk load",
          "All " + loads + " sit alone on the chunk boundary, which is what Dynmap does when it redraws a chunk someone walked into. Probably nobody built here &mdash; this is a place people pass through."));
      } else if (loads === 0) {
        notes.push(q("good", "✓", "Every change here looks like a real edit",
          "All " + edits + " touched neighbouring tiles at the same time, which chunk loading does not do. Something was actually built or broken here."));
      } else {
        notes.push(q("info", "○", edits + " likely edit" + (edits > 1 ? "s" : "") + ", " + loads + " likely chunk load" + (loads > 1 ? "s" : ""),
          "Mixed: people pass through here and at least some of the changes look like real building."));
      }
      if (offline) {
        notes.push(q("warning", "⚠", offline + " change" + (offline > 1 ? "s" : "") + " here happened with nobody online",
          "So those cannot be attributed to a player at all &mdash; the world ticks without them."));
      }
      if (uncovered) {
        notes.push(q("warning", "⚠", uncovered + " change" + (uncovered > 1 ? "s" : "") + " landed outside a tracker run",
          "Their timing is less certain; expected right at a start or stop."));
      }
      /* Height, when the isometric maps were also logged. A flat tile alone
         cannot say how high up a change was -- it is a top-down projection. */
      if (info.height) {
        notes.push(q("good", "✓", "Height about y " + Math.round(info.height.yMin) + " to " + Math.round(info.height.yMax),
          "Recovered by pairing this flat tile with " + info.height.sources +
          " isometric tile change(s) at the same moment: the isometric projection folds height into its vertical axis, so it supplies the Y that an overhead tile cannot." ));
      } else if (info.heightUnavailable) {
        notes.push(q("info", "○", "Height unknown",
          "Only one map type is logged, so there is no second projection to cross with. Set <code>MAP_TYPE=</code> (empty) in the tracker's .env to record the isometric maps too."));
      }
      notes.forEach(function (h) { root.appendChild(el(h)); });
    }

    if (info.events.length) {
      var list = el('<div class="feed"></div>');
      info.events.slice().reverse().slice(0, 60).forEach(function (t) {
        var item = document.createElement("div");
        item.className = "feed__item";
        item.innerHTML = '<span class="feed__t ts">' + M.fmtDate(t.tileMs) + "</span>" +
          '<span class="feed__who" style="font-weight:400">' +
            (t.online === null ? "?" : t.online + " online") +
            (t.roster.length ? " · " + esc(t.roster.join(", ")) : "") + "</span>" +
          '<span class="feed__tag">lag ' + M.fmtDur(t.lagMs) + "</span>";
        item.title = "rendered " + M.fmtStamp(t.tileMs) + " (corrected)\nobserved " + M.fmtStamp(t.capMs);
        item.addEventListener("click", function () { if (onSeek) onSeek(t.tileMs); });
        list.appendChild(item);
      });
      root.appendChild(el('<div class="group__body" style="padding-bottom:2px"><div class="stat__k">Change history</div></div>'));
      root.appendChild(list);
    }
  }

  /* The correlation read-out: for the moment at the cursor, what changed on the
     map and who could plausibly have caused it. This is the payoff of the skew
     correction -- without it the two sides are minutes apart and any attribution
     here would be noise. */
  function renderCorrelation(root, model, cursorMs, windowMs) {
    root.innerHTML = "";
    if (!model) { root.innerHTML = '<div class="empty">No data loaded.</div>'; return; }
    var span = windowMs || 60000;
    var from = cursorMs - span, to = cursorMs;
    /* Binary-searched slice, not a full filter. This runs on every throttled
       cursor tick, and scanning every tile to return the handful inside a 60s
       window was ~64k predicate calls a second on a day of data -- and it grows
       with the file forever while the answer stays a few elements. */
    var tiles = M.sliceRange(model.tiles, from, to, "tileMs");
    var snap = DV.snapshotAt(model, cursorMs);

    root.appendChild(el('<div class="stats">' +
      stat("Window", M.fmtDur(span), "ending at cursor") +
      stat("Tile changes", String(tiles.length), tiles.length ? uniqueCells(tiles) + " distinct tiles" : "") +
      "</div>"));

    if (!tiles.length) {
      root.appendChild(el('<div class="empty">No tile changes in this window.</div>'));
    } else {
      // Attribution is only honest when exactly one player was online; anything
      // else is stated as ambiguous rather than guessed.
      var byCount = { 0: 0, 1: 0, many: 0, unknown: 0 };
      var perPlayer = new Map();
      tiles.forEach(function (t) {
        if (t.online === null) byCount.unknown++;
        else if (t.online === 0) byCount[0]++;
        else if (t.online === 1) {
          byCount[1]++;
          var who = t.roster.length === 1 ? t.roster[0] : "(unnamed, 1 online)";
          perPlayer.set(who, (perPlayer.get(who) || 0) + 1);
        } else byCount.many++;
      });

      var t = document.createElement("table");
      t.className = "tbl";
      t.innerHTML = "<thead><tr><th>Players online at render time</th><th class=num>Tiles</th></tr></thead>";
      var tb = document.createElement("tbody");
      function row(label, n, note) {
        if (!n) return;
        tb.appendChild(el("<tr><td>" + label + (note ? ' <span style="opacity:.6">' + note + "</span>" : "") +
          "</td><td class=num>" + n + "</td></tr>"));
      }
      row("Exactly 1 &mdash; attributable", byCount[1], "");
      row("2 or more &mdash; ambiguous", byCount.many, "");
      row("0 &mdash; not a player edit", byCount[0], "server tick / chunk load");
      row("Unknown", byCount.unknown, "no player sample yet");
      t.appendChild(tb);
      root.appendChild(t);

      if (perPlayer.size) {
        var pl = Array.from(perPlayer.entries()).sort(function (a, b) { return b[1] - a[1]; });
        var t2 = document.createElement("table");
        t2.className = "tbl";
        t2.style.marginTop = "8px";
        t2.innerHTML = "<thead><tr><th>Sole player online</th><th class=num>Tiles</th></tr></thead>";
        var tb2 = document.createElement("tbody");
        pl.forEach(function (p) {
          tb2.appendChild(el("<tr><td>" + esc(p[0]) + "</td><td class=num>" + p[1] + "</td></tr>"));
        });
        t2.appendChild(tb2);
        root.appendChild(t2);
      }
    }

    /* Everything that can make this correlation wrong, at this cursor. */
    var warn = [];
    if (!model.covered(cursorMs)) warn.push(q("serious", "▲", "Tracker was off here", "Both sides of the correlation are missing."));
    if (model.skew.ms > 0) {
      warn.push(q("info", "○", "Tile times shifted by −" + M.fmtDur(model.skew.ms),
        "Dynmap's clock runs ahead of the tracker host, so raw tile timestamps cannot be compared to player timestamps directly. This panel uses the corrected times."));
    }
    model.chunkWindows.forEach(function (wd) {
      if (wd.endMs < from || wd.startMs > to) return;
      warn.push(q(wd.lossy ? "critical" : "warning", wd.lossy ? "✖" : "⚠",
        "Dynmap poll outage in this window (" + M.fmtDur(wd.spanMs) + ")",
        wd.lossy ? "Longer than the " + M.fmtDur(model.retentionMs) + " retention buffer, so tile changes here are permanently lost."
                 : "Short enough that the next poll recovered it from the feed buffer."));
    });
    model.playerWindows.forEach(function (wd) {
      if (wd.endMs < from || wd.startMs > to) return;
      warn.push(q("warning", "⚠", "Player ping failed in this window",
        "The roster used for attribution is carried over from before the failure and may be stale."));
    });
    if (snap && snap.truncated) {
      warn.push(q("serious", "⚠", "Roster incomplete at this moment",
        "The server capped its name sample, so a sole-player attribution above may name the wrong person."));
    }
    warn.forEach(function (h) { root.appendChild(el(h)); });
  }

  function uniqueCells(tiles) {
    var s = new Set();
    tiles.forEach(function (t) { s.add(t.tx + "," + t.tz); });
    return s.size;
  }

  /* Hottest tiles as a ranked table: the same information the heatmap encodes in
     colour, available to anyone who cannot use the colour channel. */
  function renderTopTiles(root, rows, model, onPick) {
    root.innerHTML = "";
    if (!rows || !rows.length) { root.innerHTML = '<div class="empty">No tile changes in this window.</div>'; return; }
    var t = document.createElement("table");
    t.className = "tbl";
    t.innerHTML = "<thead><tr><th>Tile</th><th>Blocks X / Z</th><th class=num>Changes</th><th class=num>Last</th></tr></thead>";
    var tb = document.createElement("tbody");
    rows.forEach(function (r) {
      var tr = document.createElement("tr");
      tr.style.cursor = "pointer";
      tr.innerHTML =
        "<td><span class=swatch style=\"background:var(--heat-" + Math.max(0, r.bin) + ")\"></span>" +
          r.tx + ", " + r.tz + "</td>" +
        "<td>" + r.world.x0 + " / " + r.world.z0 + "</td>" +
        "<td class=num>" + r.n + "</td>" +
        "<td class='num ts'>" + M.fmtTime(r.lastMs) + "</td>";
      tr.addEventListener("click", function () { if (onPick) onPick(r); });
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    root.appendChild(t);
  }

  /* ------------------------------------------------------------- lifecycle - */

  function renderEvents(root, model, onSeek) {
    root.innerHTML = "";
    if (!model) return;
    var items = [];
    model.events.forEach(function (e) { items.push({ ms: e.ms, kind: e.kind, text: e.raw }); });
    model.chunkWindows.forEach(function (w) {
      items.push({ ms: w.startMs, kind: w.lossy ? "loss" : "outage",
        text: "Dynmap poll " + (w.count > 1 ? w.count + " errors" : "error") + " (" + w.reasons.join(", ") + ") for " +
              M.fmtDur(w.spanMs) + (w.lossy ? " — tiles lost" : " — recovered") });
    });
    model.playerWindows.forEach(function (w) {
      items.push({ ms: w.startMs, kind: "outage",
        text: "Player ping " + (w.count > 1 ? w.count + " errors" : "error") + " (" + w.reasons.join(", ") + ")" });
    });
    items.sort(function (a, b) { return b.ms - a.ms; });
    if (!items.length) { root.innerHTML = '<div class="empty">No lifecycle events or errors.</div>'; return; }

    var ico = { start: "▶", stop: "■", unclean: "⚠", outage: "⚠", loss: "✖", other: "○" };
    items.forEach(function (it) {
      var item = document.createElement("div");
      item.className = "feed__item";
      item.innerHTML = '<span class="feed__t ts">' + M.fmtDate(it.ms) + "</span>" +
        '<span class="feed__who" style="font-weight:400">' + esc(it.text) + "</span>" +
        '<span class="feed__tag">' + ico[it.kind] + "</span>";
      item.addEventListener("click", function () { if (onSeek) onSeek(it.ms); });
      root.appendChild(item);
    });
  }

  /* ------------------------------------------------------------- tracks --- */

  /* Inferred paths, with the honesty up front: the score line says how often the
     number of live tracks matched the number of people actually online, which is
     the only external check available. */
  function renderTracks(root, tracks, score, model, onPick, events) {
    root.innerHTML = "";
    if (!tracks) { root.innerHTML = '<div class="empty">Enable "Inferred player tracks" to build these.</div>'; return; }
    if (!tracks.length) { root.innerHTML = '<div class="empty">No tracks in this window.</div>'; return; }

    var people = tracks.filter(function (t) { return !t.held; });
    var ground = tracks.length - people.length;
    var named = people.filter(function (t) { return t.player; }).length;
    root.appendChild(el('<div class="stats">' +
      stat("Player tracks", String(people.length), named + " attributable") +
      stat("Held ground", String(ground), ground ? "kept loaded, not walked" : "none found") +
      stat("Match roster", score ? Math.round(score.exact * 100) + "%" : "&mdash;",
           score ? "off by " + score.meanAbsErr.toFixed(2) + " on average" : "") +
      "</div>"));

    if (ground) {
      root.appendChild(el(q("info", "▣", ground + " place" + (ground > 1 ? "s were" : " was") + " being held loaded",
        "Somewhere with more going on than the head-count allows: while one person was online, " +
        "this place kept re-rendering chunks it already had, at the same time as fresh ground was " +
        "loading somewhere else. That is a chunk loader, a farm, or spawn chunks &mdash; the renders " +
        "there locate the machine, not a player, so they are shown as a fixed place rather than " +
        "joined into anybody's path.")));
    }

    /* Held ground that people keep materialising on. A pearl parked in a stasis
       chamber is an entity, an entity needs its chunk loaded, so every chamber
       in use is already in the held list -- this just says which of them get
       arrived at. */
    var stasis = (events && events.stasisSites) || [];
    if (stasis.length) {
      root.appendChild(el(q("warning", "◈",
        stasis.length + " place" + (stasis.length > 1 ? "s people appear at" : " people appear at"),
        "Someone arrived here faster than any travel allows, on ground that was being kept loaded at " +
        "the time &mdash; which is what an ender-pearl stasis chamber looks like from outside, since the " +
        "parked pearl is what holds the chunk up. " +
        stasis.slice(0, 4).map(function (s) {
          return "(" + Math.round(s.cx) + ", " + Math.round(s.cz) + ") &times;" + s.arrivals.length +
            " &mdash; " + esc(Array.from(new Set(s.arrivals.map(function (a) { return a.player || "someone"; }))).join(", "));
        }).join("; ") + ".")));
    }

    if (score) {
      root.appendChild(el(q("info", "○", "Idle players are invisible here",
        "A track is built from chunks loading, which only happens when someone MOVES. " +
        "Standing still produces nothing, which is why the count runs under the roster " +
        Math.round(score.underCount * 100) + "% of the time rather than over it.")));
    }

    var t = document.createElement("table");
    t.className = "tbl";
    t.innerHTML = "<thead><tr><th>Start</th><th>For</th><th class=num>Blocks</th><th class=num>b/s</th><th>Who</th></tr></thead>";
    var tb = document.createElement("tbody");
    tracks.slice().sort(function (a, b) { return b.points.length - a.points.length; }).slice(0, 40).forEach(function (tr) {
      var row = document.createElement("tr");
      row.style.cursor = "pointer";
      row.innerHTML = "<td class=ts>" + M.fmtTime(tr.startMs) + "</td>" +
        "<td>" + M.fmtDur(tr.durationMs) + "</td>" +
        "<td class=num>" + tr.blocksTravelled.toLocaleString() + "</td>" +
        "<td class=num>" + tr.speedBlocksPerSec.toFixed(1) + "</td>" +
        "<td>" + (tr.held ? '<span style="opacity:.65">held ground</span>'
                 : tr.player ? esc(tr.player)
                 : '<span style="opacity:.65">' + (tr.candidates.length ? esc(tr.candidates.slice(0, 2).join(" / ")) : "unknown") + "</span>") + "</td>";
      row.title = tr.held
        ? "A place being kept loaded. Its renders do not say anyone was standing there."
        : tr.attribution || "Not pinned to anyone: more than one player fits, and nothing rules the others out.";
      row.addEventListener("click", function () { if (onPick) onPick(tr); });
      tb.appendChild(row);
    });
    t.appendChild(tb);
    root.appendChild(t);
  }

  /* One track in full: who, when, how it moved, and every event that starts or
     ends on it. This is the answer to "what actually happened here". */
  function renderTrackDetail(root, tr, events, model, hue, onSeek) {
    root.innerHTML = "";
    if (!tr) {
      root.innerHTML = '<div class="empty">Click a track on the map to inspect it.</div>';
      return;
    }
    var mine = (events || []).filter(function (e) {
      return e.fromTrack === tr.id || e.toTrack === tr.id;
    });
    var who = tr.player
      ? esc(tr.player) + (tr.confident ? "" : " <span style='opacity:.7'>(likely)</span>")
      : "<span style='opacity:.7'>unattributed</span>";

    root.appendChild(el(
      '<div class="stats">' +
      '<div class="stat stat--wide"><div class="stat__k">Track #' + tr.id +
        /* hue is a resolved colour now, not a CSS custom-property name: player
           colours are generated around the hue circle and have no token. */
        (hue ? ' <span class="swatch" style="background:' + esc(hue) + '"></span>' : '') +
        '</div><div class="stat__v" style="font-size:15px">' + who + '</div>' +
        (tr.attribution ? '<div class="stat__k" style="margin-top:3px">' + esc(tr.attribution) + '</div>' : '') +
      '</div>' +
      stat("From", M.fmtTime(tr.startMs), "") +
      stat("To", M.fmtTime(tr.lastMs), M.fmtDur(tr.durationMs)) +
      stat("Travelled", tr.blocksTravelled + " blocks", tr.speedBlocksPerSec.toFixed(1) + " b/s avg") +
      stat("Chunks seen", String(tr.chunks || 0), "position +/- " + (tr.loadRadiusBlocks || 0) + " blocks") +
      "</div>"));

    // time spent per movement mode
    var modes = Object.keys(tr.modeTime || {}).sort(function (a, b) { return tr.modeTime[b] - tr.modeTime[a]; });
    if (modes.length) {
      var t = document.createElement("table");
      t.className = "tbl";
      t.innerHTML = "<thead><tr><th>How it moved</th><th class=num>Time</th></tr></thead>";
      var tb = document.createElement("tbody");
      modes.forEach(function (mo) {
        tb.appendChild(el("<tr><td>" + esc(mo) + "</td><td class=num>" +
          M.fmtDur(tr.modeTime[mo] * 1000) + "</td></tr>"));
      });
      t.appendChild(tb);
      root.appendChild(t);
    }

    root.appendChild(el('<div class="group__body" style="padding:8px 0 2px"><div class="stat__k">Events on this track (' +
      mine.length + ')</div></div>'));
    if (!mine.length) {
      root.appendChild(el('<div class="empty">No teleports or dimension changes.</div>'));
    } else {
      var feed = el('<div class="feed"></div>');
      mine.forEach(function (e) {
        var dir = e.fromTrack === tr.id ? "left here" : "arrived here";
        var item = document.createElement("div");
        item.className = "feed__item";
        item.innerHTML = '<span class="feed__t ts">' + M.fmtTime(e.ms) + "</span>" +
          '<span class="feed__who" style="font-weight:400">' + dir + " &middot; " + e.blocks + "b" +
            (e.explains ? '<br><span style="opacity:.75;font-size:11px">' + esc(e.explains) + "</span>" : "") +
          "</span>" +
          '<span class="feed__tag">' + esc(e.kind) + "</span>";
        item.addEventListener("click", function () { if (onSeek) onSeek(e.ms); });
        feed.appendChild(item);
      });
      root.appendChild(feed);
    }

    root.appendChild(el('<p class="hint">The line is where the player probably was &mdash; the centre of the ' +
      'chunks loading around them &mdash; not the path they walked. Chunks load in a disc ahead of and ' +
      'around a player, so the tiles lighting up are usually not the ones being walked over.</p>'));
  }

  DV.panels = {
    renderTrackDetail: renderTrackDetail,
    renderTracks: renderTracks,
    renderNow: renderNow,
    renderTransitions: renderTransitions,
    renderSnapshotTable: renderSnapshotTable,
    renderQuality: renderQuality,
    renderTileDetail: renderTileDetail,
    renderCorrelation: renderCorrelation,
    renderTopTiles: renderTopTiles,
    renderEvents: renderEvents,
    esc: esc, el: el
  };
})(window.DV);

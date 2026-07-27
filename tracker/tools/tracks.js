#!/usr/bin/env node
/* ============================================================================
   tracks.js -- print the tracks the real pipeline builds, and score them against
   the player roster.
   ----------------------------------------------------------------------------
       node tools/tracks.js                       # whole log, summary + score
       node tools/tracks.js 2026-07-27T12:00 2026-07-27T14:00   # one window,
                                                                # leg by leg

   calibrate.js answers "how far off is a position we have ground truth for".
   This answers the other half: how many people does the model think were online,
   against how many actually were, and what does an individual track look like
   when you read it as a path. A track that zigzags between two places a thousand
   blocks apart is obvious here and invisible in a mean error.
   ========================================================================= */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");

function loadPipeline() {
  const ctx = { window: {}, console: { log() {} } };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of ["csv.js", "model.js", "infer.js", "timeline.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, "viewer", "js", f), "utf8"), ctx, { filename: f });
  }
  return ctx.window.DV;
}

const hhmm = ms => new Date(ms).toISOString().slice(5, 16).replace("T", " ");

function main() {
  const DV = loadPipeline();
  const raw = {
    chunks: DV.csv.parse(fs.readFileSync(path.join(DATA, "chunks.csv"), "utf8")).rows,
    players: DV.csv.parse(fs.readFileSync(path.join(DATA, "players.csv"), "utf8")).rows,
    maps: JSON.parse(fs.readFileSync(path.join(ROOT, "tools", "maps.json"), "utf8"))
  };
  const model = DV.model.build(raw.chunks, raw.players, { mapConfigs: raw.maps });

  const args = process.argv.slice(2);
  const first = model.tiles[0].tileMs, last = model.tiles[model.tiles.length - 1].tileMs;
  const showFrom = args[0] ? Date.parse(args[0] + ":00Z") : first;
  const showTo = args[1] ? Date.parse(args[1] + ":00Z") : last;
  /* FULL=1 builds over the whole log but prints only the given window. The two
     differ: attribution resolves by elimination across every track in the
     build, so a window can name a track the whole log cannot, and that gap is
     exactly the thing worth being able to look at. */
  const whole = process.env.FULL === "1";
  const from = whole ? first : showFrom;
  const to = whole ? last : showTo;

  // HELD=0 turns the chunk-loader pass off, so a before/after can be taken on
  // one dataset -- the log grows while the tracker runs and comparing two runs
  // minutes apart compares two different files.
  const heldOff = process.env.HELD === "0";
  const tracks = DV.infer.buildTracks(model, { from, to, mapConfigs: raw.maps, heldSites: !heldOff });
  const s = DV.infer.scoreTracks(model, tracks, { from, to });

  console.log("window " + hhmm(from) + " .. " + hhmm(to) + (heldOff ? "   [held-site pass OFF]" : ""));
  console.log("tiles " + model.tiles.length + "   render delay " + (model.renderDelayMs / 1000) + "s");
  console.log("tracks " + tracks.length +
    (s ? "   roster agreement " + (100 * s.exact).toFixed(1) + "%  meanAbsErr " + s.meanAbsErr.toFixed(2) +
         "  over " + (100 * s.overCount).toFixed(0) + "%  under " + (100 * s.underCount).toFixed(0) + "%" : ""));

  const free = tracks.filter(t => !t.held);
  const named = tracks.filter(t => t.player).length;
  console.log("attributed " + named + "/" + tracks.length +
    " (" + tracks.filter(t => t.confident).length + " confident)");
  console.log("player tracks " + free.length + "   held-ground tracks " + (tracks.length - free.length));

  const showSite = s =>
    "   (" + String(Math.round(s.cx)).padStart(6) + "," + String(Math.round(s.cz)).padStart(6) + ")  " +
    String(s.n).padStart(4) + " slices  " + String(s.votes).padStart(3) + " votes  " +
    String(s.renders).padStart(5) + " renders / " + String(s.chunks).padStart(4) + " chunks = " +
    s.repeatRate.toFixed(2) + "  " + hhmm(s.firstMs) + " -> " + hhmm(s.lastMs);
  const hs = tracks.heldSites || [];
  console.log("held sites " + hs.length + (hs.length ? ":" : ""));
  hs.slice().sort((a, b) => b.n - a.n).slice(0, 12).forEach(s => console.log(showSite(s)));
  if (process.env.SITES) {
    console.log("all sites " + (tracks.sites || []).length + ":");
    (tracks.sites || []).slice().sort((a, b) => b.renders - a.renders).slice(0, 25)
      .forEach(s => console.log((s.held ? " H" : "  ") + showSite(s).slice(2)));
  }

  const dist = free.map(t => t.blocksTravelled).sort((a, b) => a - b);
  if (dist.length) {
    console.log("player blocks travelled: p50 " + dist[dist.length >> 1] +
      "  p90 " + dist[Math.floor(0.9 * (dist.length - 1))] + "  max " + dist[dist.length - 1]);
  }
  /* The symptom this is all about: a track that wanders thousands of blocks
     without ever leaving a small box is pacing between two places it was never
     at both of. Distance over the diagonal of its own bounding box. */
  const pacing = free.filter(t => t.blocksTravelled > 600 && t.spanTiles > 0 &&
                                  t.blocksTravelled / t.spanTiles > 4);
  console.log("pacing tracks (travel > 4x their own extent): " + pacing.length + "/" + free.length);

  if (args[0]) {
    for (const tr of tracks.slice().sort((a, b) => a.startMs - b.startMs)) {
      if (tr.lastMs < showFrom || tr.startMs > showTo) continue;
      console.log("\ntrack " + tr.id + "  " + hhmm(tr.startMs) + " -> " + hhmm(tr.lastMs) +
        "  " + tr.points.length + " pts  " + tr.blocksTravelled + "b  " +
        (tr.player || "(" + tr.candidates.join("/") + ")") + (tr.confident ? " [confident]" : "") +
        (tr.attribution ? " [" + tr.attribution + "]" : ""));
      if (!tr.held) {
        console.log("   viable [" + (tr.viable || []).join(", ") + "]" +
          "  join-edge [" + (tr.startsAtJoin || []).map(e => e.player).join(", ") + "]" +
          "  leave-edge [" + (tr.endsAtLeave || []).map(e => e.player).join(", ") + "]");
      }
      tr.points.forEach((p, i) => {
        const leg = i ? tr.legs[i - 1] : null;
        console.log("   " + hhmm(p.ms) + "  (" + Math.round(p.tx) + "," + Math.round(p.tz) + ")" +
          "  err " + Math.round(p.err) + "b  chunks " + p.chunks +
          (leg ? "   <- " + leg.mode + " " + leg.blocks + "b" : ""));
      });
    }
  }
}

main();

#!/usr/bin/env node
/* ============================================================================
   tracks.js -- print the tracks the real pipeline builds, and score them against
   the player roster.
   ----------------------------------------------------------------------------
       node tools/tracks.js                       # whole log, summary + score
       node tools/tracks.js 2026-07-27T12:00 2026-07-27T14:00   # print one
                                                                # window, leg by
                                                                # leg
   The tracks are always built from the whole log. The arguments select what
   gets printed, nothing else.

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
  /* The build always sees everything; the arguments only choose what is PRINTED.
     There is no window build to compare against any more -- a window changed the
     answer rather than the view of it (attribution resolves by elimination
     across every track in the build), which is exactly why it went away. */
  const showFrom = args[0] ? Date.parse(args[0] + ":00Z") : first;
  const showTo = args[1] ? Date.parse(args[1] + ":00Z") : last;

  // STEADY=0 turns the path settling off, so a before/after can be taken on one
  // dataset -- the log grows while the tracker runs and comparing two runs
  // minutes apart compares two different files.
  const steadyOff = process.env.STEADY === "0";
  const all = DV.infer.buildTracks(model, { mapConfigs: raw.maps, steadyPath: !steadyOff });
  const tracks = DV.infer.tracksInWindow(all, showFrom, showTo);
  const s = DV.infer.scoreTracks(model, all, { from: showFrom, to: showTo });

  console.log("built " + hhmm(first) + " .. " + hhmm(last) + "   showing " +
    hhmm(showFrom) + " .. " + hhmm(showTo) +
    (steadyOff ? "   [path settling OFF]" : ""));
  console.log("tiles " + model.tiles.length + "   render delay " + (model.renderDelayMs / 1000) + "s");
  console.log("tracks " + tracks.length + " of " + all.length +
    (s ? "   roster agreement " + (100 * s.exact).toFixed(1) + "%  meanAbsErr " + s.meanAbsErr.toFixed(2) +
         "  over " + (100 * s.overCount).toFixed(0) + "%  under " + (100 * s.underCount).toFixed(0) + "%" : ""));

  const named = tracks.filter(t => t.player).length;
  console.log("attributed " + named + "/" + tracks.length +
    " (" + tracks.filter(t => t.confident).length + " confident)");

  const dist = tracks.map(t => t.blocksTravelled).sort((a, b) => a - b);
  if (dist.length) {
    console.log("player blocks travelled: p50 " + dist[dist.length >> 1] +
      "  p90 " + dist[Math.floor(0.9 * (dist.length - 1))] + "  max " + dist[dist.length - 1]);
  }
  /* The symptom this is all about: a track that wanders thousands of blocks
     without ever leaving a small box is pacing between two places it was never
     at both of. Distance over the diagonal of its own bounding box. */
  const pacing = tracks.filter(t => t.blocksTravelled > 600 && t.spanTiles > 0 &&
                                    t.blocksTravelled / t.spanTiles > 4);
  console.log("pacing tracks (travel > 4x their own extent): " + pacing.length + "/" + tracks.length);

  if (args[0]) {
    for (const tr of tracks.slice().sort((a, b) => a.startMs - b.startMs)) {
      if (tr.lastMs < showFrom || tr.startMs > showTo) continue;
      console.log("\ntrack " + tr.id + "  " + hhmm(tr.startMs) + " -> " + hhmm(tr.lastMs) +
        "  " + tr.points.length + " pts  " + tr.blocksTravelled + "b  " +
        (tr.player || "(" + tr.candidates.join("/") + ")") + (tr.confident ? " [confident]" : "") +
        (tr.attribution ? " [" + tr.attribution + "]" : ""));
      console.log("   viable [" + (tr.viable || []).join(", ") + "]" +
        "  join-edge [" + (tr.startsAtJoin || []).map(e => e.player).join(", ") + "]" +
        "  leave-edge [" + (tr.endsAtLeave || []).map(e => e.player).join(", ") + "]");
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

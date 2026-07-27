#!/usr/bin/env node
/* ============================================================================
   calibrate.js -- score the track pipeline against human-entered ground truth,
   and search for parameters that improve it.
   ----------------------------------------------------------------------------
       node tools/calibrate.js                 # score as configured
       node tools/calibrate.js --search        # search, with held-out folds
       node tools/calibrate.js --cv            # cross-validate only

   Runs the REAL pipeline. model.js and infer.js are loaded and executed exactly
   as the browser runs them, so a number printed here is a number the viewer will
   reproduce. That matters more than it sounds: the alternative -- fitting a
   differentiable stand-in for the pipeline -- optimises something that is not
   what ships, and the gap between the two is invisible until it is shipped.

   WHY NOT GRADIENT DESCENT. The pipeline is not differentiable anywhere that
   counts: single-linkage clustering is a discrete partition, slices are integer
   buckets, the position estimate is a min/max extent, classification is a
   threshold. There is no gradient to follow through set membership. Softening
   every stage until there is one produces a different algorithm, which then has
   to be trusted to agree with the real one. A direct search evaluates the actual
   code, needs no such assumption, and at this parameter count costs seconds.

   WHY THE FOLDS ARE NOT OPTIONAL. There are a handful of ground-truth points and
   roughly ten free parameters. Scoring a fit on the points it was fitted to will
   report a small number no matter how wrong the model is -- adding a disc radius
   to the treeline once scored 2 and 4 blocks on two legs, and it was fitting a
   fixed landmark that generalised to nothing. Folds are held out BY SESSION and
   BY REGION, never by point: two points from one session share the same terrain,
   the same weather and the same render backlog, so splitting them apart leaks
   the answer across the split and every error looks flattering.
   ========================================================================= */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
const CAL = path.join(ROOT, "calibration", "calibration.csv");

/* ---------------------------------------------------------------- loading */

function loadPipeline() {
  const ctx = { window: {}, console: { log() {} } };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of ["csv.js", "model.js", "infer.js", "timeline.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, "viewer", "js", f), "utf8"), ctx, { filename: f });
  }
  return ctx.window.DV;
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const head = lines[0].split(",");
  return lines.slice(1).map(line => {
    // Notes may contain commas; everything before the last field does not.
    const cells = [];
    let cur = "", quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') quoted = !quoted;
      else if (c === "," && !quoted && cells.length < head.length - 1) { cells.push(cur); cur = ""; }
      else cur += c;
    }
    cells.push(cur);
    const row = {};
    head.forEach((h, i) => row[h.trim()] = (cells[i] || "").trim());
    return row;
  });
}

function loadCalibration() {
  if (!fs.existsSync(CAL)) {
    console.error("no calibration file at " + CAL);
    console.error("add ground truth through the viewer, or POST /api/calibration");
    process.exit(1);
  }
  return parseCsv(fs.readFileSync(CAL, "utf8")).map(r => ({
    ms: Date.parse(r.time),
    player: r.player,
    x: parseFloat(r.x), y: parseFloat(r.y), z: parseFloat(r.z),
    activity: r.activity || "unknown",
    radius: parseFloat(r.radius || "0") || 0,
    note: r.note || ""
  })).filter(r => isFinite(r.ms) && isFinite(r.x) && isFinite(r.z));
}

/* A session is a CONTIGUOUS visit, found by gap, not by clock bucket. Bucketing
   by hour split one 10-minute visit across the 21:00/22:00 boundary and called
   it two sessions -- holding one "session" out then leaves its own terrain,
   weather and render backlog in the training half, which is exactly the leak
   the folds exist to prevent. */
function assignSessions(records, gapMs) {
  gapMs = gapMs === undefined ? 1800000 : gapMs;
  const byPlayer = new Map();
  for (const r of records) {
    if (!byPlayer.has(r.player)) byPlayer.set(r.player, []);
    byPlayer.get(r.player).push(r);
  }
  for (const [player, rows] of byPlayer) {
    rows.sort((a, b) => a.ms - b.ms);
    let n = 0;
    for (let i = 0; i < rows.length; i++) {
      if (i && rows[i].ms - rows[i - 1].ms > gapMs) n++;
      rows[i].session = player + "#" + n;
    }
  }
  return records;
}

/* ------------------------------------------------------------------ scoring */

/* Where does the model think this player was at this instant? Interpolated
   along the track, because a calibration point almost never lands exactly on a
   60s slice boundary and snapping to the nearest node would add up to half a
   slice of the player's own motion to the error. */
function modelPosition(tracks, player, ms) {
  let best = null;
  for (const tr of tracks) {
    if (tr.player !== player) continue;
    if (ms < tr.startMs - 60000 || ms > tr.lastMs + 60000) continue;
    const pts = tr.points || [];
    for (let i = 0; i < pts.length; i++) {
      if (pts[i].ms === ms) return { x: pts[i].tx, z: pts[i].tz, track: tr.id };
      if (i && pts[i - 1].ms <= ms && ms <= pts[i].ms) {
        const a = pts[i - 1], b = pts[i];
        const t = (ms - a.ms) / Math.max(1, b.ms - a.ms);
        return { x: a.tx + t * (b.tx - a.tx), z: a.tz + t * (b.tz - a.tz), track: tr.id };
      }
    }
    // Within the tolerance window but outside the point range: clamp to an end.
    const near = pts.length ? (ms < pts[0].ms ? pts[0] : pts[pts.length - 1]) : null;
    if (near && (!best || Math.abs(near.ms - ms) < Math.abs(best.ms - ms)))
      best = { x: near.tx, z: near.tz, track: tr.id, ms: near.ms };
  }
  return best;
}

function buildAt(DV, raw, params) {
  const model = DV.model.build(raw.chunks, raw.players, {
    mapConfigs: raw.maps,
    renderDelayMs: params.renderDelayMs
  });
  const from = model.tiles[0].tileMs, to = model.tiles[model.tiles.length - 1].tileMs;
  const r = DV.infer.buildTracks(model, {
    from, to, mapConfigs: raw.maps,
    sliceMs: params.sliceMs,
    clusterRadius: params.clusterRadius,
    // HELD=0 turns the chunk-loader pass off, for a before/after on one dataset.
    heldSites: process.env.HELD !== "0"
  });
  return { model, tracks: Array.isArray(r) ? r : (r.tracks || []) };
}

function score(DV, raw, params, records) {
  const { tracks } = buildAt(DV, raw, params);
  const rows = [];
  for (const rec of records) {
    const p = modelPosition(tracks, rec.player, rec.ms);
    rows.push({
      rec,
      err: p ? Math.hypot(p.x - rec.x, p.z - rec.z) : NaN,
      found: !!p
    });
  }
  const found = rows.filter(r => r.found);
  const errs = found.map(r => r.err).sort((a, b) => a - b);
  return {
    rows,
    n: records.length,
    matched: found.length,
    // A point the model cannot place at all is a failure, not a missing sample;
    // counting only the matched ones would reward a fit that emits fewer tracks.
    mean: errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : Infinity,
    median: errs.length ? errs[errs.length >> 1] : Infinity,
    worst: errs.length ? errs[errs.length - 1] : Infinity,
    /* Finite even when NOTHING matches, and that is the whole point. Returning
       Infinity for an unmatched set gave the search a perfectly flat landscape
       -- every simplex vertex compared equal, nothing could descend, and it
       reported its own starting midpoint as the optimum while placing 0 of 5
       points. A missing track has to cost a large, COMPARABLE amount so the
       search can still tell "no tracks" from "no tracks and further off". */
    objective: (errs.reduce((a, b) => a + b, 0) + MISS_PENALTY * (records.length - found.length))
               / Math.max(1, records.length)
  };
}

/* What an unplaced calibration point costs the objective, in blocks. Set well
   above any plausible real error so the search never buys a better mean by
   quietly dropping the points it cannot explain. */
const MISS_PENALTY = 600;

/* --------------------------------------------------------------- reporting */

function report(label, s) {
  console.log("\n" + label);
  console.log("  matched " + s.matched + "/" + s.n +
    "   mean " + fmt(s.mean) + "   median " + fmt(s.median) + "   worst " + fmt(s.worst));
  for (const r of s.rows) {
    const t = new Date(r.rec.ms).toISOString().slice(5, 19).replace("T", " ");
    console.log("   " + t + "  " + r.rec.player.padEnd(16) +
      r.rec.activity.padEnd(10) +
      "(" + r.rec.x + "," + r.rec.z + ")".padEnd(2) +
      (r.found ? "  err " + fmt(r.err) : "  NO TRACK"));
  }
}
const fmt = v => (isFinite(v) ? v.toFixed(0).padStart(4) + "b" : "  --");

/* ------------------------------------------------------------ direct search */

/* Nelder-Mead over the real pipeline. Small, derivative-free, and it treats the
   objective as the black box it genuinely is. */
function nelderMead(f, x0, steps, iters) {
  const n = x0.length;
  let simplex = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const p = x0.slice();
    p[i] += steps[i];
    simplex.push(p);
  }
  let vals = simplex.map(f);
  for (let it = 0; it < iters; it++) {
    const order = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]);
    simplex = order.map(i => simplex[i]);
    vals = order.map(i => vals[i]);
    const best = simplex[0], worst = simplex[n];
    const cen = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) cen[j] += simplex[i][j] / n;
    const refl = cen.map((c, j) => c + (c - worst[j]));
    const fr = f(refl);
    if (fr < vals[0]) {
      const exp = cen.map((c, j) => c + 2 * (c - worst[j]));
      const fe = f(exp);
      if (fe < fr) { simplex[n] = exp; vals[n] = fe; } else { simplex[n] = refl; vals[n] = fr; }
    } else if (fr < vals[n - 1]) {
      simplex[n] = refl; vals[n] = fr;
    } else {
      const con = cen.map((c, j) => c + 0.5 * (worst[j] - c));
      const fc = f(con);
      if (fc < vals[n]) { simplex[n] = con; vals[n] = fc; }
      else {
        for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[i].map((v, j) => best[j] + 0.5 * (v - best[j]));
          vals[i] = f(simplex[i]);
        }
      }
    }
  }
  const bi = vals.indexOf(Math.min(...vals));
  return { x: simplex[bi], f: vals[bi] };
}

/* Only parameters with a physical meaning are searched, and each is clamped to
   a range the mechanism allows. Dynmap's tileupdatedelay puts a hard floor of
   30s under the render delay, so letting the search wander below it would buy
   accuracy on these few points by adopting a value the server cannot produce. */
const SPACE = [
  { key: "renderDelayMs", lo: 30000, hi: 180000, step: 20000, show: v => (v / 1000).toFixed(0) + "s" },
  { key: "sliceMs", lo: 30000, hi: 180000, step: 30000, show: v => (v / 1000).toFixed(0) + "s" },
  { key: "clusterRadius", lo: 64, hi: 320, step: 32, show: v => v.toFixed(0) + "b" }
];
const clampVec = v => v.map((x, i) => Math.min(SPACE[i].hi, Math.max(SPACE[i].lo, x)));
const toParams = v => {
  const p = {};
  clampVec(v).forEach((x, i) => p[SPACE[i].key] = x);
  return p;
};
const showVec = v => clampVec(v).map((x, i) => SPACE[i].key + "=" + SPACE[i].show(x)).join("  ");

/* ------------------------------------------------------------------- main */

function main() {
  const args = process.argv.slice(2);
  const DV = loadPipeline();
  const raw = {
    chunks: DV.csv.parse(fs.readFileSync(path.join(DATA, "chunks.csv"), "utf8")).rows,
    players: DV.csv.parse(fs.readFileSync(path.join(DATA, "players.csv"), "utf8")).rows,
    maps: JSON.parse(fs.readFileSync(path.join(ROOT, "tools", "maps.json"), "utf8"))
  };
  const records = assignSessions(loadCalibration());
  const sessions = [...new Set(records.map(r => r.session))];
  console.log(records.length + " calibration records across " + sessions.length + " session(s)");
  if (sessions.length < 2) {
    console.log("\nNOTE: with one session there is nothing to hold out. Any parameters");
    console.log("found here describe THIS site's terrain, not the map -- the numbers");
    console.log("below are a measurement, not a validated fit.");
  }

  const base = { renderDelayMs: undefined, sliceMs: 60000, clusterRadius: 176 };
  const baseBuilt = buildAt(DV, raw, base);
  const baseDelay = baseBuilt.model.renderDelayMs;
  console.log("auto-estimated render delay: " + (baseDelay / 1000).toFixed(0) + "s");
  report("as configured now:", score(DV, raw, base, records));

  if (args.includes("--search")) {
    let evals = 0;
    const f = v => { evals++; return score(DV, raw, toParams(v), records).objective; };
    /* Start from the SHIPPING configuration, not the middle of the ranges. The
       midpoint put every vertex of the initial simplex in a region where the
       pipeline emits no track for this player at all, so all of them scored the
       same miss penalty, the simplex had nothing to descend and the search
       returned its own starting point while placing 0 of 5 points. Seeding at a
       configuration known to produce tracks gives the first comparison
       something to work with. */
    const x0 = [baseDelay, 60000, 176];
    const res = nelderMead(f, x0, [15000, 15000, 24], 60);
    console.log("\nsearched " + evals + " parameter sets");
    console.log("best on ALL points: " + showVec(res.x));
    report("fit scored on the points it was fitted to (OPTIMISTIC):",
      score(DV, raw, toParams(res.x), records));

    if (sessions.length >= 2) {
      console.log("\nleave-one-session-out:");
      let placed = 0, total = 0, sumErr = 0, blindFolds = 0;
      for (const s of sessions) {
        const train = records.filter(r => r.session !== s);
        const test = records.filter(r => r.session === s);
        const rf = nelderMead(v => score(DV, raw, toParams(v), train).objective,
                              x0, [15000, 15000, 24], 40);
        const out = score(DV, raw, toParams(rf.x), test);
        placed += out.matched; total += out.n;
        if (out.matched) sumErr += out.mean * out.matched; else blindFolds++;
        console.log("  hold out " + s + ": placed " + out.matched + "/" + out.n +
          "  mean " + fmt(out.mean) + "  (" + showVec(rf.x) + ")");
      }
      /* Averaging only the folds that matched something is exactly the flattery
         this harness exists to prevent: a fold that placed NOTHING is the worst
         possible outcome, not a missing sample, and dropping it turned two total
         failures and one 44b fold into a confident-looking "44b". Report the
         coverage first, and pool the error over the points actually placed. */
      console.log("  ---");
      console.log("  placed " + placed + "/" + total + " held-out points" +
        (blindFolds ? "; " + blindFolds + " of " + sessions.length + " folds placed NOTHING" : ""));
      console.log("  mean error over the ones it did place: " +
        (placed ? fmt(sumErr / placed) : "  --"));
      if (blindFolds) {
        console.log("  -> NOT a validated result. A fit that cannot place a session it");
        console.log("     did not train on has not generalised, however small the error");
        console.log("     on the sessions it could.");
      }
    }
  }
}

main();

#!/usr/bin/env node
/* eslint-disable no-console */
// ─────────────────────────────────────────────────────────────
// replay — run a real rep history through the engine and print
//          every number that decides training
// ─────────────────────────────────────────────────────────────
// Why this exists: the unit suite is ~1000 synthetic fixtures and it has
// been green through every regression that actually reached production —
// the truncating failure detector, the evidence gates that excluded all
// legacy rows, the manual-load prescription returning null, the basis
// purge that erased a grip's baseline and its capacity floor. Each of
// those is one line of diff here.
//
// Synthetic fixtures test what you thought of. This tests your database.
//
//   npm run replay                 print the report
//   npm run replay -- --snapshot   save it as the comparison point
//   npm run replay -- --check      diff against the snapshot, exit 1 on change
//
// Data: scripts/data/reps.json, a JSON array of rep rows in storage shape
// (or set REPLAY_DATA=/path/to/export.json). Both the export and the
// snapshot are gitignored — this reads your training history, and it does
// not belong in a public repo.
//
// Getting the export, from the Supabase SQL editor:
//   select coalesce(json_agg(row_to_json(reps)), '[]'::json) from reps;

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { prescription, demonstratedCapacityKg, buildFreshLoadMap } from "../src/model/prescription.js";
import { buildThreeExpPriors } from "../src/model/threeExp.js";
import { buildGripBaselines, gripBaselineProgress } from "../src/model/baselines.js";
import { freshFitReps } from "../src/model/load.js";
import { comparableCapacityHistory, isCapacityEvidenceRep, evidenceLabel } from "../src/model/forceRecording.js";
import { computeDeload, deloadStatus } from "../src/model/deload.js";
import { computePersonalRecoveryTausForGrip } from "../src/model/recoveryFit.js";
import { coachingRecommendationContinuous } from "../src/model/coaching.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = process.env.REPLAY_DATA || resolve(HERE, "data/reps.json");
const SNAP = resolve(HERE, ".replay-snapshot.json");
// Durations spanning the six domains, so a change that only moves one end
// of the force-duration curve still shows up.
const TARGETS = [7, 20, 50, 90, 160, 240];

const num = v => (v == null ? null : Number(v));
const round = (v, dp = 2) => (typeof v === "number" && Number.isFinite(v) ? Number(v.toFixed(dp)) : v);

function load() {
  if (!existsSync(DATA)) {
    console.error(`No rep export at ${DATA}`);
    console.error("Set REPLAY_DATA=/path/to/export.json, or see the header of this file.");
    process.exit(2);
  }
  const raw = JSON.parse(readFileSync(DATA, "utf8"));
  const rows = Array.isArray(raw) ? raw : raw.reps || raw.data;
  if (!Array.isArray(rows)) { console.error("Export must be a JSON array of rep rows."); process.exit(2); }
  // Postgres hands numerics back as strings through some clients; the engine
  // compares them numerically, so coerce once here rather than in every model.
  return rows.map(r => ({
    ...r,
    actual_time_s: num(r.actual_time_s), avg_force_kg: num(r.avg_force_kg),
    peak_force_kg: num(r.peak_force_kg), manual_load_kg: num(r.manual_load_kg),
    prescribed_load_kg: num(r.prescribed_load_kg), weight_kg: num(r.weight_kg),
    target_duration: num(r.target_duration), rest_s: num(r.rest_s),
    set_num: num(r.set_num), rep_num: num(r.rep_num),
    force_recording: r.force_recording ? {
      ...r.force_recording,
      acquisition_s: num(r.force_recording.acquisition_s),
      duration_s: num(r.force_recording.duration_s),
    } : r.force_recording,
  }));
}

function report(history) {
  const today = history.reduce((m, r) => (r.date && r.date > m ? r.date : m), "0000-00-00");
  // Every date-relative window the engine consults — 90-day historical-best
  // eligibility, the 30-day floor-decline confirmation — is measured from a
  // reference date, and left to default that is the wall clock. So `--check`
  // reported phantom diffs simply because a day had passed: on 2026-09-16 a
  // clean tree disagreed with its own 2026-09-15 snapshot by 0.1 kg at
  // Crusher L @ 7 s, an older best having aged out of the 90-day window
  // overnight. A harness that cries wolf daily gets ignored, so the windows
  // are anchored to the export instead of to the calendar.
  //
  // It has to be the day AFTER the last rep, not the day of it. referenceDate
  // is retrospective — `prescription` and `demonstratedCapacityKg` skip every
  // rep dated on or after it, which is what makes them usable for backtesting
  // — so anchoring to the last rep's own date would quietly delete the most
  // recent session and move 35 decisions. Anchoring one day later includes
  // every rep and still pins the windows.
  const asOf = ymdPlusDays(today, 1);
  const priors = buildThreeExpPriors(history);
  const baselines = buildGripBaselines(history, priors);
  const freshMap = buildFreshLoadMap(history);
  const grips = [...new Set(history.filter(r => r.grip).map(r => r.grip))].sort();
  const hands = ["L", "R"];

  const out = { asOf: today, windowsAnchoredAt: asOf, totals: {
    reps: history.length,
    capacityEvidence: history.filter(isCapacityEvidenceRep).length,
    afterBasisReconciliation: comparableCapacityHistory(history).length,
    fatigueEligible: [...freshMap.values()].filter(v => v.capacityEligible !== false).length,
  }, grips: {} };

  for (const grip of grips) {
    const fresh = freshFitReps(history).filter(r => r.grip === grip);
    const progress = gripBaselineProgress(history, grip);
    const taus = computePersonalRecoveryTausForGrip(history, grip);
    const g = {
      reps: history.filter(r => r.grip === grip).length,
      freshOpeners: fresh.length,
      distinctDurations: progress.distinctDurations,
      qualifyingReps: progress.qualifyingReps,
      // The card renders its six domains only when a baseline exists.
      baselineDate: baselines[grip]?.date ?? null,
      baselineAmps: baselines[grip]?.amps?.map(a => round(a, 3)) ?? null,
      recoveryTaus: taus ? { fast: round(taus.fast), medium: round(taus.medium), effectiveSets: round(taus.effectiveSets) } : null,
      hands: {},
    };
    for (const hand of hands) {
      if (!history.some(r => r.grip === grip && r.hand === hand)) continue;
      const rec = coachingRecommendationContinuous(history, grip, { today, hand });
      const h = { recommendation: rec ? { T: round(rec.T, 1), loadKg: round(rec.loadKg), source: rec.source ?? null } : null, targets: {} };
      for (const T of TARGETS) {
        const p = prescription(history, hand, grip, T,
          { freshMap, threeExpPriors: priors, referenceDate: asOf });
        h.targets[T] = p ? {
          // The number the athlete is told to pull, and every rule that shaped it.
          value: round(p.value), source: p.source ?? null,
          floorKg: round(demonstratedCapacityKg(history, hand, grip, T, asOf)),
          floored: p.capacityFloored ?? null,
          ceiled: p.wasEnduranceCeiled ?? null,
          anchor: p.anchor ? { T: round(p.anchor.T, 1), F: round(p.anchor.F) } : null,
        } : null;
      }
      g.hands[hand] = h;
    }
    out.grips[grip] = g;
  }

  const deload = computeDeload(history, [], { today });
  const status = deloadStatus ? deloadStatus(history, [], { today }) : null;
  out.recovery = {
    deload: deload.deload, severity: deload.severity, state: deload.state,
    level: status?.level ?? null, haveSignal: status?.haveSignal ?? null,
    measuredGrips: Object.keys(deload.signals?.gripGaps || {}).sort(),
  };

  // Evidence labelling is what tells the athlete a number is an estimate.
  out.evidence = history.reduce((acc, r) => {
    const k = evidenceLabel(r); acc[k] = (acc[k] || 0) + 1; return acc;
  }, {});
  return out;
}

function print(r) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\nreplay — ${r.totals.reps} reps, as of ${r.asOf}\n`);
  console.log(`  capacity evidence ${r.totals.capacityEvidence}   after basis reconciliation ${r.totals.afterBasisReconciliation}   fatigue-eligible ${r.totals.fatigueEligible}`);
  for (const [grip, g] of Object.entries(r.grips)) {
    console.log(`\n  ${grip}  ${g.reps} reps · ${g.freshOpeners} fresh openers · ${g.distinctDurations} durations`);
    console.log(`    baseline ${g.baselineDate ?? "NONE — card shows 'building baseline'"}`);
    if (g.recoveryTaus) console.log(`    recovery  fast ${g.recoveryTaus.fast}  medium ${g.recoveryTaus.medium}  effectiveSets ${g.recoveryTaus.effectiveSets}`);
    for (const [hand, h] of Object.entries(g.hands)) {
      console.log(`    ${hand}  recommends ${h.recommendation ? `${h.recommendation.loadKg}kg @ ${h.recommendation.T}s` : "nothing"}`);
      console.log(`       ${pad("target", 8)}${pad("load", 9)}${pad("floor", 9)}${pad("source", 20)}flags`);
      for (const [T, t] of Object.entries(h.targets)) {
        if (!t) { console.log(`       ${pad(T + "s", 8)}none`); continue; }
        const flags = [t.floored && "floored", t.ceiled && "ceiled"].filter(Boolean).join(" ") || "—";
        console.log(`       ${pad(T + "s", 8)}${pad(t.value + "kg", 9)}${pad(t.floorKg ?? "none", 9)}${pad(t.source, 20)}${flags}`);
      }
    }
  }
  console.log(`\n  recovery  deload=${r.recovery.deload} severity=${r.recovery.severity} state=${r.recovery.state} level=${r.recovery.level} grips=[${r.recovery.measuredGrips}]`);
  console.log(`  evidence  ${Object.entries(r.evidence).map(([k, v]) => `${v}× ${k}`).join("   ")}\n`);
}

// Leaf-by-leaf diff: the point is to name exactly which decision moved.
// today + n days, in the same YYYY-MM-DD shape, UTC-anchored so it can't
// drift across a DST boundary.
function ymdPlusDays(ymd, n) {
  const t = Date.parse(`${ymd}T00:00:00Z`);
  if (!Number.isFinite(t)) return ymd;
  return new Date(t + n * 86400000).toISOString().slice(0, 10);
}

function diff(before, after, path = "", acc = []) {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  for (const k of keys) {
    const a = before?.[k], b = after?.[k], p = path ? `${path}.${k}` : k;
    if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a)) diff(a, b, p, acc);
    else if (JSON.stringify(a) !== JSON.stringify(b)) acc.push({ path: p, before: a, after: b });
  }
  return acc;
}

const history = load();
// ── Policy evaluation ────────────────────────────────────────
// One-step-ahead counterfactual: for every pair of consecutive sessions at
// the same grip / hand / target, ask what the NEXT load should have been
// given only what the FIRST one showed, then score that against what the
// second session actually revealed.
//
// The scoring is honest about direction of information: the candidate load
// is computed from session i alone, while "what would have been right" comes
// from session i+1's measured outcome, which the policy never saw. The
// force-duration exponent is fitted from the athlete's own failures, so the
// same power law appears on both sides — it converts loads to durations, it
// does not supply the answer.
//
//   F ∝ T^(-b)   ⇒   a load change of k multiplies duration by k^(-1/b)
const ZONES = [5, 30, 70, 115, 160, 220];

function zoneBounds(target) {
  let i = 0, best = Infinity;
  ZONES.forEach((z, j) => { const d = Math.abs(Math.log(target / z)); if (d < best) { best = d; i = j; } });
  return {
    lo: i === 0 ? 0 : Math.sqrt(ZONES[i - 1] * ZONES[i]),
    hi: i === ZONES.length - 1 ? Infinity : Math.sqrt(ZONES[i] * ZONES[i + 1]),
  };
}

// Least-squares slope of ln(load) on ln(duration) over the athlete's openers.
function exponentFor(rows) {
  const pts = rows.filter(r => r.load > 0 && r.act > 0).map(r => [Math.log(r.act), Math.log(r.load)]);
  if (pts.length < 8) return null;
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n, my = pts.reduce((s, p) => s + p[1], 0) / n;
  const sxy = pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0);
  const sxx = pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
  const slope = sxx ? sxy / sxx : 0;
  const ssTot = pts.reduce((s, p) => s + (p[1] - my) ** 2, 0);
  const ssRes = pts.reduce((s, p) => s + (p[1] - (my + slope * (p[0] - mx))) ** 2, 0);
  return { b: -slope, r2: ssTot ? 1 - ssRes / ssTot : 0, n };
}

function openers(history) {
  return history
    .filter(r => (Number(r.rep_num) || 1) === 1 && (Number(r.set_num) || 1) === 1
      && r.actual_time_s > 0 && r.target_duration > 0 && r.date)
    .map(r => ({ grip: r.grip, hand: r.hand, date: r.date, tgt: r.target_duration, act: r.actual_time_s,
      load: Number(r.avg_force_kg) || Number(r.manual_load_kg) || Number(r.prescribed_load_kg) || 0 }))
    .filter(r => r.load > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function policyReport(history) {
  const rows = openers(history);
  const exps = {};
  for (const grip of [...new Set(rows.map(r => r.grip))]) {
    const e = exponentFor(rows.filter(r => r.grip === grip));
    if (e && e.b > 0.02) exps[grip] = e;
  }
  const pairs = [];
  const byKey = new Map();
  for (const r of rows) {
    const k = `${r.grip}|${r.hand}|${r.tgt}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  for (const seq of byKey.values()) {
    for (let i = 0; i + 1 < seq.length; i++) {
      const prev = seq[i], next = seq[i + 1], e = exps[prev.grip];
      if (!e) continue;
      pairs.push({ ...next, prev, b: e.b });
    }
  }
  // A candidate load, scored by the duration it would have produced on the
  // day it would have been used.
  const score = (candidate, p) => {
    const predicted = p.act * Math.pow(candidate / p.load, -1 / p.b);
    const { lo, hi } = zoneBounds(p.tgt);
    return { ratio: predicted / p.tgt, err: Math.abs(Math.log(predicted / p.tgt)), inZone: predicted >= lo && predicted <= hi };
  };
  const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

  const candidates = { "shipped (what the engine did)": p => p.load, "hold the load": p => p.prev.load };
  for (const gain of [0.3, 0.5, 0.7, 1.0]) {
    candidates[`proportional gain ${gain.toFixed(1)}`] = p => {
      const implied = p.prev.load * Math.pow(p.prev.act / p.prev.tgt, p.b);
      return p.prev.load + gain * (implied - p.prev.load);
    };
  }
  const out = { exponents: exps, pairs: pairs.length, candidates: {} };
  const shippedErr = pairs.map(p => score(p.load, p).err);
  for (const [name, fn] of Object.entries(candidates)) {
    const scored = pairs.map(p => score(fn(p), p));
    out.candidates[name] = {
      medianErr: round(median(scored.map(s => s.err)), 3),
      inZonePct: Math.round(100 * scored.filter(s => s.inZone).length / scored.length),
      beatsShippedPct: Math.round(100 * scored.filter((s, i) => s.err < shippedErr[i]).length / scored.length),
      medianRatio: round(median(scored.map(s => s.ratio)), 2),
    };
  }
  return out;
}

function printPolicy(r) {
  console.log(`\npolicy replay — ${r.pairs} consecutive same-target session pairs\n`);
  for (const [g, e] of Object.entries(r.exponents)) {
    console.log(`  ${g}: force-duration exponent b = ${round(e.b, 3)} (r² ${round(e.r2, 2)}, n ${e.n})` +
      `  → a 10% lighter load holds ${round(Math.pow(1.1, 1 / e.b), 2)}× longer`);
  }
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\n  ${pad("candidate next load", 30)}${pad("median |ln err|", 16)}${pad("in zone", 9)}${pad("beats shipped", 14)}median ratio`);
  for (const [name, c] of Object.entries(r.candidates)) {
    console.log(`  ${pad(name, 30)}${pad(c.medianErr, 16)}${pad(c.inZonePct + "%", 9)}${pad(c.beatsShippedPct + "%", 14)}${c.medianRatio}`);
  }
  console.log("\n  Lower |ln err| is better; 0 means the load would have hit the target exactly.");
  console.log("  'in zone' is the share that would have trained the quality that was planned.\n");
}

const current = report(history);
const mode = process.argv.includes("--policy") ? "policy"
  : process.argv.includes("--check") ? "check" : process.argv.includes("--snapshot") ? "snapshot" : "print";

if (mode === "policy") { printPolicy(policyReport(history)); process.exit(0); }

if (mode === "snapshot") {
  mkdirSync(dirname(SNAP), { recursive: true });
  writeFileSync(SNAP, JSON.stringify(current, null, 2));
  print(current);
  console.log(`snapshot written to ${SNAP}\n`);
} else if (mode === "check") {
  if (!existsSync(SNAP)) { console.error("No snapshot yet — run: npm run replay -- --snapshot"); process.exit(2); }
  // Metadata about the RUN, not about training. `asOf` and
  // `windowsAnchoredAt` describe which export was replayed and where its
  // date-relative windows were anchored; reporting those as "training
  // decisions changed" is the same crying-wolf failure the anchoring was
  // added to stop, one level up.
  const RUN_METADATA = new Set(["asOf", "windowsAnchoredAt"]);
  const strip = r => Object.fromEntries(
    Object.entries(r).filter(([k]) => !RUN_METADATA.has(k)));
  const changes = diff(strip(JSON.parse(readFileSync(SNAP, "utf8"))), strip(current));
  if (changes.length === 0) { console.log("\nreplay --check: no change to any training decision.\n"); process.exit(0); }
  console.log(`\nreplay --check: ${changes.length} training decision${changes.length === 1 ? "" : "s"} changed\n`);
  for (const c of changes) console.log(`  ${c.path}\n      ${JSON.stringify(c.before)}  →  ${JSON.stringify(c.after)}`);
  console.log("\nIf every line above is intended, re-snapshot. If any is a surprise, that is the bug.\n");
  process.exit(1);
} else {
  print(current);
}

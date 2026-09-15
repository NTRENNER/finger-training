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
  const priors = buildThreeExpPriors(history);
  const baselines = buildGripBaselines(history, priors);
  const freshMap = buildFreshLoadMap(history);
  const grips = [...new Set(history.filter(r => r.grip).map(r => r.grip))].sort();
  const hands = ["L", "R"];

  const out = { asOf: today, totals: {
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
        const p = prescription(history, hand, grip, T, { freshMap, threeExpPriors: priors });
        h.targets[T] = p ? {
          // The number the athlete is told to pull, and every rule that shaped it.
          value: round(p.value), source: p.source ?? null,
          floorKg: round(demonstratedCapacityKg(history, hand, grip, T, null)),
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
const current = report(history);
const mode = process.argv.includes("--check") ? "check" : process.argv.includes("--snapshot") ? "snapshot" : "print";

if (mode === "snapshot") {
  mkdirSync(dirname(SNAP), { recursive: true });
  writeFileSync(SNAP, JSON.stringify(current, null, 2));
  print(current);
  console.log(`snapshot written to ${SNAP}\n`);
} else if (mode === "check") {
  if (!existsSync(SNAP)) { console.error("No snapshot yet — run: npm run replay -- --snapshot"); process.exit(2); }
  const changes = diff(JSON.parse(readFileSync(SNAP, "utf8")), current);
  if (changes.length === 0) { console.log("\nreplay --check: no change to any training decision.\n"); process.exit(0); }
  console.log(`\nreplay --check: ${changes.length} training decision${changes.length === 1 ? "" : "s"} changed\n`);
  for (const c of changes) console.log(`  ${c.path}\n      ${JSON.stringify(c.before)}  →  ${JSON.stringify(c.after)}`);
  console.log("\nIf every line above is intended, re-snapshot. If any is a surprise, that is the bug.\n");
  process.exit(1);
} else {
  print(current);
}

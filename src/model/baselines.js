// ─────────────────────────────────────────────────────────────
// BASELINES + IMPROVEMENT — three-exp fit helpers
// ─────────────────────────────────────────────────────────────
// Pure data transforms for the comparison logic that powers the
// Curve Improvement card, the Hand Asymmetry diagnostic, and the
// per-(hand, grip) baseline-scoping branch in AnalysisView. All
// functions are stateless and side-effect free; AnalysisView
// memoizes the calls.
//
// The "baseline" concept here is the earliest-window fit: walk a
// session log forward in time, accumulate failure reps, and when
// the data set crosses a (count, distinct-duration) threshold,
// freeze a three-exp fit on that window. Date of the baseline is
// the earliest rep in the seed window — the user's curve at
// "first usable measurement," which is then compared to their
// current curve to surface Δ% per zone and overall AUC ratio.
//
// Migrated from Monod (CF + W'/T) to three-exp in March 2026.
// The grip-aware prior shrinkage from threeExpPriors anchors the
// fast amplitude when failures are sparse, so the Power column
// behaves under low-N regimes — which is what made the Monod path
// produce phantom regressions on whichever combo started above
// the pooled mean.

import {
  THREE_EXP_LAMBDA_DEFAULT, fitThreeExpAmps, predForceThreeExp,
  computeAUCThreeExp,
} from "./threeExp.js";
import { ZONE_KEYS, ZONE_REF_T } from "./zones.js";

// Per-zone reference times pulled into a single lookup, indexed by
// zone key. Keeps the improvement loop tight.
const REF_T_BY_ZONE = Object.fromEntries(ZONE_KEYS.map(k => [k, ZONE_REF_T[k]]));

// Three-exp fit with adaptive grip-prior shrinkage. Falls back to a
// flat-prior fit when the grip isn't known or has no learned prior.
// `threeExpPriors` is the Map returned by buildThreeExpPriors(history).
// Returns [a, b, c] amps or null on degenerate fit.
//
// Lambda shrinkage scales with sample count: smaller N → stronger
// pull toward the prior. With THREE_EXP_LAMBDA_DEFAULT / N as the
// scale, the prior dominates at N=1 and fades to noise at N≥10ish.
export function fitAmpsForPts(pts, grip, threeExpPriors) {
  if (!pts || pts.length < 1) return null;
  const prior = (grip && threeExpPriors && threeExpPriors.get)
    ? (threeExpPriors.get(grip) ?? [0, 0, 0])
    : [0, 0, 0];
  const hasPrior = (prior[0] + prior[1] + prior[2]) > 0;
  const lambda = hasPrior ? THREE_EXP_LAMBDA_DEFAULT / Math.max(pts.length, 1) : 0;
  const amps = fitThreeExpAmps(pts, { prior, lambda });
  if (!amps || (amps[0] + amps[1] + amps[2]) <= 0) return null;
  return amps;
}

// Per-zone Δ% from a current amp triple vs a reference triple, plus
// a `total` keyed off the AUC ratio. The AUC total is what the
// Capacity (AUC) chart uses, so headline numbers tie out across
// surfaces. Falls back to zone-average if either AUC is degenerate.
//
// Returns { ...zoneKey: pct, total: pct } or null if either input
// can't produce a positive reference force at any zone.
export function improvementForAmps(curAmps, refAmps) {
  if (!curAmps || !refAmps) return null;
  const pct = (t) => {
    const cur = predForceThreeExp(curAmps, t);
    const ref = predForceThreeExp(refAmps, t);
    if (ref <= 0) return null;
    return Math.round((cur / ref - 1) * 100);
  };
  const result = {};
  for (const k of ZONE_KEYS) {
    const v = pct(REF_T_BY_ZONE[k]);
    if (v == null) return null;
    result[k] = v;
  }
  const curAUC = computeAUCThreeExp(curAmps);
  const refAUC = computeAUCThreeExp(refAmps);
  if (curAUC > 0 && refAUC > 0) {
    result.total = Math.round((curAUC / refAUC - 1) * 100);
  } else {
    const sum = ZONE_KEYS.reduce((s, k) => s + result[k], 0);
    result.total = Math.round(sum / ZONE_KEYS.length);
  }
  return result;
}

// Pooled global baseline. Walks history chronologically, accumulating
// usable failure reps until the buffer holds ≥3 reps across ≥2 distinct
// target durations — that's the gate for a non-degenerate three-exp
// fit. The fit is grip-agnostic (no prior) since this baseline is
// the cross-grip Capacity headline; per-grip baselines use buildGripBaselines.
//
// Returns { date, amps } or null if the threshold is never met.
export function buildGlobalBaseline(history) {
  const allFails = (history || [])
    .filter(r => r.avg_force_kg > 0 && r.avg_force_kg < 500 && r.actual_time_s > 0)
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const acc = [];
  const durs = new Set();
  for (const r of allFails) {
    acc.push(r);
    durs.add(r.target_duration);
    if (acc.length >= 3 && durs.size >= 2) {
      const amps = fitAmpsForPts(
        acc.map(x => ({ T: x.actual_time_s, F: x.avg_force_kg })),
        null,           // pooled across grips → no per-grip prior
        null,           // no priors map needed when grip is null
      );
      if (amps) return { date: acc[0].date, amps };
      return null;
    }
  }
  return null;
}

// Per-grip baselines. For each grip, find the earliest window with
// ≥5 reps across ≥3 distinct target durations and fit a three-exp
// basis. Tighter thresholds than buildGlobalBaseline (5/3 vs 3/2)
// preserve the "small per-grip fits are noisy" damping — the global
// baseline has more cross-grip support to lean on.
//
// Returns { [grip]: { date, amps } }.
export function buildGripBaselines(history, threeExpPriors) {
  const out = {};
  const byGrip = {};
  for (const r of history || []) {
    if (!r.grip) continue;
    if (!(r.avg_force_kg > 0 && r.avg_force_kg < 500)) continue;
    if (!(r.actual_time_s > 0)) continue;
    if (!byGrip[r.grip]) byGrip[r.grip] = [];
    byGrip[r.grip].push(r);
  }
  for (const [grip, reps] of Object.entries(byGrip)) {
    reps.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const acc = [];
    const durs = new Set();
    for (const r of reps) {
      acc.push(r);
      durs.add(r.target_duration);
      if (acc.length >= 5 && durs.size >= 3) {
        const amps = fitAmpsForPts(
          acc.map(x => ({ T: x.actual_time_s, F: x.avg_force_kg })),
          grip,
          threeExpPriors,
        );
        if (amps) out[grip] = { date: acc[0].date, amps };
        break;
      }
    }
  }
  return out;
}

// Per-(grip, hand) baselines. Same seed gate as buildGripBaselines
// (≥5 failures across ≥3 distinct durations) but scoped to a single
// hand on a single grip. Skips entries with hand === "Both" because
// pooled reps belong to buildGripBaselines, not per-hand bookkeeping.
//
// Returns { [`${grip}|${hand}`]: { date, amps } }.
export function buildPerHandGripBaselines(history, threeExpPriors) {
  const out = {};
  const byKey = {};
  for (const r of history || []) {
    if (!r.grip || !r.hand || r.hand === "Both") continue;
    if (!(r.avg_force_kg > 0 && r.avg_force_kg < 500)) continue;
    if (!(r.actual_time_s > 0)) continue;
    const key = `${r.grip}|${r.hand}`;
    if (!byKey[key]) byKey[key] = [];
    byKey[key].push(r);
  }
  for (const [key, reps] of Object.entries(byKey)) {
    reps.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const acc = [];
    const durs = new Set();
    for (const r of reps) {
      acc.push(r);
      durs.add(r.target_duration);
      if (acc.length >= 5 && durs.size >= 3) {
        const grip = key.split("|")[0];
        const amps = fitAmpsForPts(
          acc.map(x => ({ T: x.actual_time_s, F: x.avg_force_kg })),
          grip,
          threeExpPriors,
        );
        if (amps) out[key] = { date: acc[0].date, amps };
        break;
      }
    }
  }
  return out;
}

// Per-grip CURRENT fits — the "now" side of the per-grip improvement
// comparison. Pulls every usable failure on that grip and fits a
// three-exp basis with the grip's prior. Returns { [grip]: amps }.
export function buildGripEstimates(history, threeExpPriors) {
  const out = {};
  const byGrip = {};
  for (const r of history || []) {
    if (!r.grip) continue;
    if (!(r.avg_force_kg > 0 && r.avg_force_kg < 500)) continue;
    if (!(r.actual_time_s > 0)) continue;
    if (!byGrip[r.grip]) byGrip[r.grip] = [];
    byGrip[r.grip].push(r);
  }
  for (const [grip, reps] of Object.entries(byGrip)) {
    const amps = fitAmpsForPts(
      reps.map(r => ({ T: r.actual_time_s, F: r.avg_force_kg })),
      grip,
      threeExpPriors,
    );
    if (amps) out[grip] = amps;
  }
  return out;
}

// Per-grip improvement. For each grip with both a baseline AND a
// current fit, compute Δ% (per-zone + AUC total) via improvementForAmps.
// Returns { [grip]: { ...zoneDeltas, total, baselineDate } }.
export function buildGripImprovement(gripBaselines, gripEstimates) {
  const out = {};
  for (const grip of Object.keys(gripEstimates || {})) {
    const baseline = gripBaselines?.[grip];
    if (!baseline) continue;
    const imp = improvementForAmps(gripEstimates[grip], baseline.amps);
    if (imp) out[grip] = { ...imp, baselineDate: baseline.date };
  }
  return out;
}

// Per-grip hand asymmetry diagnostic. For each grip with both L and R
// fittable reps, compute the asymmetry between hands at a representative
// duration (default 30s — middle of the curve, exercises both fast and
// middle components). Sorted by asymPct descending so the worst gap
// surfaces first.
//
// Returns array of { grip, L, R, stronger, weaker, asymPct }.
export function computeHandAsymmetry(history, gripEstimates, threeExpPriors, refTime = 30) {
  const out = [];
  for (const grip of Object.keys(gripEstimates || {})) {
    const buildHandPts = (hand) => (history || [])
      .filter(r => r.grip === grip && r.hand === hand)
      .filter(r => r.avg_force_kg > 0 && r.avg_force_kg < 500 && r.actual_time_s > 0)
      .map(r => ({ T: r.actual_time_s, F: r.avg_force_kg }));
    const lPts = buildHandPts("L");
    const rPts = buildHandPts("R");
    if (lPts.length < 2 || rPts.length < 2) continue;
    const lAmps = fitAmpsForPts(lPts, grip, threeExpPriors);
    const rAmps = fitAmpsForPts(rPts, grip, threeExpPriors);
    if (!lAmps || !rAmps) continue;

    const lForce = predForceThreeExp(lAmps, refTime);
    const rForce = predForceThreeExp(rAmps, refTime);
    if (!(lForce > 0) || !(rForce > 0)) continue;

    const stronger = lForce >= rForce ? "L" : "R";
    const weaker   = stronger === "L" ? "R" : "L";
    const strongerForce = Math.max(lForce, rForce);
    const weakerForce   = Math.min(lForce, rForce);
    const asymPct = (strongerForce - weakerForce) / strongerForce;

    out.push({
      grip,
      L: lForce, R: rForce,
      stronger, weaker, asymPct,
    });
  }
  return out.sort((a, b) => b.asymPct - a.asymPct);
}

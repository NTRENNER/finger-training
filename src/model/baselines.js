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
  buildThreeExpPriors,
} from "./threeExp.js";
import { ZONE_KEYS, ZONE_REF_T } from "./zones.js";
import { effectiveLoad, freshFitReps } from "./load.js";
import { capacityMultiplier } from "./fatigueBeta.js";

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

// Per-zone Δ% from a current amp triple vs a reference (baseline) triple,
// plus a `total` = the geometric-mean force ratio across the zone refTs
// (identical to the balanced curve score ratio when every zone counts).
// By construction the total ≈ the average of the per-zone Δ%s, so a gain
// in any zone moves it.
//
// UNBASELINED ZONES (July 2026): a baseline only MEASURED durations up to
// its longest real hold. A zone whose refT is well beyond that is pure
// extrapolation — reporting a Δ% there compares your real current curve
// against a GUESSED baseline (e.g. an endurance zone you hadn't trained
// when the baseline froze; the curve simply extended the short-hold shape
// out to 220s). Those zones are marked null ("new" in the UI) and dropped
// from the total, so an extrapolated baseline can't skew the headline. A
// zone counts as baselined when the baseline's longest hold reaches at
// least SUPPORT_MIN_HOLD_FRAC of the zone's refT. Pass baselineMaxHoldS =
// null (default) to disable the gate (every zone reported, prior behavior).
//
// Returns { ...zoneKey: pct|null, total: pct|null } or null if a SUPPORTED
// zone can't produce a positive reference force.
export const SUPPORT_MIN_HOLD_FRAC = 0.6;

export function improvementForAmps(curAmps, refAmps, baselineMaxHoldS = null) {
  if (!curAmps || !refAmps) return null;
  const supported = (t) =>
    baselineMaxHoldS == null || baselineMaxHoldS >= t * SUPPORT_MIN_HOLD_FRAC;
  const result = {};
  const supRefTs = [];
  for (const k of ZONE_KEYS) {
    const t = REF_T_BY_ZONE[k];
    if (!supported(t)) { result[k] = null; continue; }   // unbaselined → "new"
    const cur = predForceThreeExp(curAmps, t);
    const ref = predForceThreeExp(refAmps, t);
    if (ref <= 0) return null;
    result[k] = Math.round((cur / ref - 1) * 100);
    supRefTs.push(t);
  }
  // Balanced total over the SUPPORTED zones only.
  if (supRefTs.length === 0) { result.total = null; return result; }
  const gmForce = (amps) => {
    let logSum = 0;
    for (const t of supRefTs) logSum += Math.log(Math.max(predForceThreeExp(amps, t), 1e-9));
    return Math.exp(logSum / supRefTs.length);
  };
  const curGM = gmForce(curAmps), refGM = gmForce(refAmps);
  result.total = refGM > 0 ? Math.round((curGM / refGM - 1) * 100) : null;
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
  const allFails = freshFitReps(history)
    .filter(r => effectiveLoad(r) > 0 && r.actual_time_s > 0)
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const acc = [];
  const durs = new Set();
  for (const r of allFails) {
    acc.push(r);
    durs.add(r.target_duration);
    if (acc.length >= 3 && durs.size >= 2) {
      const amps = fitAmpsForPts(
        acc.map(x => ({ T: x.actual_time_s, F: effectiveLoad(x) })),
        null,           // pooled across grips → no per-grip prior
        null,           // no priors map needed when grip is null
      );
      if (amps) {
        const maxHoldS = acc.reduce((m, x) => Math.max(m, x.actual_time_s || 0), 0);
        return { date: acc[0].date, amps, maxHoldS };
      }
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
// Returns { [grip]: { date, amps, maxHoldS } }.
export function buildGripBaselines(history, threeExpPriors) {
  const out = {};
  const byGrip = {};
  for (const r of freshFitReps(history)) {
    if (!r.grip) continue;
    if (!(effectiveLoad(r) > 0)) continue;
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
        // LEAK-FREE prior: anchor the baseline toward only the data that
        // existed when this window closed, not the whole (future-
        // inclusive) history. Passing the whole-history threeExpPriors
        // here drags the small, heavily-shrunk baseline UP toward current
        // strength and erases real improvement. Fall back to the passed
        // prior if the cutoff somehow yields nothing for this grip.
        const closeDate = acc.reduce((m, x) => (x.date > m ? x.date : m), acc[0].date);
        const leakFree = buildThreeExpPriors(history, { upTo: closeDate });
        const priorsForFit = leakFree.has(grip) ? leakFree : threeExpPriors;
        const amps = fitAmpsForPts(
          acc.map(x => ({ T: x.actual_time_s, F: effectiveLoad(x) })),
          grip,
          priorsForFit,
        );
        const maxHoldS = acc.reduce((m, x) => Math.max(m, x.actual_time_s || 0), 0);
        if (amps) out[grip] = { date: acc[0].date, amps, maxHoldS };
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
// Returns { [`${grip}|${hand}`]: { date, amps, maxHoldS } }.
export function buildPerHandGripBaselines(history, threeExpPriors) {
  const out = {};
  const byKey = {};
  for (const r of freshFitReps(history)) {
    if (!r.grip || !r.hand || r.hand === "Both") continue;
    if (!(effectiveLoad(r) > 0)) continue;
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
        // Leak-free prior — see buildGripBaselines. The per-hand baseline
        // window is even smaller, so the future-leak distortion is larger.
        const closeDate = acc.reduce((m, x) => (x.date > m ? x.date : m), acc[0].date);
        const leakFree = buildThreeExpPriors(history, { upTo: closeDate });
        const priorsForFit = leakFree.has(grip) ? leakFree : threeExpPriors;
        const amps = fitAmpsForPts(
          acc.map(x => ({ T: x.actual_time_s, F: effectiveLoad(x) })),
          grip,
          priorsForFit,
        );
        const maxHoldS = acc.reduce((m, x) => Math.max(m, x.actual_time_s || 0), 0);
        if (amps) out[key] = { date: acc[0].date, amps, maxHoldS };
        break;
      }
    }
  }
  return out;
}

// Fresh-equivalent load for a rep: divide out the cooked-day capacity
// scale-down so the point reflects what the user could have held FRESH.
// session_cooked is the 0–10 fatigue the session was prescribed under;
// capacityMultiplier returns exp(-β·cooked) ≤ 1 (and exactly 1 for
// cooked null/0), so this only ever scales loads UP, and is a no-op
// for fresh sessions. Used by the freshEq option below.
function freshEqLoad(r, fatigueModel) {
  return effectiveLoad(r) / capacityMultiplier(fatigueModel, r.grip, r.session_cooked ?? 0);
}

// Per-grip CURRENT fits — the "now" side of the per-grip improvement
// comparison. Pulls every usable failure on that grip and fits a
// three-exp basis with the grip's prior. Returns { [grip]: amps }.
//
// opts.freshEq (default false): when true, each rep's load is
// de-cooked to its fresh-equivalent (see freshEqLoad) before fitting.
// Why: sessions trained deep in fatigue use lighter prescribed loads,
// so those raw points drag the current fit down and the improvement
// card reads a phantom regression after hard training weeks. The
// fresh-eq fit answers "did fresh capacity change?" instead of "what
// did the reps literally show?". Default (raw) behavior is unchanged.
export function buildGripEstimates(history, threeExpPriors, opts = {}) {
  const { freshEq = false, fatigueModel = null } = opts;
  const out = {};
  const byGrip = {};
  for (const r of freshFitReps(history)) {
    if (!r.grip) continue;
    if (!(effectiveLoad(r) > 0)) continue;
    if (!(r.actual_time_s > 0)) continue;
    if (!byGrip[r.grip]) byGrip[r.grip] = [];
    byGrip[r.grip].push(r);
  }
  for (const [grip, reps] of Object.entries(byGrip)) {
    const amps = fitAmpsForPts(
      reps.map(r => ({
        T: r.actual_time_s,
        F: freshEq ? freshEqLoad(r, fatigueModel) : effectiveLoad(r),
      })),
      grip,
      threeExpPriors,
    );
    if (amps) out[grip] = amps;
  }
  return out;
}

// Per-(grip, hand) CURRENT fits — the "now" side of the per-hand
// improvement comparison (June 2026, added with the analysis hand
// selector). Mirrors buildGripEstimates but splits by hand; keys are
// `${grip}|${hand}` to align with buildPerHandGripBaselines, so
// buildGripImprovement can consume the two maps unchanged. Per-hand
// fits run on roughly half the data — expect noisier numbers than
// the pooled fits; that's inherent, not a bug.
//
// opts.freshEq / opts.fatigueModel: same fresh-equivalent de-cooking
// as buildGripEstimates — see the comment there. Raw is the default.
export function buildPerHandGripEstimates(history, threeExpPriors, opts = {}) {
  const { freshEq = false, fatigueModel = null } = opts;
  const out = {};
  const byKey = {};
  for (const r of freshFitReps(history)) {
    if (!r.grip || !r.hand || r.hand === "Both") continue;
    if (!(effectiveLoad(r) > 0)) continue;
    if (!(r.actual_time_s > 0)) continue;
    const key = `${r.grip}|${r.hand}`;
    if (!byKey[key]) byKey[key] = [];
    byKey[key].push(r);
  }
  for (const [key, reps] of Object.entries(byKey)) {
    const grip = key.split("|")[0];
    const amps = fitAmpsForPts(
      reps.map(r => ({
        T: r.actual_time_s,
        F: freshEq ? freshEqLoad(r, fatigueModel) : effectiveLoad(r),
      })),
      grip,
      threeExpPriors,
    );
    if (amps) out[key] = amps;
  }
  return out;
}

// Per-grip improvement. For each grip with both a baseline AND a
// current fit, compute Δ% (per-zone + total) via improvementForAmps,
// gating zones the baseline never measured (baseline.maxHoldS).
// Returns { [grip]: { ...zoneDeltas, total, baselineDate } }.
// (Also consumed with per-hand maps — keys just become `grip|hand`.)
export function buildGripImprovement(gripBaselines, gripEstimates) {
  const out = {};
  for (const grip of Object.keys(gripEstimates || {})) {
    const baseline = gripBaselines?.[grip];
    if (!baseline) continue;
    const imp = improvementForAmps(gripEstimates[grip], baseline.amps, baseline.maxHoldS ?? null);
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
    const buildHandPts = (hand) => freshFitReps(history)
      .filter(r => r.grip === grip && r.hand === hand)
      .filter(r => effectiveLoad(r) > 0 && r.actual_time_s > 0)
      .map(r => ({ T: r.actual_time_s, F: effectiveLoad(r) }));
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

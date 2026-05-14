// ─────────────────────────────────────────────────────────────
// PERCEIVED-FATIGUE LEARNING
// ─────────────────────────────────────────────────────────────
// Adapts the per-zone fatigue suppression curve to the user's
// observed response. The defaults in climbingFatigue.fatigueToModifier
// are population-anchored — they say "RPE 7 in Power should suppress
// you ~38.5%". Some users are systematically less suppressed than that
// curve predicts (they hit prescribed loads even when feeling cooked);
// some more. Without learning, the slider would over- or under-correct
// for those users forever.
//
// Signal:
//   For every rep stamped with `perceived_rpe` (the slider value at
//   session start, > 1):
//     predictedSuppression = (rpe / 10) × fullSuppression[zone]
//     observedRatio        = avg_force_kg / threeExp_curve(actual_time_s)
//     observedSuppression  = max(0, 1 − observedRatio)
//
//   `predictedSuppression` is what the modifier said you'd be cut down to.
//   `observedSuppression` is how much you actually fell short of the
//   curve fit on this rep. Their ratio is what the gain should be:
//     ratio_i = observedSuppression / predictedSuppression
//   < 1 → user less cooked than predicted (gain should drop).
//   > 1 → user more cooked than predicted (gain should rise).
//
// Bayesian shrinkage:
//   gain[zone] = (PRIOR_WEIGHT × 1.0 + Σ ratio_i) / (PRIOR_WEIGHT + n)
//
// PRIOR_WEIGHT = 5 keeps the gain anchored to 1.0 (the population
// curve) until the user has accumulated enough RPE-tagged reps for
// the personal signal to dominate. With 0 observations gain = 1.0;
// with 5 ratio-1 observations gain = 1.0; with 20 observations all
// at 0.3, gain ≈ (5 + 6) / 25 = 0.44.
//
// The gain is capped at [0.2, 2.5] so an extreme outlier rep can't
// produce a degenerate modifier that tells the workout runner to
// scale prescriptions to zero.
//
// Returned shape: { max_strength, power, power_strength, strength,
// strength_endurance, endurance } — one scalar per zone. Consumers
// (coaching engine, PrescribedLoadCard) multiply this through the
// existing fatigueToModifier output:
//   adjustedSuppression = baseSuppression × personalGain[zone]
//   adjustedModifier    = 1 − adjustedSuppression
// (i.e., NOT 1 − (1 − base) × gain — that math doesn't compose right
// when gain > 1.)

import { ZONE_KEYS, zoneOf } from "./zones.js";
import {
  fitThreeExpAmps, predForceThreeExp,
  buildThreeExpPriors, THREE_EXP_LAMBDA_DEFAULT,
} from "./threeExp.js";
import { effectiveLoad, freshLoadFor, buildFreshLoadMap } from "./prescription.js";

// Match climbingFatigue.fatigueToModifier's per-zone fullSuppression
// constants exactly — this is how we recover predictedSuppression
// from a rep's perceived_rpe and zone.
const FULL_SUPPRESSION = {
  max_strength:       0.60,
  power:              0.55,
  power_strength:     0.45,
  strength:           0.35,
  strength_endurance: 0.25,
  endurance:          0.15,
};

const PRIOR_WEIGHT = 5;     // observations at gain=1.0 baked in
const GAIN_MIN     = 0.2;
const GAIN_MAX     = 2.5;

// Fit one three-exp curve per (grip, hand) representing FRESH-STATE
// performance — reps with no perceived_rpe (or perceived_rpe == 1).
// Including RPE-tagged reps would let the very performances we're
// trying to learn from drag the curve down, muddying the suppression
// signal. Priors are also rebuilt from fresh-only history for the
// same reason (the caller's threeExpPriors typically came from full
// history). Returns Map<grip, { L: amps|null, R: amps|null }>.
function fitFreshCurvesByGripHand(history) {
  const isFresh = (r) => !Number.isFinite(r?.perceived_rpe) || r.perceived_rpe <= 1;
  const freshHistory = (history || []).filter(isFresh);
  const fmap = buildFreshLoadMap(freshHistory);
  const freshPriors = buildThreeExpPriors(freshHistory);
  const grips = new Set();
  for (const r of freshHistory) if (r?.grip) grips.add(r.grip);
  const out = new Map();
  for (const grip of grips) {
    const prior = freshPriors?.get?.(grip) || null;
    const hasPrior = prior && (prior[0] + prior[1] + prior[2]) > 0;
    const handAmps = { L: null, R: null };
    for (const hand of ["L", "R"]) {
      const pts = freshHistory.filter(r =>
        r.hand === hand && r.grip === grip
        && r.actual_time_s > 0 && effectiveLoad(r) > 0
      ).map(r => ({ T: r.actual_time_s, F: freshLoadFor(r, fmap) }));
      if (pts.length >= 1 && hasPrior) {
        const lambda = THREE_EXP_LAMBDA_DEFAULT / Math.max(pts.length, 1);
        const amps = fitThreeExpAmps(pts, { prior, lambda });
        if (amps && (amps[0] + amps[1] + amps[2]) > 0) handAmps[hand] = amps;
      } else if (pts.length >= 2) {
        const amps = fitThreeExpAmps(pts);
        if (amps && (amps[0] + amps[1] + amps[2]) > 0) handAmps[hand] = amps;
      }
    }
    out.set(grip, handAmps);
  }
  return out;
}

// Compute per-zone learned gains from RPE-tagged reps.
//
// history          — array of rep records with optional perceived_rpe.
// opts.priorWeight — override the shrinkage strength (default PRIOR_WEIGHT).
//
// The fresh curve fit is done internally from history.filter(isFresh) — we
// don't accept an external threeExpPriors here because the caller's priors
// typically include tagged reps and would contaminate the baseline.
//
// Returns: { gains: { max_strength: 1.0, power: ..., ... }, counts:
// { ... } }. Defaults to 1.0 for every zone when there are no
// qualifying observations, so the caller can apply unconditionally.
export function computePersonalGains(history, opts = {}) {
  const priorWeight = opts.priorWeight != null ? opts.priorWeight : PRIOR_WEIGHT;
  // Initialize to all-1.0 so consumers can apply unconditionally.
  const gains = {};
  const counts = {};
  for (const z of ZONE_KEYS) { gains[z] = 1.0; counts[z] = 0; }
  if (!Array.isArray(history) || history.length === 0) return { gains, counts };

  // Filter to reps that carry a learning signal: perceived_rpe > 1,
  // valid duration + force, and a fittable curve for that (grip, hand).
  const tagged = history.filter(r =>
    r && Number.isFinite(r.perceived_rpe) && r.perceived_rpe > 1
    && r.actual_time_s > 0 && r.avg_force_kg > 0
    && r.grip && r.hand
  );
  if (tagged.length === 0) return { gains, counts };

  const ampsByGripHand = fitFreshCurvesByGripHand(history);

  // Accumulate ratios per zone.
  const sumByZone = {};
  for (const z of ZONE_KEYS) sumByZone[z] = 0;

  for (const r of tagged) {
    const zone = zoneOf(r.actual_time_s);
    if (!zone || !FULL_SUPPRESSION[zone]) continue;
    const handAmps = ampsByGripHand.get(r.grip);
    const amps = handAmps?.[r.hand];
    if (!amps) continue;
    const curveF = predForceThreeExp(amps, r.actual_time_s);
    if (!(curveF > 0)) continue;
    const observedRatio       = r.avg_force_kg / curveF;
    const observedSuppression = Math.max(0, 1 - observedRatio);
    const predictedSuppression = (r.perceived_rpe / 10) * FULL_SUPPRESSION[zone];
    if (predictedSuppression <= 0) continue;
    const ratio = observedSuppression / predictedSuppression;
    // Cap per-rep ratio so a single outlier can't dominate the mean.
    sumByZone[zone] += Math.max(0, Math.min(3.0, ratio));
    counts[zone]   += 1;
  }

  for (const z of ZONE_KEYS) {
    const n = counts[z];
    if (n > 0) {
      const shrunk = (priorWeight * 1.0 + sumByZone[z]) / (priorWeight + n);
      gains[z] = Math.max(GAIN_MIN, Math.min(GAIN_MAX, shrunk));
    }
  }

  return { gains, counts };
}

// Apply the learned gain on top of climbingFatigue's base modifier.
//   baseModifier = 1 - baseSuppression
//   adjustedSuppression = baseSuppression × gain
//   adjustedModifier = 1 - adjustedSuppression
// Used by the coaching engine and PrescribedLoadCard so a single
// import covers the math.
export function applyPersonalGain(baseModifier, gain) {
  if (gain == null || gain === 1.0 || !Number.isFinite(gain)) return baseModifier;
  const baseSuppression = 1 - baseModifier;
  const adjustedSuppression = baseSuppression * gain;
  return Math.max(0, Math.min(1, 1 - adjustedSuppression));
}

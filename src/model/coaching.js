// ─────────────────────────────────────────────────────────────
// COACHING RECOMMENDATION ENGINE v2
// ─────────────────────────────────────────────────────────────
// Picks the next training zone using a multi-factor score:
//
//   score = (gap + 0.30) × recency_penalty × external_load
//                       × residual_factor × focus_weight
//
// where:
//   gap             — potential − current, normalized. Largest gap =
//                     biggest training leverage (the physiological
//                     weak compartment). Clamped at -30% so the engine
//                     never falls through on all-negative-gap zones.
//   recency_penalty — exponential recovery curve since last session
//                     on this zone. Power recovers fast (~1.5d),
//                     Endurance slow (~3.5d).
//   external_load   — recent climbing reduces stimulus tolerance,
//                     especially Power. No-climbing baseline = 1.0.
//   residual_factor — F-D chart "dots vs three-exp curve" alignment
//                     for this (zone, hand). Boosts limiter zones,
//                     depresses above-curve zones. See zoneResidualFactor.
//   focus_weight    — per-zone bias from the user's Training Focus
//                     setting (Balanced / Bouldering / etc.). Default
//                     1.0 across all zones for "Balanced".
//
// An earlier version of the engine multiplied in an `intensity_match`
// factor that aligned the zone's neural/metabolic intensity with a
// 1-10 readiness score. That whole pathway has been removed: the
// readiness score was no longer displayed or settable, so the factor
// silently collapsed into a fixed per-zone weighting that biased
// against Power without any user-visible reason. Better to leave
// readiness out of scoring entirely than to keep a hidden lever.
//
// Returns the zone (and hand) with the highest score, plus the
// component scores so the UI can explain WHY this was picked.
//
// Three-exp is the governing model throughout (post Phase A-C
// migration). The residual factor uses the same three-exp fit that
// drives the F-D chart, so the "below the curve" rationale text
// matches the literal purple curve the user is looking at. The gap
// uses prescriptionPotential (three-exp-primary) and the trainAt
// uses empiricalPrescription / prescribedLoad (both three-exp with
// Monod cold-start fallback, see prescription.js).

import { ymdLocal } from "../util.js";
import { ZONE_REF_T, zoneOf } from "./zones.js";
import {
  THREE_EXP_LAMBDA_DEFAULT, fitThreeExpAmps, predForceThreeExp,
} from "./threeExp.js";
import {
  effectiveLoad, freshLoadFor, buildFreshLoadMap,
  empiricalPrescription, prescribedLoad, prescriptionPotential,
} from "./prescription.js";
import {
  TRAINING_FOCUS, DEFAULT_TRAINING_FOCUS, focusWeights,
} from "./training-focus.js";

export const COACH_RECOVERY_TAU_DAYS = {
  power:     1.5,   // PCr/neural recovery is fast
  strength:  2.5,   // Glycolytic recovers middle
  endurance: 3.5,   // Oxidative adaptations need more time
};

// Recovery curve: returns 0 immediately after training the zone, rising
// asymptotically to 1.0 as days_ago grows. Zone-specific tau means
// Power recovers faster than Endurance. Returns 1.0 if zone never trained.
export function recencyPenalty(zone, history, grip) {
  if (!grip || !history || history.length === 0) return 1.0;
  const tau = COACH_RECOVERY_TAU_DAYS[zone] ?? 2;
  const targetT = ZONE_REF_T[zone];
  if (!targetT) return 1.0;
  const matchingDates = history
    .filter(r => r.grip === grip && r.target_duration === targetT)
    .map(r => r.date)
    .filter(Boolean);
  if (matchingDates.length === 0) return 1.0;
  const mostRecent = matchingDates.sort().reverse()[0];
  const today = ymdLocal();
  const daysAgo = Math.max(0, Math.floor(
    (new Date(today).getTime() - new Date(mostRecent).getTime()) / 86400000
  ));
  return 1 - Math.exp(-daysAgo / tau);
}

// External load (climbing) adds systemic fatigue that the in-session
// rep timing alone doesn't fully capture. Recent climbing biases
// against Power most heavily, Endurance least.
export function externalLoadModifier(zone, activities) {
  if (!activities || activities.length === 0) return 1.0;
  const today = ymdLocal();
  const todayMs = new Date(today).getTime();
  let mostRecentClimbHoursAgo = Infinity;
  for (const a of activities) {
    if (a.type !== "climbing") continue;
    if (!a.date) continue;
    const aMs = new Date(a.date).getTime();
    const hoursAgo = (todayMs - aMs) / 3600000;
    if (hoursAgo >= 0 && hoursAgo < mostRecentClimbHoursAgo) {
      mostRecentClimbHoursAgo = hoursAgo;
    }
  }
  if (mostRecentClimbHoursAgo > 48) return 1.0;
  const baseReduction = zone === "power"     ? 0.4
                      : zone === "strength"  ? 0.7
                      : 0.9;
  const recoveryFraction = mostRecentClimbHoursAgo / 48;
  return baseReduction + (1 - baseReduction) * recoveryFraction;
}

// For (hand, grip, target T), compute mean residual between the three-exp
// F-D curve and the actual achieved force on failures in the same zone.
// Positive mean residual = curve over-predicts (your reps fall BELOW the
// curve in that zone) = limiter signal. Negative = you're outperforming
// the curve in that zone.
//
// Returns a multiplier for the coaching score:
//   factor > 1: limiter zone — boost score (train this)
//   factor = 1: at curve — neutral
//   factor < 1: above curve — depress score (other zones have more room)
//
// Uses `amps` (three-exp [a, b, c] for this (hand, grip)) passed in by
// caller so we don't refit per-zone. The same fit drives the F-D chart
// curve, so the residual signal matches the visual "dots vs curve" the
// user sees. `amps` may be null when the (hand, grip) doesn't have
// enough data to fit three-exp, in which case we return 1.0 (neutral).
//
// freshMap: when present, both the curve (which was fit on fresh-
// equivalent loads upstream) and the per-rep actual values use
// freshLoadFor — apples-to-apples comparison. When absent, falls back
// to raw effectiveLoad on both sides so the comparison is still
// internally consistent (just both raw, not both fresh).
export function zoneResidualFactor(history, hand, grip, targetT, amps, freshMap = null) {
  if (!amps || (amps[0] + amps[1] + amps[2]) <= 0) return 1.0;
  const targetZone = zoneOf(targetT);
  const fails = (history || []).filter(r =>
    r.failed && r.hand === hand && r.grip === grip
    && r.target_duration > 0
    && zoneOf(r.target_duration) === targetZone
    && r.actual_time_s > 0 && effectiveLoad(r) > 0
  );
  if (fails.length === 0) return 1.0;
  const loadOf = freshMap
    ? (r) => freshLoadFor(r, freshMap)
    : (r) => effectiveLoad(r);
  let sumRes = 0, sumActual = 0;
  for (const r of fails) {
    const pred = predForceThreeExp(amps, r.actual_time_s);
    const actual = loadOf(r);
    sumRes += pred - actual;
    sumActual += actual;
  }
  const meanActual = sumActual / fails.length;
  if (meanActual <= 0) return 1.0;
  const meanResPct = (sumRes / fails.length) / meanActual;
  // Map mean residual % to a 0.5x–~3x multiplier. 10% under-curve → 2x;
  // at curve → 1.0x; 5% over-curve → 0.5x. Clamped to keep extreme
  // outliers from dominating the score.
  return Math.max(0.5, Math.min(3.0, 1 + meanResPct * 10));
}

// Main coaching recommendation. Returns the highest-scoring (zone, hand)
// with all component factors so the UI can explain the rationale.
//
// opts: { freshMap, threeExpPriors, activities, trainingFocus }
export function coachingRecommendation(history, grip, opts = {}) {
  const {
    freshMap = null, threeExpPriors = null, activities = [],
    trainingFocus = DEFAULT_TRAINING_FOCUS,
  } = opts;
  if (!grip) return null;
  // Per-zone bias multiplier from the user's current training focus
  // (Settings → Training Focus). `balanced` is all 1.0 → no behavior
  // change. Bouldering / sport / endurance lift the matching zone and
  // soften the others. See model/training-focus.js.
  const focusBias = focusWeights(trainingFocus);
  // Pre-compute per-hand three-exp fits so zoneResidualFactor doesn't
  // refit on every (zone, hand) loop iteration. This matches the F-D
  // chart's primary curve (post-Phase-A promotion of three-exp), so the
  // residual factor reflects what the user sees visually ("dots above
  // or below the purple curve in this zone").
  //
  // Both the fit and the residual computation use freshLoadFor — same
  // basis as prescriptionPotential and the chart, so the curves are
  // directly comparable. Allow a single failure when the per-grip prior
  // exists (matches prescriptionPotential's behavior; with a strong
  // prior the basis is anchored and one observation is enough to
  // adjust amplitudes).
  const fmap = freshMap || buildFreshLoadMap(history);
  const ampsByHand = {};
  const prior = (threeExpPriors && threeExpPriors.get) ? threeExpPriors.get(grip) : null;
  const hasPrior = prior && (prior[0] + prior[1] + prior[2]) > 0;
  for (const h of ["L", "R"]) {
    const failPts = (history || []).filter(r =>
      r.failed && r.hand === h && r.grip === grip
      && r.actual_time_s > 0 && effectiveLoad(r) > 0
    ).map(r => ({ T: r.actual_time_s, F: freshLoadFor(r, fmap) }));
    if (failPts.length >= 1 && hasPrior) {
      const lambda = THREE_EXP_LAMBDA_DEFAULT / Math.max(failPts.length, 1);
      const amps = fitThreeExpAmps(failPts, { prior, lambda });
      ampsByHand[h] = (amps && (amps[0] + amps[1] + amps[2]) > 0) ? amps : null;
    } else {
      ampsByHand[h] = null;
    }
  }

  const zones = ["power", "strength", "endurance"];
  const candidates = [];
  for (const zoneKey of zones) {
    const t = ZONE_REF_T[zoneKey];
    if (!t) continue;
    const recency = recencyPenalty(zoneKey, history, grip);
    const ext     = externalLoadModifier(zoneKey, activities);

    // Score per (zone, hand) so the residual factor (which is hand-
    // specific) gets included properly. Pick the highest-scoring hand
    // for this zone. Negative gaps still produce candidates so the
    // engine never falls through; the "shifted gap" gives positive-gap
    // zones priority but doesn't zero out negatives.
    let bestScore = -Infinity;
    let bestHand = null;
    let bestGap = null;
    let bestPotential = null;
    let bestTrainAt = null;
    let bestResFactor = null;
    for (const hand of ["L", "R"]) {
      const trainAt = empiricalPrescription(history, hand, grip, t, { threeExpPriors })
                    ?? prescribedLoad(history, hand, grip, t, freshMap, { threeExpPriors });
      const pot = prescriptionPotential(history, hand, grip, t, { freshMap, threeExpPriors });
      if (trainAt == null || !pot || pot.reliability === "extrapolation") continue;
      const gap = (pot.value - trainAt) / trainAt;
      const resFactor = zoneResidualFactor(history, hand, grip, t, ampsByHand[hand], fmap);
      const gapForScore = Math.max(gap, -0.30); // clamp at -30%
      const focusMult = focusBias[zoneKey] ?? 1.0;
      const handScore = (gapForScore + 0.30) * recency * ext * resFactor * focusMult;
      if (handScore > bestScore) {
        bestScore = handScore;
        bestHand = hand;
        bestGap = gap;
        bestPotential = pot;
        bestTrainAt = trainAt;
        bestResFactor = resFactor;
      }
    }
    if (!bestHand) continue;
    candidates.push({
      zone: zoneKey,
      hand: bestHand,
      gap: bestGap,
      potential: bestPotential.value,
      trainAt: bestTrainAt,
      recency, ext,
      resFactor: bestResFactor,
      focusMult: focusBias[zoneKey] ?? 1.0,
      trainingFocus,
      score: bestScore,
    });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}

// Build a human-readable rationale string from a coachingRecommendation
// result. Used by SessionPlannerCard so the user sees WHY this zone was
// picked, not just THAT it was picked.
export function coachingRationale(rec) {
  if (!rec) return "";
  const compName = rec.zone === "power" ? "fast (PCr)"
                 : rec.zone === "strength" ? "middle (glycolytic)"
                 : "slow (oxidative)";
  // Note: rec.hand still tracks the better-scoring hand internally for
  // the per-zone score, but we don't surface it in the rationale text.
  // Most users train both hands per session, so saying "on Left" /
  // "on Right" at the recommendation level adds noise without
  // changing what they'd do. Per-hand info still appears in the
  // per-zone prescription cells (L 48.7 / R 46.3 etc.).
  const reasons = [];
  if (rec.gap > 0.10) {
    const pct = Math.round(rec.gap * 100);
    reasons.push(`+${pct}% gap (your ${compName} compartment is your widest opportunity)`);
  } else if (rec.gap > -0.05) {
    // Near-zero gap: user is essentially AT potential here. Maintain.
    reasons.push(`at potential (your ${compName} compartment is balanced — best zone among balanced options)`);
  } else {
    // Negative gap: user is exceeding the model's view of potential.
    // The model is running behind your real fitness here.
    const pct = Math.round(-rec.gap * 100);
    reasons.push(`exceeding modeled potential by ${pct}% (the model is conservative here — pick this zone to maintain or push the ceiling further)`);
  }
  // Residual signal — visible on the F-D chart as dots-vs-three-exp-curve.
  // Strong limiter signal when the user's actuals fall systematically below
  // the three-exp curve in this zone (the curve over-predicts → physiology
  // can't keep up → limiter compartment).
  if (rec.resFactor != null) {
    if (rec.resFactor >= 1.5) {
      const pct = Math.round((rec.resFactor - 1) * 10); // approx mean residual %
      reasons.push(`reps fall ~${pct}% below the 3-exp curve here — limiter signal from the F-D chart`);
    } else if (rec.resFactor >= 1.15) {
      reasons.push("reps fall slightly below the 3-exp curve here — mild limiter signal");
    } else if (rec.resFactor < 0.85) {
      reasons.push("reps sit above the 3-exp curve here — strong-zone signal");
    }
  }
  if (rec.recency >= 0.85) {
    reasons.push("zone fully recovered since last session");
  } else if (rec.recency < 0.5) {
    reasons.push("zone is partially recovered, lighter dose is fine");
  }
  if (rec.ext < 0.7) {
    reasons.push("recent climbing biased away from harder zones");
  }
  // Surface the user's training-focus bias when it isn't the
  // balanced default. The pct here is the lift/cut applied to this
  // zone's score; non-balanced focus is sticky enough to deserve
  // an explicit mention so users understand WHY a smaller-gap zone
  // is winning.
  if (rec.focusMult != null && Math.abs(rec.focusMult - 1.0) > 0.05) {
    const focusLabel = TRAINING_FOCUS[rec.trainingFocus]?.label ?? rec.trainingFocus;
    if (rec.focusMult > 1.0) {
      const pct = Math.round((rec.focusMult - 1.0) * 100);
      reasons.push(`prioritised +${pct}% by your ${focusLabel} focus`);
    } else {
      const pct = Math.round((1.0 - rec.focusMult) * 100);
      reasons.push(`deprioritised −${pct}% by your ${focusLabel} focus`);
    }
  }
  return reasons.join("; ");
}

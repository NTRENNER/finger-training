// ─────────────────────────────────────────────────────────────
// COACHING RECOMMENDATION ENGINE v2
// ─────────────────────────────────────────────────────────────
// Picks the next training zone using a multi-factor score:
//
//   score = (gap + 0.30) × intensity_match × recency_penalty
//                       × external_load × residual_factor
//
// where:
//   gap            — potential − current, normalized. Largest gap =
//                    biggest training leverage (the physiological
//                    weak compartment). Clamped at -30% so the engine
//                    never falls through on all-negative-gap zones.
//   intensity_match — how well the zone's neural/metabolic intensity
//                    fits the user's current readiness. Power needs
//                    high readiness; Capacity tolerates lower.
//   recency_penalty — exponential recovery curve since last session
//                    on this zone. Power recovers fast (~1.5d),
//                    Capacity slow (~3.5d).
//   external_load   — recent climbing reduces stimulus tolerance,
//                    especially Power. No-climbing baseline = 1.0.
//   residual_factor — F-D chart "dots vs curve" alignment for this
//                    (zone, hand). Boosts limiter zones, depresses
//                    above-curve zones. See zoneResidualFactor.
//
// Returns the zone (and hand) with the highest score, plus the
// component scores so the UI can explain WHY this was picked.

import { ymdLocal } from "../util.js";
import { ZONE_REF_T, zoneOf } from "./zones.js";
import { fitCF } from "./monod.js";
import {
  effectiveLoad, empiricalPrescription, prescribedLoad, prescriptionPotential,
} from "./prescription.js";

export const COACH_INTENSITY = {
  power:     1.0,   // Highest neural + PCr demand
  strength:  0.7,   // Middle (glycolytic dominant)
  endurance: 0.4,   // Lower per-rep intensity (sub-max sustained)
};

export const COACH_RECOVERY_TAU_DAYS = {
  power:     1.5,   // PCr/neural recovery is fast
  strength:  2.5,   // Glycolytic recovers middle
  endurance: 3.5,   // Oxidative adaptations need more time
};

// Map readiness (1-10) and zone intensity to a 0.1-1.0 multiplier.
// Match curve: peak when zone-intensity matches readiness-normalized;
// gentle dropoff for mismatch (so the system isn't too punishing for
// near-miss readiness scores).
export function intensityMatch(zone, readiness) {
  const zoneI = COACH_INTENSITY[zone] ?? 0.5;
  const readinessNorm = Math.max(0, Math.min(1, (readiness - 1) / 9));
  const mismatch = Math.abs(zoneI - readinessNorm);
  return Math.max(0.1, 1 - Math.pow(mismatch, 1.2));
}

// Recovery curve: returns 0 immediately after training the zone, rising
// asymptotically to 1.0 as days_ago grows. Zone-specific tau means
// Power recovers faster than Capacity. Returns 1.0 if zone never trained.
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

// External load (climbing) adds systemic fatigue that the per-rep
// readiness signal doesn't fully capture. Recent climbing biases
// against Power most heavily, Capacity least.
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

// For (hand, grip, target T), compute mean residual between the failure-
// only Monod curve and the actual achieved force on failures in the same
// zone. Positive mean residual = curve over-predicts (your reps fall
// BELOW the curve in that zone) = limiter signal. Negative = you're
// outperforming the curve in that zone.
//
// Returns a multiplier for the coaching score:
//   factor > 1: limiter zone — boost score (train this)
//   factor = 1: at curve — neutral
//   factor < 1: above curve — depress score (other zones have more room)
//
// Uses `fit` (failure-only Monod) passed in by caller so we don't refit
// per-zone. `fit` may be null when the (hand, grip) doesn't have ≥2
// failures, in which case we return 1.0 (neutral — no signal).
export function zoneResidualFactor(history, hand, grip, targetT, fit) {
  if (!fit) return 1.0;
  const targetZone = zoneOf(targetT);
  const fails = (history || []).filter(r =>
    r.failed && r.hand === hand && r.grip === grip
    && r.target_duration > 0
    && zoneOf(r.target_duration) === targetZone
    && r.actual_time_s > 0 && effectiveLoad(r) > 0
  );
  if (fails.length === 0) return 1.0;
  let sumRes = 0, sumActual = 0;
  for (const r of fails) {
    const pred = fit.CF + fit.W / r.actual_time_s;
    sumRes += pred - effectiveLoad(r);
    sumActual += effectiveLoad(r);
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
// opts: { freshMap, threeExpPriors, readiness, activities }
export function coachingRecommendation(history, grip, opts = {}) {
  const { freshMap = null, threeExpPriors = null, readiness = 5, activities = [] } = opts;
  if (!grip) return null;
  // Pre-compute per-hand failure-only Monod fits so zoneResidualFactor
  // doesn't refit on every (zone, hand) loop iteration. This is the SAME
  // fit the F-D chart displays, so the residual factor matches what the
  // user sees visually ("dots below the curve in this zone").
  const failureFitByHand = {};
  for (const h of ["L", "R"]) {
    const failPts = (history || []).filter(r =>
      r.failed && r.hand === h && r.grip === grip
      && r.actual_time_s > 0 && effectiveLoad(r) > 0
    ).map(r => ({ x: 1 / r.actual_time_s, y: effectiveLoad(r) }));
    failureFitByHand[h] = failPts.length >= 2 ? fitCF(failPts) : null;
  }

  const zones = ["power", "strength", "endurance"];
  const candidates = [];
  for (const zoneKey of zones) {
    const t = ZONE_REF_T[zoneKey];
    if (!t) continue;
    const iMatch  = intensityMatch(zoneKey, readiness);
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
      const trainAt = empiricalPrescription(history, hand, grip, t)
                    ?? prescribedLoad(history, hand, grip, t, freshMap);
      const pot = prescriptionPotential(history, hand, grip, t, { freshMap, threeExpPriors });
      if (trainAt == null || !pot || pot.reliability === "extrapolation") continue;
      const gap = (pot.value - trainAt) / trainAt;
      const resFactor = zoneResidualFactor(history, hand, grip, t, failureFitByHand[hand]);
      const gapForScore = Math.max(gap, -0.30); // clamp at -30%
      const handScore = (gapForScore + 0.30) * iMatch * recency * ext * resFactor;
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
      iMatch, recency, ext,
      resFactor: bestResFactor,
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
  const handLabel = rec.hand === "L" ? "Left" : "Right";
  const reasons = [];
  if (rec.gap > 0.10) {
    const pct = Math.round(rec.gap * 100);
    reasons.push(`+${pct}% gap on ${handLabel} (your ${compName} compartment is your widest opportunity)`);
  } else if (rec.gap > -0.05) {
    // Near-zero gap: user is essentially AT potential here. Maintain.
    reasons.push(`at potential on ${handLabel} (your ${compName} compartment is balanced — best zone among balanced options)`);
  } else {
    // Negative gap: user is exceeding the model's view of potential.
    // The model is running behind your real fitness here.
    const pct = Math.round(-rec.gap * 100);
    reasons.push(`exceeding modeled potential by ${pct}% on ${handLabel} (the model is conservative here — pick this zone to maintain or push the ceiling further)`);
  }
  // Residual signal — visible on the F-D chart as dots-vs-curve. Strong
  // limiter signal when the user's actuals fall systematically below the
  // failure-only Monod curve in this zone.
  if (rec.resFactor != null) {
    if (rec.resFactor >= 1.5) {
      const pct = Math.round((rec.resFactor - 1) * 10); // approx mean residual %
      reasons.push(`reps fall ~${pct}% below the curve here — limiter signal from the F-D chart`);
    } else if (rec.resFactor >= 1.15) {
      reasons.push("reps fall slightly below the curve here — mild limiter signal");
    } else if (rec.resFactor < 0.85) {
      reasons.push("reps sit above the curve here — strong-zone signal (consistent with the conservative-model reading above)");
    }
  }
  if (rec.iMatch >= 0.85) {
    reasons.push("intensity matches your current readiness");
  } else if (rec.iMatch < 0.5) {
    reasons.push("intensity may not match your current readiness — proceed with feel");
  }
  if (rec.recency >= 0.85) {
    reasons.push("zone fully recovered since last session");
  } else if (rec.recency < 0.5) {
    reasons.push("zone is partially recovered, lighter dose is fine");
  }
  if (rec.ext < 0.7) {
    reasons.push("recent climbing biased away from harder zones");
  }
  return reasons.join("; ");
}

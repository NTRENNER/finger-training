// ─────────────────────────────────────────────────────────────
// COACHING RECOMMENDATION ENGINE v2
// ─────────────────────────────────────────────────────────────
// Picks the next training zone using a multi-factor score:
//
//   score = (gap + 0.30) × recency_penalty × external_load
//                       × residual_factor × staleness_boost
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
//   staleness_boost — soft-lockout multiplier from the per-zone
//                     freshness window (model/lockout.js). Stale or
//                     never-trained zones get 2.0×; aging gets 1.4×;
//                     fresh stays at 1.0×. Scales the entire composite
//                     so a stale zone with weak gap still gets
//                     promoted, and a fresh zone with strong gap
//                     still wins on merit.
//
// Two earlier factors that have since been removed:
//   * intensity_match aligned zone intensity with a 1-10 readiness
//     score. The readiness UI was retired; without a settable input
//     the factor collapsed to a fixed per-zone bias against Power
//     for no user-visible reason.
//   * focus_weight came from a "Training Focus" setting (Balanced /
//     Bouldering / Routes / etc.) that biased zones up or down. The
//     whole Training Focus surface was dropped under the curve-trust
//     direction (May 2026, see commit history) — once the F-D curve
//     became the single source of truth for what's lacking, a
//     manual focus override was just noise on top of the data.
//
// Returns the zone (and hand) with the highest score, plus the
// component scores so the UI can explain WHY this was picked.
//
// Three-exp is the governing model throughout (post Phase A-C
// migration). The residual factor uses the same three-exp fit that
// drives the F-D chart, so the "below the curve" rationale text
// matches the literal purple curve the user is looking at. The gap
// uses prescriptionPotential (three-exp) and the trainAt uses
// empiricalPrescription / prescribedLoad (also three-exp, with a
// linear-scale fallback when no per-grip prior exists yet).

import { ymdLocal } from "../util.js";
import { ZONE_REF_T, ZONE_KEYS, zoneOf } from "./zones.js";
import { getZoneStaleness, stalenessBoost } from "./lockout.js";
import {
  THREE_EXP_LAMBDA_DEFAULT, fitThreeExpAmps, predForceThreeExp,
} from "./threeExp.js";
import {
  effectiveLoad, freshLoadFor, buildFreshLoadMap,
  empiricalPrescription, prescribedLoad, prescriptionPotential,
} from "./prescription.js";

// Per-zone recovery time-constants (days). Larger tau = slower
// recovery from a session of that zone. PCr/neural recovers fast,
// glycolytic middle, aerobic adaptations need the most time. Hybrids
// interpolate between their bordering pure zones.
export const COACH_RECOVERY_TAU_DAYS = {
  max_strength:       1.0,   // neural recovers fastest
  power:              1.5,   // PCr / fast-twitch
  power_strength:     2.0,   // crossover
  strength:           2.5,   // glycolytic
  strength_endurance: 3.0,   // crossover
  endurance:          3.5,   // oxidative — slowest adaptation cycle
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
  // Per-zone post-climb readiness: the more PCr/short-duration the
  // zone, the more it benefits from (and tolerates) climbing residual
  // fatigue. Long-duration aerobic work is most affected by a fresh
  // climbing session because it taxes the same recovery systems.
  const baseReduction =
      zone === "max_strength"        ? 0.3  // can train Max Strength surprisingly soon — neural drive recovers fast
    : zone === "power"               ? 0.4
    : zone === "power_strength"      ? 0.55
    : zone === "strength"            ? 0.7
    : zone === "strength_endurance"  ? 0.8
    :                                  0.9; // endurance — wants the most recovery
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
  // Train-to-failure model: every rep with valid actual_time_s is a
  // (T, F) data point. Drop the legacy r.failed filter.
  const fails = (history || []).filter(r =>
    r.hand === hand && r.grip === grip
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
// Train-to-failure / curve-trust philosophy (May 2026): the curve is
// the source of truth. The score function is gap × intensity × recency
// × external × residual × staleness. Training Focus has been removed
// — there is no user-configurable bias overriding the curve's
// recommendation.
//
// opts: { freshMap, threeExpPriors, activities }
export function coachingRecommendation(history, grip, opts = {}) {
  const {
    freshMap = null, threeExpPriors = null, activities = [],
  } = opts;
  if (!grip) return null;
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
    // Train-to-failure model: every rep with valid actual_time_s is a
    // (T, F) data point. Drop the legacy r.failed filter.
    const failPts = (history || []).filter(r =>
      r.hand === h && r.grip === grip
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

  // Per-zone staleness — bumps the score for zones the user has been
  // avoiding. Computed once outside the loop since it's the same map
  // for every (zone, hand) pair. Soft lockout: 1.0 / 1.4 / 2.0 for
  // ok / warning / stale (and stale-or-never gets the same firm 2×).
  // Computed across all of `history`, not per-grip, so all-grips
  // training counts toward keeping a zone fresh — a Crusher Endurance
  // session keeps Endurance unlocked even if Micro Endurance hasn't
  // been touched. Aligns with the soft-nag spirit: we want users to
  // train the zone, not necessarily the (zone, grip) cell.
  const stalenessMap = getZoneStaleness(history);

  // Iterate all 6 zones in physiological order. ZONE_KEYS comes from
  // src/model/zones.js so the order stays in sync with the rest of
  // the model layer.
  const candidates = [];
  for (const zoneKey of ZONE_KEYS) {
    const t = ZONE_REF_T[zoneKey];
    if (!t) continue;
    const recency = recencyPenalty(zoneKey, history, grip);
    const ext     = externalLoadModifier(zoneKey, activities);
    const stale   = stalenessBoost(zoneKey, stalenessMap);

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
      // Staleness multiplier last so it scales the entire composite —
      // a stale zone with weak gap still gets meaningfully promoted,
      // and a fresh zone with strong gap still wins on merit.
      const handScore = (gapForScore + 0.30) * recency * ext * resFactor * stale;
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
      stale,
      staleStatus: stalenessMap[zoneKey]?.status ?? "ok",
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
  // Energy-system label per zone for the rationale text. Names the
  // curve-fit components — fast / middle / slow — for the time
  // domains they sit in. Energy-system tags (PCr / glycolytic /
  // oxidative) are kept in parentheses as the systems each component
  // approximately aligns with in the climbing-physiology literature,
  // not as direct measurements of underlying tissue pools. Hybrids
  // name both crossover components since neither dominates.
  const compName =
      rec.zone === "max_strength"       ? "neural / fast (PCr-aligned)"
    : rec.zone === "power"              ? "fast (PCr-aligned)"
    : rec.zone === "power_strength"     ? "fast / middle (PCr-glycolytic-aligned)"
    : rec.zone === "strength"           ? "middle (glycolytic-aligned)"
    : rec.zone === "strength_endurance" ? "middle / slow (glycolytic-aerobic-aligned)"
    :                                     "slow (oxidative-aligned)";
  // Note: rec.hand still tracks the better-scoring hand internally for
  // the per-zone score, but we don't surface it in the rationale text.
  // Most users train both hands per session, so saying "on Left" /
  // "on Right" at the recommendation level adds noise without
  // changing what they'd do. Per-hand info still appears in the
  // per-zone prescription cells (L 48.7 / R 46.3 etc.).
  const reasons = [];
  if (rec.gap > 0.10) {
    const pct = Math.round(rec.gap * 100);
    reasons.push(`+${pct}% gap (your ${compName} component is your widest opportunity)`);
  } else if (rec.gap > -0.05) {
    // Near-zero gap: user is essentially AT potential here. Maintain.
    reasons.push(`at potential (your ${compName} component is balanced — best zone among balanced options)`);
  } else {
    // Negative gap: user is exceeding the model's view of potential.
    // The model is running behind your real fitness here.
    const pct = Math.round(-rec.gap * 100);
    reasons.push(`exceeding modeled potential by ${pct}% (the model is conservative here — pick this zone to maintain or push the ceiling further)`);
  }
  // Residual signal — visible on the F-D chart as dots-vs-three-exp-curve.
  // Strong limiter signal when the user's actuals fall systematically below
  // the three-exp curve in this zone (the curve over-predicts → physiology
  // can't keep up → limiter component).
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
  // Training Focus bias text removed — focus has been deprecated
  // under the curve-trust philosophy. The curve is the source of
  // truth; no user-configurable bias overrides it.
  return reasons.join("; ");
}

// ─────────────────────────────────────────────────────────────
// CONTINUOUS COACHING ENGINE  (curve-trust, May 2026)
// ─────────────────────────────────────────────────────────────
// Treats the three-exp F-D curve as the source of truth and asks:
// "Where on the continuous curve does training have the biggest
// projected payoff?" The answer is a specific (T, load) pair —
// not snapped to one of six zone reference times.
//
// Math:
//   1. Fit three-exp per hand from all that hand's (T, F) data points
//      under the train-to-failure model (every rep is a failure point
//      regardless of the legacy r.failed flag).
//   2. For each observed rep at (T_i, F_i): compute residual ratio
//      r_i = F_actual / F_curve(T_i). r < 1 → curve over-predicts at
//      that T (limiter signal); r > 1 → user exceeded the curve
//      (strength signal); r ≈ 1 → curve well-calibrated locally.
//   3. Sweep T from 5 to 240 in 5s steps. At each T, smooth the per-
//      rep ratios via a Gaussian kernel (bandwidth ~30s) to get a
//      local "is the curve over- or under-predicting near this T?"
//      signal.
//   4. score(T) = residualBoost(T) × stalenessBoost(zoneOf(T))
//      where residualBoost = 1 + max(0, 1 − localRatio) × 3, so
//      strong over-prediction (localRatio = 0.7) → boost ~1.9, and
//      neutral / above-curve regions → boost = 1.0.
//   5. Argmax over (hand, T). Returns { T_star, hand, loadKg,
//      loadByHand, score, residualBoost, localRatio,
//      stalenessBoost, zone } so the UI can explain WHY this T
//      was picked.
//
// No focus weight — Training Focus was dropped under the curve-trust
// philosophy. No reps/rest/sets — the protocol layer is the caller's
// concern (defaults derived from T elsewhere). This function returns
// only the (T, load) pick.
//
// In data-sparse regions, the smoothed kernel weights tend to zero
// and localRatio defaults to 1.0 (neutral). The score there is just
// stalenessBoost × 1.0, so never-trained / stale zones still get
// recommended when there's no residual signal anywhere — which is
// correct: anchoring the curve at unexplored durations is itself the
// training opportunity.
const CONTINUOUS_T_MIN = 5;     // s — shortest meaningful hold
const CONTINUOUS_T_MAX = 240;   // s — longest meaningful hold
const CONTINUOUS_T_STEP = 5;    // s — sweep granularity
const CONTINUOUS_BANDWIDTH = 30; // s — Gaussian kernel σ for residual smoothing

export function coachingRecommendationContinuous(history, grip, opts = {}) {
  const {
    freshMap = null,
    threeExpPriors = null,
    today = new Date(),
    tMin = CONTINUOUS_T_MIN,
    tMax = CONTINUOUS_T_MAX,
    tStep = CONTINUOUS_T_STEP,
    bandwidth = CONTINUOUS_BANDWIDTH,
  } = opts;

  if (!grip || !history || history.length === 0) return null;

  const stalenessMap = getZoneStaleness(history, today);
  const fmap = freshMap || buildFreshLoadMap(history);
  const prior = (threeExpPriors && threeExpPriors.get) ? threeExpPriors.get(grip) : null;
  const hasPrior = prior && (prior[0] + prior[1] + prior[2]) > 0;
  const sigmaSq = bandwidth * bandwidth;

  // Per-hand: fit curve, pre-compute residual ratios, sweep T.
  const handFits = {};   // hand -> { amps, ratios }
  for (const hand of ["L", "R"]) {
    const handPts = (history || []).filter(r =>
      r.hand === hand && r.grip === grip
      && r.actual_time_s > 0 && effectiveLoad(r) > 0
    );
    if (handPts.length < 1) continue;

    const fitPts = handPts.map(r => ({ T: r.actual_time_s, F: freshLoadFor(r, fmap) }));
    let amps;
    if (hasPrior) {
      const lambda = THREE_EXP_LAMBDA_DEFAULT / Math.max(fitPts.length, 1);
      amps = fitThreeExpAmps(fitPts, { prior, lambda });
    } else if (fitPts.length >= 2) {
      amps = fitThreeExpAmps(fitPts);
    } else {
      continue;  // need ≥2 points without a prior
    }
    if (!amps || (amps[0] + amps[1] + amps[2]) <= 0) continue;

    // Residual ratios at observed (T_i, F_i)
    const ratios = handPts.map(r => {
      const F_curve = predForceThreeExp(amps, r.actual_time_s);
      const F_actual = freshLoadFor(r, fmap);
      return {
        T: r.actual_time_s,
        ratio: F_curve > 0 ? F_actual / F_curve : 1.0,
      };
    });
    handFits[hand] = { amps, ratios };
  }

  if (Object.keys(handFits).length === 0) return null;

  // Sweep T per hand, find argmax score across (hand, T).
  let best = null;
  for (const [hand, { amps, ratios }] of Object.entries(handFits)) {
    for (let T = tMin; T <= tMax; T += tStep) {
      // Gaussian-smoothed local residual ratio at T
      let weightSum = 0;
      let ratioSum = 0;
      for (const p of ratios) {
        const dt = p.T - T;
        const w = Math.exp(-(dt * dt) / (2 * sigmaSq));
        weightSum += w;
        ratioSum += w * p.ratio;
      }
      // No nearby data → localRatio defaults to 1.0 (neutral signal,
      // staleness drives the score in those regions).
      const localRatio = weightSum > 1e-6 ? ratioSum / weightSum : 1.0;

      // Boost rises as the curve over-predicts more (localRatio < 1).
      // localRatio = 0.7 → boost ≈ 1.9; localRatio ≥ 1 → boost = 1.0.
      const residualBoost = 1 + Math.max(0, 1 - localRatio) * 3;

      const zoneKey = zoneOf(T);
      const stale = stalenessBoost(zoneKey, stalenessMap);
      const score = residualBoost * stale;

      if (!best || score > best.score) {
        best = {
          T,
          hand,
          loadKg: predForceThreeExp(amps, T),
          score,
          residualBoost,
          localRatio,
          stalenessBoost: stale,
          staleStatus: stalenessMap[zoneKey]?.status ?? "ok",
          zone: zoneKey,
        };
      }
    }
  }

  if (!best) return null;

  // Augment with the OTHER hand's load at T_star for display
  // ("Train at 92s · L 38 lbs / R 37 lbs").
  const loadByHand = {};
  for (const [hand, { amps }] of Object.entries(handFits)) {
    const f = predForceThreeExp(amps, best.T);
    loadByHand[hand] = f > 0 ? f : null;
  }
  best.loadByHand = loadByHand;
  return best;
}

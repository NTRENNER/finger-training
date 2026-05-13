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
// uses prescription().potential (the unscaled three-exp curve) and the
// trainAt uses prescription().value (the same curve, anchored to the
// most recent rep 1 via the amplitude scalar).

import { ymdLocal } from "../util.js";
import { ZONE_REF_T, ZONE_KEYS, zoneOf } from "./zones.js";
import { getZoneStaleness, stalenessBoost } from "./lockout.js";
import {
  computeSessionFatigue, mostRecentClimbDate, fatigueToModifier,
} from "./climbingFatigue.js";
import {
  THREE_EXP_LAMBDA_DEFAULT, fitThreeExpAmps, predForceThreeExp,
} from "./threeExp.js";
import {
  effectiveLoad, freshLoadFor, buildFreshLoadMap,
  prescription,
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
//
// Matches reps by ZONE bucket (zoneOf), not exact target_duration. Under
// the continuous engine the user can train at any T in the zone's range
// (e.g. T=145s is strength_endurance even though ZONE_REF_T is 160s) —
// the rep should still count as recently training that zone.
export function recencyPenalty(zone, history, grip) {
  if (!grip || !history || history.length === 0) return 1.0;
  const tau = COACH_RECOVERY_TAU_DAYS[zone] ?? 2;
  const matchingDates = history
    .filter(r => r.grip === grip && r.target_duration > 0 && zoneOf(r.target_duration) === zone)
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
// rep timing alone doesn't fully capture. Now RPE-aware: the most
// recent climbing session's per-climb RPEs aggregate into a 1-10
// session fatigue scalar (climbingFatigue.js), which combines with
// hours-ago to scale per-zone prescriptions. One max-effort attempt
// at RPE 9 (low session fatigue) and an hour of moderate RPE 7
// volume (high session fatigue) used to look identical here — they
// shouldn't.
export function externalLoadModifier(zone, activities) {
  if (!activities || activities.length === 0) return 1.0;
  const todayDate = new Date();
  const todayMs = todayDate.getTime();
  // Find the most recent climbing date within the last 3 days.
  const recentDate = mostRecentClimbDate(activities, todayDate, 3);
  if (!recentDate) return 1.0;
  const hoursAgo = (todayMs - Date.parse(recentDate)) / 3600000;
  if (hoursAgo < 0 || hoursAgo > 48) return 1.0;
  const fatigue = computeSessionFatigue(activities, recentDate);
  return fatigueToModifier(zone, fatigue, hoursAgo);
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
  // Computed PER-GRIP (filter history before the staleness call) since
  // Crusher and Micro are independent physiological systems with
  // independent F-D curves — training Crusher endurance does not give
  // Micro endurance any stimulus, so it shouldn't drop Micro endurance's
  // staleness boost. The standalone Curve Coverage card on Setup still
  // uses the all-grips view of getZoneStaleness for its "are you balanced
  // across zones this year" framing — that's a separate question.
  const gripHistory = (history || []).filter(r => r?.grip === grip);
  const stalenessMap = getZoneStaleness(gripHistory);

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
      // Single prescription() call gives both the anchored trainAt
      // (value) and the unscaled curve ceiling (potential). Skip
      // candidates where the curve at this T is pure extrapolation —
      // we don't want to recommend a zone the user has zero data near.
      const p = prescription(history, hand, grip, t, { freshMap, threeExpPriors });
      if (!p || p.value == null || p.reliability === "extrapolation") continue;
      const trainAt = p.value;
      const pot = { value: p.potential, reliability: p.reliability };
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
// CONTINUOUS COACHING ENGINE  (AUC-gain pick, May 2026)
// ─────────────────────────────────────────────────────────────
// Picks the (hand, T) where training will most improve the user's
// physical AUC over the F-D curve. Reading B from the architectural
// review: the engine optimizes for the user's fitness, not the model's
// calibration. The model is just instrumentation — a side-effect of
// training the limiter is that the curve gets more accurate too, but
// that's downstream.
//
// Math:
//   1. Fit three-exp per hand from all that hand's (T, F) data points
//      under the train-to-failure model.
//   2. For each observed rep at (T_i, F_i): compute residual ratio
//      r_i = F_actual / F_curve(T_i). r < 1 → curve over-predicts at
//      that T (you fall below — adaptation room HERE); r > 1 → curve
//      under-predicts (you exceed — already strong, less room).
//   3. Sweep T from 5 to 240 in 5s steps. At each T, smooth the per-
//      rep ratios via a Gaussian kernel (bandwidth ~30s) to get a
//      local "where on the curve do you fall vs the model" signal.
//   4. score(T) = adaptBoost(T) × stalenessBoost(zoneOf(T))
//                                × recencyPenalty(zoneOf(T))
//                                × externalLoadModifier(zoneOf(T), activities)
//      adaptBoost is SYMMETRIC (vs. the earlier residualBoost which
//      only rewarded limiters):
//        room = 1 − localRatio   (positive = below curve, room to grow;
//                                 negative = above curve, at ceiling)
//        adaptBoost = clamp(1 + room × 3, 0.2, 3.0)
//      So localRatio = 0.7 → adaptBoost ≈ 1.9 (limiter, train here),
//         localRatio = 1.0 → adaptBoost = 1.0 (calibrated, neutral),
//         localRatio = 1.2 → adaptBoost ≈ 0.4 (strength signal, skip).
//      stalenessBoost preserves curve coverage incentive.
//      recencyPenalty crushes just-trained zones with the same per-zone
//      tau the discrete engine uses (max_strength fast → endurance slow).
//      externalLoadModifier scales prescriptions down after recent hard
//      climbing — RPE-aware session fatigue from climbingFatigue.js
//      pushes Power down hardest, Endurance least. Returns 1.0 when no
//      recent climb session is found within 48h.
//   5. Argmax over (hand, T). The headline loadKg is the anchored
//      prescription at T_star (curve_shape × amplitude_anchor from
//      prescription()), so a great recent session lifts the whole
//      load surface — see Step 1 commit for the prescription unification.
//
// In data-sparse regions, the smoothed kernel weights tend to zero
// and localRatio defaults to 1.0 (neutral). The score is then driven
// by stalenessBoost — never-trained zones still get recommended when
// no residual signal exists, which is correct: anchoring the curve
// at unexplored durations IS the training opportunity.
const CONTINUOUS_T_MIN = 5;     // s — shortest meaningful hold
const CONTINUOUS_T_MAX = 240;   // s — longest meaningful hold
const CONTINUOUS_T_STEP = 5;    // s — sweep granularity
const CONTINUOUS_BANDWIDTH = 30; // s — Gaussian kernel σ for residual smoothing

export function coachingRecommendationContinuous(history, grip, opts = {}) {
  const {
    freshMap = null,
    threeExpPriors = null,
    activities = [],
    today = new Date(),
    tMin = CONTINUOUS_T_MIN,
    tMax = CONTINUOUS_T_MAX,
    tStep = CONTINUOUS_T_STEP,
    bandwidth = CONTINUOUS_BANDWIDTH,
  } = opts;

  if (!grip || !history || history.length === 0) return null;

  // PER-GRIP staleness: a Crusher endurance session shouldn't reduce
  // Micro endurance's staleness boost — they're independent F-D curves.
  // The Setup tab's Curve Coverage card uses the all-grips view of
  // getZoneStaleness for its zone-balance framing; here we want the
  // grip-scoped view so the engine recommends what THIS grip needs.
  const gripHistory = history.filter(r => r?.grip === grip);
  const stalenessMap = getZoneStaleness(gripHistory, today);
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
  for (const [hand, { ratios }] of Object.entries(handFits)) {
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

      // SYMMETRIC adaptation room: positive when below curve (limiter,
      // adaptation headroom), negative when above curve (already strong,
      // less room to grow). The earlier residualBoost only rewarded
      // limiters; under Reading B (train where AUC will most improve),
      // we ALSO actively skip strength zones since training there
      // contributes less marginal AUC than training a limiter.
      const room = 1 - localRatio;
      const adaptBoost = Math.max(0.2, Math.min(3.0, 1 + room * 3));

      const zoneKey = zoneOf(T);
      const stale = stalenessBoost(zoneKey, stalenessMap);
      // Recency: just-trained zones get crushed (~0 immediately after
      // training, recovering to 1.0 over the zone's tau). Same per-zone
      // tau map the discrete engine uses — see COACH_RECOVERY_TAU_DAYS.
      const recency = recencyPenalty(zoneKey, history, grip);
      // External climbing load: RPE-aware session fatigue from
      // src/model/climbingFatigue.js, scaled by zone (max_strength
      // most sensitive, endurance least). 1.0 when no recent climb
      // session is found within 48h — see externalLoadModifier above.
      const ext = externalLoadModifier(zoneKey, activities);
      const score = adaptBoost * stale * recency * ext;

      if (!best || score > best.score) {
        best = {
          T,
          hand,
          // loadKg is filled in below via prescription() so it carries
          // the amplitude anchor (most recent rep 1 scale-by-residual)
          // — same shape the F-D chart shows but lifted to where the
          // user actually is right now. Matters when the curve fit is
          // running behind a strong recent session.
          loadKg: null,
          score,
          adaptBoost,
          // residualBoost retained as alias for backward-compat with
          // any UI string template still reading the old field name.
          residualBoost: adaptBoost,
          room,
          localRatio,
          stalenessBoost: stale,
          recency,
          ext,
          staleStatus: stalenessMap[zoneKey]?.status ?? "ok",
          zone: zoneKey,
        };
      }
    }
  }

  if (!best) return null;

  // Anchored loads via the unified prescription() — both the headline
  // loadKg (for best.hand) and the per-hand display ("L 38 / R 37").
  // This is the curve_shape × amplitude_anchor product, so a recent
  // overshoot at any T immediately bumps the prescription at every T.
  const presOpts = { freshMap: fmap, threeExpPriors };
  const headPres = prescription(history, best.hand, grip, best.T, presOpts);
  best.loadKg = headPres ? headPres.value : predForceThreeExp(handFits[best.hand].amps, best.T);
  best.scale = headPres ? headPres.scale : 1.0;
  best.anchor = headPres ? headPres.anchor : null;

  const loadByHand = {};
  for (const hand of Object.keys(handFits)) {
    const p = prescription(history, hand, grip, best.T, presOpts);
    loadByHand[hand] = p && p.value > 0 ? p.value : null;
  }
  best.loadByHand = loadByHand;
  return best;
}

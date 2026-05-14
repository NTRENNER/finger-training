// ─────────────────────────────────────────────────────────────
// COACHING RECOMMENDATION ENGINE  (continuous, AUC-gain)
// ─────────────────────────────────────────────────────────────
// Picks the (hand, T) where training will most improve the user's
// physical AUC over the F-D curve. The model is just instrumentation
// — a side-effect of training the limiter is that the curve gets
// more accurate too, but that's downstream.
//
//   score(T) = adaptBoost(T)
//            × stalenessBoost(zoneOf(T))
//            × recencyPenalty(zoneOf(T))
//            × externalLoadModifier(zoneOf(T), activities)
//
// adaptBoost is SYMMETRIC: room = 1 − localRatio, where localRatio is
// the Gaussian-smoothed F_actual / F_curve at T. Below-curve → boost,
// above-curve → penalty. See coachingRecommendationContinuous() for
// the full math.
//
// The earlier discrete (zone × hand, gap-shifted) engine and its
// human-readable rationale formatter were retired in May 2026 along
// with the SessionPlannerCard surface they backed — the continuous
// engine is the single live picker now and Setup builds its own why-
// text from the returned components.
//
// Three-exp is the governing F-D model (post Phase A-C migration).
// Prescriptions are anchored to the most recent rep 1 via
// prescription().value; the score is built on the same three-exp fit
// the F-D chart renders, so the recommendation matches the literal
// purple curve the user is looking at.

import { ymdLocal } from "../util.js";
import { zoneOf } from "./zones.js";
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
// recovery from a session of that zone. Short-T near-MVC work
// recovers fastest; long-T sustained work needs the most time.
// Hybrids interpolate between their bordering pure zones. Values
// are population priors informed by the climbing-physiology
// literature, not personally fit (yet).
export const COACH_RECOVERY_TAU_DAYS = {
  max_strength:       1.0,   // near-MVC, neural-dominated — recovers fastest
  power:              1.5,   // short-T, mostly fast component
  power_strength:     2.0,   // crossover
  strength:           2.5,   // mid-T
  strength_endurance: 3.0,   // crossover
  endurance:          3.5,   // long-T sustained — slowest adaptation cycle
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
  // perceivedFatigue + personalGains opts intentionally not consumed
  // here — see the per-T loop below for the rationale. The recommendation
  // is a pure-math curve question; how tired the user feels today is a
  // separate display/runner overlay (SessionPlanCard tiles, useSessionRunner).

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
      // NOTE: in-the-moment perceivedFatigue (the slider on Setup) is
      // INTENTIONALLY NOT factored into the recommendation pick. The
      // recommendation answers "what stimulus does the curve want next"
      // — that's a pure-math question over staleness, recency, the F-D
      // residual, and recent climbing. How tired the user feels today
      // is a separate concern that scales the prescribed LOAD (in the
      // runner / on the tiles), not which ZONE gets picked.
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

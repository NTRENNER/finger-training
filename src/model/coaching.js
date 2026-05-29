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
//            × focusBoost(zoneOf(T), climbingFocus)
//
// adaptBoost is SYMMETRIC: room = 1 − localRatio, where localRatio is
// the Gaussian-smoothed F_actual / F_curve at T. Below-curve → boost,
// above-curve → penalty. The room is CONFIDENCE-GATED by local data
// density (confidence = effN/(effN+CONFIDENCE_K)), so thin-data zones
// fall back to neutral and let staleness drive. See
// coachingRecommendationContinuous() for the full math.
//
// The old externalLoadModifier term (recent-climbing RPE × hours-ago)
// was removed May 2026 — finger training always follows climbing, so
// that fatigue is a near-constant baseline rather than a deviation to
// correct for, and readiness now lives solely on the cooked slider.
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
import { zoneOf, ZONE_REF_T } from "./zones.js";
import { getZoneStaleness, stalenessBoost } from "./lockout.js";
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
// Buckets reps by ACTUAL hold time (zoneOf(actual_time_s)), matching
// getZoneStaleness's definition of "training a zone." Targeting a 140s
// (S·E) hold but only lasting 60s means the body trained power_strength,
// not S·E — both functions should agree. Falls back to target_duration
// when actual_time_s is missing (legacy or manual rows).
//
// Earlier version used target_duration only. That disagreed with
// getZoneStaleness: an off-target session locked in recency for the
// INTENDED zone (cutting the staleness boost) without producing any
// actual-time data in that zone. Result: genuinely-never-trained zones
// like the user's Crusher S·E never won the recommendation despite
// being correctly flagged as "never sampled" by the coverage card.
// See conversation re: T=160s never being recommended on Crusher.
export function recencyPenalty(zone, history, grip) {
  if (!grip || !history || history.length === 0) return 1.0;
  const tau = COACH_RECOVERY_TAU_DAYS[zone] ?? 2;
  const matchingDates = history
    .filter(r => {
      if (r.grip !== grip) return false;
      const td = r.actual_time_s > 0 ? r.actual_time_s : r.target_duration;
      return td > 0 && zoneOf(td) === zone;
    })
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

// Confidence-gate strength for the residual signal, in units of
// "effective nearby reps" (effN = Gaussian-weighted local sample size).
// confidence = effN/(effN+CONFIDENCE_K): at effN=K confidence is 0.5,
// so the adaptation room is half-weighted; it takes ~3 nearby reps to
// reach ~2/3 weight. Tuned against Nathan's Crusher/Micro history so
// the thin zones the jackknife flagged as unstable stop producing
// confident limiter picks. Re-sweep if the data distribution shifts.
export const CONFIDENCE_K = 1.5;

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
//                                × focusBoost(zoneOf(T), climbingFocus)
//      adaptBoost is SYMMETRIC (vs. the earlier residualBoost which
//      only rewarded limiters) and CONFIDENCE-GATED:
//        room       = 1 − localRatio   (positive = below curve, room to
//                                       grow; negative = at ceiling)
//        confidence = effN / (effN + CONFIDENCE_K)   (effN = Gaussian-
//                     weighted local sample size = weightSum)
//        adaptBoost = clamp(1 + room × 3 × confidence, 0.2, 3.0)
//      So with ample nearby data: localRatio 0.7 → adaptBoost ≈ 1.9
//      (limiter, train here); 1.0 → 1.0 (neutral); 1.2 → ≈ 0.4 (skip).
//      With thin data the confidence factor collapses the room toward 0
//      so adaptBoost → 1.0 and staleness drives — we never act on a
//      residual the data can't support (see jackknife instability note).
//      stalenessBoost preserves curve coverage incentive.
//      recencyPenalty crushes just-trained zones with the same per-zone
//      tau the discrete engine uses (max_strength fast → endurance slow).
//      focusBoost biases the pick toward the zones the user's current
//      climbing goal lives in (bouldering / power_endurance / endurance).
//      Calibrated as a tie-breaker — 1.0× neutral, 1.10–1.20× favor,
//      0.90× de-emphasis. Strong signals (curve-coverage debt, big
//      residual gap, recent climbing fatigue) still dominate; focus
//      only shifts close calls. Returns 1.0 for every zone when
//      climbingFocus is "balanced" or unset.
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
//
// NEVER-ZONE adaptBoost FLOOR (May 2026): when zoneStatus is "never",
// adaptBoost is floored at 1.0 so the 3.0× exploration boost can
// actually win. Otherwise above-curve residuals from neighboring
// sampled zones leak in via the Gaussian kernel (σ=30s) and crush
// the boost down to 0.6, letting a routine Power pick win over a
// never-sampled S·E zone. The curve through a never zone is pure
// extrapolation from the three-exp fit; residual leakage from
// neighbors is unreliable evidence about what would happen at that T.
// Genuine in-zone limiters (adaptBoost > 1) still push higher than
// the 1.0 floor — see per-T loop for the implementation.
const CONTINUOUS_T_MIN = 5;     // s — shortest meaningful hold
const CONTINUOUS_T_MAX = 240;   // s — longest meaningful hold
const CONTINUOUS_T_STEP = 5;    // s — sweep granularity
const CONTINUOUS_BANDWIDTH = 30; // s — Gaussian kernel σ for residual smoothing

// Climbing-focus zone biases. Multipliers in the engine's score
// formula that nudge the recommendation toward the kind of climbing
// the user is training for. Calibrated as a "tip-the-balance" lever:
//   1.20× boosts a favored zone (wins close calls)
//   0.90× de-emphasizes a zone (loses close calls)
//   1.0× is neutral (most zones)
// Strong signals (curve coverage debt, big residual gap, recent
// climbing fatigue) still dominate — focus only shifts ties.
//
// "balanced" (default) returns 1.0 for every zone, so the engine
// runs unchanged when no focus is set.
export const FOCUS_MULTIPLIERS = {
  balanced: {},  // all zones default to 1.0
  bouldering: {
    max_strength: 1.20, power: 1.20,
    strength_endurance: 0.90, endurance: 0.90,
  },
  power_endurance: {
    power: 1.10, power_strength: 1.20, strength: 1.20,
    max_strength: 0.90, endurance: 0.90,
  },
  endurance: {
    strength: 1.10, strength_endurance: 1.20, endurance: 1.20,
    max_strength: 0.90, power: 0.90,
  },
};
export function focusBoost(zone, focus) {
  if (!focus || focus === "balanced") return 1.0;
  const m = FOCUS_MULTIPLIERS[focus];
  return m?.[zone] ?? 1.0;
}

export function coachingRecommendationContinuous(history, grip, opts = {}) {
  const {
    freshMap = null,
    threeExpPriors = null,
    today = new Date(),
    tMin = CONTINUOUS_T_MIN,
    tMax = CONTINUOUS_T_MAX,
    tStep = CONTINUOUS_T_STEP,
    bandwidth = CONTINUOUS_BANDWIDTH,
    climbingFocus = "balanced",
    // Confidence-gate strength (effective nearby reps). Defaults to the
    // module constant; overridable so the K-sweep harness can tune it
    // against real history without editing the constant.
    confidenceK = CONFIDENCE_K,
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

      // CONFIDENCE GATE (May 2026): weightSum is the sum of Gaussian
      // kernel weights from observed reps near T — i.e. an effective
      // local sample size (a rep at T contributes ~1.0; reps within σ
      // contribute ~0.6 each). The residual signal (localRatio vs the
      // curve) is self-referential and noisy where data is thin: a
      // single off rep can masquerade as a limiter. So we shrink the
      // adaptation ROOM toward neutral in proportion to local density,
      // confidence = effN/(effN+K). With little nearby data the room
      // fades to 0, adaptBoost → 1.0 (neutral), and the score is handed
      // to staleness — the right behavior, since a thin/never zone
      // should be driven by the exploration boost, not by an
      // untrustworthy residual. (Jackknife on real per-grip data showed
      // the fitted amplitudes — hence the curve, hence the residuals —
      // swing wildly when one point is dropped in sparse regions; this
      // is the runtime guard against acting on that instability.)
      const effN = weightSum;
      const confidence = effN / (effN + confidenceK);

      // SYMMETRIC adaptation room: positive when below curve (limiter,
      // adaptation headroom), negative when above curve (already strong,
      // less room to grow). The earlier residualBoost only rewarded
      // limiters; under Reading B (train where AUC will most improve),
      // we ALSO actively skip strength zones since training there
      // contributes less marginal AUC than training a limiter. The room
      // is confidence-gated so this only fires on trustworthy data.
      const room = 1 - localRatio;
      let adaptBoost = Math.max(0.2, Math.min(3.0, 1 + room * 3 * confidence));

      const zoneKey = zoneOf(T);
      const zoneStatus = stalenessMap[zoneKey]?.status ?? "ok";
      // Never-sampled zones: floor adaptBoost at 1.0 so the staleness
      // 3.0× exploration boost can actually win the recommendation. The
      // curve through a never-sampled zone is pure extrapolation from
      // the three-exp fit; above-curve residuals leaking in from
      // neighboring zones via the Gaussian kernel are unreliable
      // evidence about what would happen at this T. Without this floor
      // a Crusher S·E zone (T=160s) with no direct samples can have
      // adaptBoost crushed to 0.2 by above-curve residuals from
      // neighboring Strength reps (95-121s) — net score 0.2 × 3.0 = 0.6
      // loses to a routine Power pick at 0.98. The floor preserves the
      // "anchor unexplored zones" intent of the 3.0× boost while still
      // letting genuine in-zone limiters (adaptBoost > 1) push higher.
      if (zoneStatus === "never") {
        adaptBoost = Math.max(adaptBoost, 1.0);
      }
      const stale = stalenessBoost(zoneKey, stalenessMap);
      // Recency: just-trained zones get crushed (~0 immediately after
      // training, recovering to 1.0 over the zone's tau). Same per-zone
      // tau map the discrete engine uses — see COACH_RECOVERY_TAU_DAYS.
      const recency = recencyPenalty(zoneKey, history, grip);
      // NOTE on fatigue: recent-climbing and in-the-moment readiness are
      // INTENTIONALLY NOT factored into the recommendation pick. The
      // recommendation answers "what stimulus does the curve want next"
      // — a pure-math question over staleness, recency, and the
      // confidence-gated F-D residual. Day-to-day readiness is carried
      // by the cooked slider (which learns a per-grip β and scales the
      // prescribed LOAD in the runner / freshMap), not by which ZONE is
      // picked. The old externalLoadModifier (climbing RPE × hours-ago)
      // was removed May 2026: finger training always follows climbing,
      // so climbing fatigue is a near-constant baseline already baked
      // into the numbers rather than a deviation to correct for, and
      // train-to-failure self-corrects regardless — see project notes.
      //
      // Climbing-focus multiplier — biases the engine toward zones
      // that match the user's training goal. 1.0 when focus is
      // "balanced" or unset (no behavior change for default users).
      const focus = focusBoost(zoneKey, climbingFocus);
      const score = adaptBoost * stale * recency * focus;

      // Never-zone tiebreaker: snap to the zone's reference T. The
      // adaptBoost floor (above) flattens the score across every T
      // inside a never zone, so the bare argmax would pin the pick
      // to the zone's lower boundary by first-T tiebreaker (S·E at
      // T=140 instead of T=160, Endurance at T=180 instead of T=220).
      // Bias the comparison toward ZONE_REF_T with a penalty far
      // smaller than any real adaptBoost gradient — sampled-zone
      // picks and meaningful signals still dominate, but within a
      // never zone the canonical refT wins. Keeps the engine's
      // never-zone pick consistent with the refTimes the rest of
      // the app already surfaces (PrescribedLoadCard, TARGET_OPTIONS).
      let effectiveScore = score;
      if (zoneStatus === "never") {
        const refT = ZONE_REF_T[zoneKey];
        if (refT) effectiveScore -= Math.abs(T - refT) * 1e-6;
      }

      if (!best || effectiveScore > best._effectiveScore) {
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
          // Confidence in the residual signal at this T: effN is the
          // effective local sample size (Gaussian-weighted), confidence
          // = effN/(effN+K) in [0,1). Low confidence means the pick was
          // driven by staleness/exploration rather than a trusted
          // residual — the UI uses this to label the pick "estimated /
          // collect a clean rep here" instead of a confident limiter.
          effN,
          confidence,
          focus,           // climbing-focus multiplier at this zone
          climbingFocus,   // the focus key (for "Why" line surfacing)
          staleStatus: zoneStatus,
          zone: zoneKey,
          // Internal: argmax comparator value. Underscore-prefixed
          // so consumers don't depend on it; stripped before return.
          _effectiveScore: effectiveScore,
        };
      }
    }
  }

  if (!best) return null;
  delete best._effectiveScore;

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

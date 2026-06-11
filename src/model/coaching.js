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
// prescription().value.
//
// CURVE-CONSISTENCY CAVEAT (corrected June 2026): the engine fits on
// ALL of a hand's reps with freshMap fatigue-corrected loads, whereas
// the F-D chart (post June-2026 curve-trust pass) renders a fit on
// rep-1-only RAW loads (freshFitReps). These are deliberately different
// de-fatigue strategies — the engine de-fatigues every rep via the
// physiological model; the chart sidesteps the question by showing only
// fresh first reps — so the two curves are close but NOT identical, and
// the old claim that the recommendation "matches the literal purple
// curve" overstated it. They're verified to agree within tolerance on
// consistent data (coaching.test.js), and the residual/LOO signal the
// engine acts on is robust to the small gap; if they ever diverge
// materially, that's the regression test's job to catch.

import { ymdLocal } from "../util.js";
import { zoneOf, ZONE_REF_T } from "./zones.js";
import { getZoneStaleness, stalenessBoost } from "./lockout.js";
import {
  THREE_EXP_LAMBDA_DEFAULT, fitThreeExpAmpsLOO,
  predForceThreeExp,
} from "./threeExp.js";
import {
  effectiveLoad, freshLoadFor, buildFreshLoadMap,
  prescription, recentBestPeakKg,
} from "./prescription.js";
import { computePersonalRecoveryTausForGrip } from "./recoveryFit.js";

// Population mean of COACH_RECOVERY_TAU_DAYS — the normalizer for the
// recovery-cost denominator (see RECOVERY_COST_WEIGHT). Computed once so
// dividing by cost is, on average, score-neutral (a mean-cost zone keeps
// its score); only the spread between cheap and expensive zones matters.
function _meanRecoveryTau() {
  const vs = Object.values(COACH_RECOVERY_TAU_DAYS);
  return vs.reduce((s, v) => s + v, 0) / vs.length;
}

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
// `tauScale` (default 1) multiplies the zone's population recovery tau —
// the engine passes a per-grip personal scale derived from the user's
// fitted recovery taus (see personalTauScale) so a grip that recovers
// slower than the population prior holds its recency penalty longer.
export function recencyPenalty(zone, history, grip, tauScale = 1) {
  if (!grip || !history || history.length === 0) return 1.0;
  const tau = (COACH_RECOVERY_TAU_DAYS[zone] ?? 2) * (tauScale > 0 ? tauScale : 1);
  const matchingDates = history
    .filter(r => {
      if (r.grip !== grip) return false;
      // Fresh efforts only (rep_num === 1, or null for legacy/manual) —
      // a zone is "recently trained" only when a fresh first rep landed
      // there, not when a fatigued within-set rep died at that duration.
      // Mirrors getLastZoneTrainedDates so coverage + recency agree.
      if (!(r.rep_num == null || r.rep_num === 1)) return false;
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

// CONTINUOUS-IN-T RECENCY (June 2026). The zone-bucketed recencyPenalty
// above has a discontinuity at every zone boundary: a 49s hold refreshes
// Power, a 51s hold refreshes Power-Strength, and the penalty jumps at
// T=50 even though the physiological stimulus barely changed. The engine
// sweeps T continuously, so it should see a continuous penalty.
//
// This builds a smooth penalty over T: for each fresh effort at duration
// Tᵢ trained dᵢ days ago, it contributes a "freshly trained" influence
// that (a) decays in TIME toward 0 as dᵢ grows over the local recovery
// tau, and (b) is localized in DURATION by the same log-T Gaussian kernel
// the residual smoother uses, so training at 30s suppresses nearby
// durations smoothly instead of the whole [12,50) bucket as a slab.
// penalty(T) = 1 − maxᵢ[ exp(−dᵢ/τ(T)) · kernel(Tᵢ,T) ]; 1.0 where
// nothing nearby was trained recently. Returns a function of T.
//
// τ(T) interpolates COACH_RECOVERY_TAU_DAYS via zoneOf(T) and is scaled
// by tauScale (personal recovery). The zone version is kept for other
// consumers (deload, display); this continuous one is engine-internal.
export function buildContinuousRecency(history, grip, { sigmaLog = 0.35, tauScale = 1, today = ymdLocal() } = {}) {
  const efforts = (history || [])
    .filter(r => r.grip === grip && (r.rep_num == null || r.rep_num === 1))
    .map(r => {
      const td = r.actual_time_s > 0 ? r.actual_time_s : r.target_duration;
      if (!(td > 0) || !r.date) return null;
      const daysAgo = Math.max(0, Math.floor(
        (new Date(today).getTime() - new Date(r.date).getTime()) / 86400000
      ));
      return { T: td, daysAgo };
    })
    .filter(Boolean);
  const twoSig2 = 2 * sigmaLog * sigmaLog;
  return (T) => {
    if (efforts.length === 0 || !(T > 0)) return 1.0;
    const tau = (COACH_RECOVERY_TAU_DAYS[zoneOf(T)] ?? 2) * (tauScale > 0 ? tauScale : 1);
    let maxInfluence = 0;
    for (const e of efforts) {
      const dl = Math.log(e.T) - Math.log(T);
      const kernel = Math.exp(-(dl * dl) / twoSig2);
      const timeFresh = Math.exp(-e.daysAgo / tau);   // 1 just-trained → 0 long ago
      const influence = kernel * timeFresh;
      if (influence > maxInfluence) maxInfluence = influence;
    }
    return 1 - maxInfluence;   // 0 = just trained right here, 1 = fully recovered/untrained
  };
}

// Personal recovery scale for a grip: ratio of the user's fitted medium
// recovery tau to the population prior, gently compressed and clamped so
// a noisy fit can't swing recency wildly. 1.0 when no personal fit. The
// medium compartment is the one recoveryFit actually personalizes (fast
// is short-set-noisy, slow is held at population), and it's the dominant
// timescale across the training durations the engine sweeps.
export function personalTauScale(personalTaus, grip) {
  // Accept either a Map<grip,taus> (memoized by the hook) or a bare taus
  // object ({fast,medium,slow}) for a single grip.
  let t = null;
  if (personalTaus && typeof personalTaus.get === "function") t = personalTaus.get(grip);
  else if (personalTaus && personalTaus.medium != null) t = personalTaus;
  if (!t || !(t.medium > 0)) return 1;
  // recoveryFit medium prior is PHYS_MODEL_DEFAULT.tauR.medium (~90s).
  const POP_MED = 90;
  const raw = t.medium / POP_MED;
  // Compress toward 1 (sqrt) and clamp to a sane band.
  const compressed = Math.sqrt(raw);
  return Math.max(0.6, Math.min(2.5, compressed));
}

// Confidence-gate strength for the residual signal, in units of
// "effective nearby reps" (effN = Gaussian-weighted local sample size).
// confidence = effN/(effN+CONFIDENCE_K): at effN=K confidence is 0.5,
// so the adaptation room is half-weighted; it takes ~3 nearby reps to
// reach ~2/3 weight. Tuned against Nathan's Crusher/Micro history so
// the thin zones the jackknife flagged as unstable stop producing
// confident limiter picks. Re-sweep if the data distribution shifts.
export const CONFIDENCE_K = 1.5;

// RECOVERY-COST WEIGHT (June 2026). The stated training goal is curve
// lift per unit of CALENDAR time, but the bare score treats a session
// costing 3.5 recovery days (endurance) the same as one costing 1.0
// (max-strength). Dividing the score by a normalized recovery cost
// implements "largest expected curve-lift per fatigue cost" — the
// efficiency term from the original design note. costFactor =
// (meanTau / zoneTau) ^ RECOVERY_COST_WEIGHT: >1 for cheap (fast-
// recovering) zones, <1 for expensive ones, exactly 1 at the mean so
// the term is score-neutral on average. The exponent tempers it to a
// tie-breaker — strong residual/coverage signals still dominate; it
// nudges otherwise-close picks toward the cheaper stimulus. Set to 0
// to disable.
//
// Deliberately GENTLE (0.15): tuned so the cost spread across zones stays
// small enough to never override a genuine limiter or coverage signal —
// even a heavily prior-diluted limiter (adaptBoost as low as ~1.1) must
// still win over a cheaper on-curve zone. At 0.15 the cheapest zone
// (max_strength, τ=1) gets ~+11% and the most expensive (endurance,
// τ=3.5) ~−6%, a ~1.18× max spread. Raising it materially re-introduces
// the "cheap zone poaches every pick" failure (see coaching.test.js).
export const RECOVERY_COST_WEIGHT = 0.15;

// WEAKER-HAND BOOST (June 2026). The (hand, T) argmax treated L and R
// symmetrically, but training the weaker hand buys more POOLED-curve
// AUC per session (you lift the lagging side) and is injury-protective
// against asymmetry. This biases the pick toward the weaker hand in
// proportion to the measured gap: boost = 1 + WEAKER_HAND_BOOST_MAX ·
// asym, where asym = (strong − weak)/strong at a mid-curve reference,
// applied only to the weaker hand and capped. A tie-breaker, not an
// override: a real limiter or stale zone on the strong hand still wins.
export const WEAKER_HAND_BOOST_MAX = 0.25;   // up to +25% at large asymmetry

// OVERLOAD STEP (June 2026). Prescribing exactly the curve value asks
// you to reproduce your current capacity, not exceed it — under train-
// to-failure that re-measures the curve but doesn't intentionally push
// it. A small progression nudge makes "raise the curve" deliberate:
// failure lands a hair beyond current capacity. Applied to the short/
// strength end (the W'/anaerobic-dominated region) where added load is
// the right lever; long near-asymptote holds keep their target duration
// instead (overloading there means holding LONGER, which the T pick
// already handles). See applyOverload().
export const OVERLOAD_STEP_FRAC = 0.025;   // +2.5% load on the short end
export const OVERLOAD_FULL_T   = 20;       // s — full overload at/below this T
export const OVERLOAD_ZERO_T   = 120;      // s — overload fades to 0 by here

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
//   2. For each observed rep at (T_i, F_i): compute the LEAVE-ONE-OUT
//      residual ratio r_i = F_actual / F_curve_loo(T_i) — the curve
//      refit with that point removed (closed form, fitThreeExpAmpsLOO),
//      so the residual isn't artificially shrunk by the curve chasing
//      its own data. r < 1 → you fall below (adaptation room HERE);
//      r > 1 → you exceed (already strong, less room).
//   3. Sweep T from 5 to 240 in 5s steps. At each T, smooth the per-rep
//      ratios via a LOG-T Gaussian kernel (σ ≈ 0.35 in log-duration, so
//      the neighborhood scales with T) to get a local "where on the
//      curve do you fall vs the model" signal. (Was a fixed 30s linear
//      kernel — 2.5× wider than the whole max-strength zone.)
//   4. score(T) = adaptBoost(T) × stalenessBoost(zoneOf(T))
//                                × recencyAt(T)        [continuous in T]
//                                × focusBoost(zoneOf(T), climbingFocus)
//                                × costFactor(zoneOf(T))  [recovery cost]
//                                × handBoost(hand)        [weaker-hand]
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
//      recencyAt(T) crushes just-trained DURATIONS (continuous, no zone-
//      boundary cliff), decaying over the local recovery tau scaled by
//      the grip's personal recovery fit (max_strength fast → endurance
//      slow). costFactor divides by the zone's recovery cost so the pick
//      favors curve-lift per calendar day. handBoost favors the weaker
//      hand in proportion to measured L/R asymmetry.
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
// sampled zones leak in via the log-T Gaussian kernel and crush
// the boost down to 0.6, letting a routine Power pick win over a
// never-sampled S·E zone. The curve through a never zone is pure
// extrapolation from the three-exp fit; residual leakage from
// neighbors is unreliable evidence about what would happen at that T.
// Genuine in-zone limiters (adaptBoost > 1) still push higher than
// the 1.0 floor — see per-T loop for the implementation.
const CONTINUOUS_T_MIN = 5;     // s — shortest meaningful hold
const CONTINUOUS_T_MAX = 240;   // s — longest meaningful hold
const CONTINUOUS_T_STEP = 5;    // s — sweep granularity
// LOG-T kernel bandwidth (June 2026). The residual smoother now works in
// log-duration, so σ is dimensionless (≈ fractional spread): σ=0.35 means
// a rep influences durations within ~±35% of its own T at the ~0.6 level.
// This replaces the old linear σ=30s, which was 2.5× wider than the whole
// 12s-wide max-strength zone (so Power reps swamped the max-strength
// signal) yet needlessly narrow out at 200s. Scaling the neighborhood
// with duration is the natural geometry for an exponential-decay curve.
const CONTINUOUS_BANDWIDTH_LOG = 0.35;

// Overload nudge as a function of target T — full at the short/strength
// end, fading to 0 by OVERLOAD_ZERO_T (long near-asymptote holds overload
// via duration, not load). Returns the multiplicative load factor.
export function overloadFactor(T) {
  if (!(T > 0)) return 1;
  let frac;
  if (T <= OVERLOAD_FULL_T) frac = 1;
  else if (T >= OVERLOAD_ZERO_T) frac = 0;
  else frac = (OVERLOAD_ZERO_T - T) / (OVERLOAD_ZERO_T - OVERLOAD_FULL_T);
  return 1 + OVERLOAD_STEP_FRAC * frac;
}

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

// ── Fresh short-duration test constants + helper ──────────────
// "Short end" = durations at/under this — the max-strength/power
// territory where the three-exp fit extrapolates unless it has real
// failure anchors.
export const FRESH_TEST_SHORT_T_MAX = 10;   // seconds
// Days without a short-T failure before the engine starts advising a
// fresh max test. Half the peak-cap lookback (90d) so the advisory
// fires while the cap still has a valid peak to protect with.
export const FRESH_TEST_STALE_DAYS = 45;

// Days since this grip's last FAILED rep at target ≤ FRESH_TEST_SHORT_T_MAX,
// from already-grip-filtered history. Failures are the only reps the
// curve fit learns an upper bound from at short T (successes are just
// lower-bound constraints), so "trained 5s recently" without a failure
// still leaves the short end unanchored.
// Returns { staleDays, lastDate, recommended }:
//   staleDays   — days since last short-T failure (null = never)
//   recommended — true when never failed short, or staleDays exceeds
//                 FRESH_TEST_STALE_DAYS
export function shortEndFailureStaleness(gripHistory, todayStr) {
  let lastDate = null;
  for (const r of gripHistory || []) {
    if (!r || r.failed !== true) continue;
    if (!(Number(r.target_duration) <= FRESH_TEST_SHORT_T_MAX)) continue;
    if (!r.date) continue;
    if (lastDate == null || r.date > lastDate) lastDate = r.date;
  }
  if (lastDate == null) return { staleDays: null, lastDate: null, recommended: true };
  const days = Math.round(
    (new Date(`${todayStr}T00:00:00`).getTime() - new Date(`${lastDate}T00:00:00`).getTime()) / 86400000
  );
  return { staleDays: days, lastDate, recommended: days > FRESH_TEST_STALE_DAYS };
}

export function coachingRecommendationContinuous(history, grip, opts = {}) {
  const {
    freshMap = null,
    threeExpPriors = null,
    today = new Date(),
    tMin = CONTINUOUS_T_MIN,
    tMax = CONTINUOUS_T_MAX,
    tStep = CONTINUOUS_T_STEP,
    bandwidthLog = CONTINUOUS_BANDWIDTH_LOG,
    climbingFocus = "balanced",
    // Per-grip personal recovery taus (Map<grip,{fast,medium,slow}>) from
    // recoveryFit.computePersonalRecoveryTaus. When present, scales the
    // recency penalty so a slow-recovering grip holds its penalty longer.
    personalTaus = null,
    // Recovery-cost efficiency weight (see RECOVERY_COST_WEIGHT). Override
    // to 0 to disable the fatigue-cost denominator.
    recoveryCostWeight = RECOVERY_COST_WEIGHT,
    // Apply the overload nudge to the returned load (see overloadFactor).
    // Override to false for callers that want the bare curve value.
    overload = true,
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

  // ── Fresh short-duration test advice ─────────────────────────
  // The curve fit only LEARNS from failures, and the short end
  // (≤ FRESH_TEST_SHORT_T_MAX s) is where failures are rarest — the
  // June 2026 review found months of history with no failure under
  // 7s, leaving F(5s) pure extrapolation (bounded only by the peak
  // cap). Zone staleness can't catch this: a submax 5s session
  // counts as "trained" without anchoring anything. Track days since
  // the last short-T FAILURE for this grip and surface a "do a fresh
  // max test" advisory when it's stale — Setup's Why line tells the
  // user to schedule it BEFORE climbing, since every anchor logged
  // after bouldering reads systematically low.
  // (Computed against gripHistory below; attached to the returned
  // rec as `freshTest`.)

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
  const twoSig2Log = 2 * bandwidthLog * bandwidthLog;

  // Personal recovery scale for this grip (1.0 if no personal fit) and a
  // continuous-in-T recency function built once over this grip's efforts.
  // If the caller didn't pass a memoized personalTaus map, fit this one
  // grip's taus here (cheap; the card memoizes the whole rec call).
  const gripTaus = (personalTaus && typeof personalTaus.get === "function")
    ? personalTaus.get(grip)
    : (personalTaus || computePersonalRecoveryTausForGrip(history, grip));
  const tauScale = personalTauScale(gripTaus, grip);
  const todayStr = today instanceof Date ? ymdLocal(today) : (today || ymdLocal());
  const recencyAt = buildContinuousRecency(history, grip, { sigmaLog: bandwidthLog, tauScale, today: todayStr });

  // Per-hand: fit curve, pre-compute DE-BIASED (leave-one-out) residual
  // ratios, sweep T. Also record a mid-curve strength per hand so the
  // argmax can favor the weaker hand (more pooled-AUC gain per session).
  const handFits = {};   // hand -> { amps, ratios, strength }
  for (const hand of ["L", "R"]) {
    const handPts = (history || []).filter(r =>
      r.hand === hand && r.grip === grip
      && r.actual_time_s > 0 && effectiveLoad(r) > 0
    );
    if (handPts.length < 1) continue;

    const fitPts = handPts.map(r => ({ T: r.actual_time_s, F: freshLoadFor(r, fmap) }));
    // LOO ratios are computed against the curve fit with each point left
    // out, so the residual isn't shrunk by the curve chasing its own data.
    let amps, looRatios;
    if (hasPrior) {
      const lambda = THREE_EXP_LAMBDA_DEFAULT / Math.max(fitPts.length, 1);
      ({ amps, ratios: looRatios } = fitThreeExpAmpsLOO(fitPts, { prior, lambda }));
    } else if (fitPts.length >= 2) {
      ({ amps, ratios: looRatios } = fitThreeExpAmpsLOO(fitPts));
    } else {
      continue;  // need ≥2 points without a prior
    }
    if (!amps || (amps[0] + amps[1] + amps[2]) <= 0) continue;

    const ratios = fitPts.map((p, i) => ({ T: p.T, ratio: looRatios[i] ?? 1.0 }));
    // Mid-curve strength (force at 30s) — the asymmetry reference, same
    // duration computeHandAsymmetry uses.
    const strength = predForceThreeExp(amps, 30);
    handFits[hand] = { amps, ratios, strength };
  }

  if (Object.keys(handFits).length === 0) return null;

  // Weaker-hand boost factor per hand (1.0 unless both hands fit and the
  // hand is the weaker one). asym = (strong − weak)/strong at 30s.
  const handBoost = { L: 1.0, R: 1.0 };
  if (handFits.L && handFits.R && handFits.L.strength > 0 && handFits.R.strength > 0) {
    const sL = handFits.L.strength, sR = handFits.R.strength;
    const strong = Math.max(sL, sR), weak = Math.min(sL, sR);
    const asym = strong > 0 ? (strong - weak) / strong : 0;
    const weaker = sL < sR ? "L" : "R";
    handBoost[weaker] = 1 + WEAKER_HAND_BOOST_MAX * Math.max(0, Math.min(1, asym));
  }

  // Recovery-cost normalizer (mean tau) for the efficiency denominator.
  const meanTau = _meanRecoveryTau();

  // Sweep T per hand, find argmax score across (hand, T).
  let best = null;
  for (const [hand, { ratios }] of Object.entries(handFits)) {
    for (let T = tMin; T <= tMax; T += tStep) {
      // LOG-T Gaussian-smoothed local residual ratio at T. Distance is
      // measured in log-duration so the neighborhood scales with T — a
      // rep at 30s influences 20–45s strongly but barely touches 5s or
      // 120s, instead of the old fixed 30s window that let Power reps
      // swamp the 12s-wide max-strength zone.
      let weightSum = 0;
      let ratioSum = 0;
      for (const p of ratios) {
        if (!(p.T > 0)) continue;
        const dl = Math.log(p.T) - Math.log(T);
        const w = Math.exp(-(dl * dl) / twoSig2Log);
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
      // Recency: just-trained durations get crushed (~0 immediately after
      // training, recovering to 1.0 over the local recovery tau). Now
      // CONTINUOUS in T (buildContinuousRecency) — no zone-boundary cliff
      // — and scaled by the grip's personal recovery tau (tauScale).
      const recency = recencyAt(T);
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

      // RECOVERY-COST efficiency term. The goal is curve lift per CALENDAR
      // day, not per session — so a cheap-to-recover zone is worth more
      // per unit of expected lift. Crucially, the cost modulates ONLY the
      // LIFT (the part of adaptBoost above the neutral 1.0), NOT the whole
      // score: a zone you're already on-curve at (adaptBoost ≈ 1, no lift)
      // gets no cost bonus, so a cheap on-curve zone can't poach the pick
      // from a genuine limiter. costMult = (meanTau/zoneTau)^w (>1 cheap,
      // <1 expensive, 1 at the mean); the grip's personal tauScale cancels
      // in the ratio. Gated to SAMPLED zones — never-sampled exploration
      // is a coverage objective decided by staleness/refT, independent of
      // recovery cost (you need the measurement regardless). w=0 disables.
      const zoneTau = (COACH_RECOVERY_TAU_DAYS[zoneKey] ?? meanTau);
      const costMult = (recoveryCostWeight > 0 && zoneStatus !== "never")
        ? Math.pow(meanTau / zoneTau, recoveryCostWeight)
        : 1;
      // Cost-adjusted adaptBoost: neutral (1.0) is the fixed point, only
      // the lift/penalty deviation is scaled by relative recovery cost.
      const costFactor = costMult;   // surfaced on the pick for the Why line
      const adaptBoostCosted = 1 + (adaptBoost - 1) * costMult;

      // WEAKER-HAND boost: favor the lagging hand (more pooled-AUC gain).
      const hBoost = handBoost[hand] ?? 1.0;

      const score = adaptBoostCosted * stale * recency * focus * hBoost;

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
          costFactor,      // recovery-cost efficiency multiplier
          handBoost: hBoost, // weaker-hand bias at this hand
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

  // Coverage-driven picks → target the zone's REFERENCE time, not the
  // residual-argmax T. When a zone wins because it's stale/never (a
  // coverage pick, not a confident in-zone limiter), the within-zone
  // argmax often lands near the zone's UPPER boundary — e.g. T≈45s in
  // Power's [12,50) window, where reps sit a touch below the curve. If
  // capacity has grown even slightly, a 45s target overshoots past 50s
  // into Power-Strength, so the stale zone never actually gets refreshed
  // (the classic "I trained Power but it still shows stale" trap). Snap
  // to the zone reference time (Power → 30s): mid-window with overshoot
  // margin, and because the curve is higher at the shorter hold it
  // naturally prescribes a HEAVIER load for a SHORTER target — the
  // overshoot-tolerant dose that actually clears the stale flag.
  if (best.staleStatus === "stale" || best.staleStatus === "never") {
    const refT = ZONE_REF_T[best.zone];
    if (refT > 0 && Math.abs(best.T - refT) > 1e-6) {
      best.T = Math.max(tMin, Math.min(tMax, refT));
      best.coverageSnap = true;   // surfaced in the SessionPlan "Why" line
    }
  }

  // Anchored loads via the unified prescription() — both the headline
  // loadKg (for best.hand) and the per-hand display ("L 38 / R 37").
  // This is the curve_shape × amplitude_anchor product, so a recent
  // overshoot at any T immediately bumps the prescription at every T.
  const presOpts = { freshMap: fmap, threeExpPriors };
  // OVERLOAD: the prescription reproduces current capacity; a small
  // progression nudge on the short/strength end makes the dose a true
  // overload so failure lands a hair beyond where you are now — the
  // deliberate "raise the curve" step. Duration-weighted (full ≤20s,
  // 0 by ≥120s); long near-asymptote holds overload via duration (the
  // already-chosen longer T), not added load. Surfaced for the Why line.
  const oFactor = overload ? overloadFactor(best.T) : 1;
  best.overloadFactor = oFactor;

  // Absolute ceiling AFTER overload: the user's recent measured
  // instantaneous peak for this (hand, grip). prescription() already
  // caps its value at PEAK_CAP_FRACTION × peak; the overload bump may
  // push past that fraction (that's the point of overload — failure a
  // hair beyond current capacity) but never past the full peak itself.
  // No isometric hold can exceed instantaneous max, so prescribing
  // above it is just a guaranteed unattainable target (see the
  // 2026-06-08 94.1 kg case in prescription.js). Null for manual
  // histories → no cap.
  const capPeak = (hand, v) => {
    if (v == null) return v;
    const peak = recentBestPeakKg(history, hand, grip);
    return peak != null && v > peak ? peak : v;
  };

  const headPres = prescription(history, best.hand, grip, best.T, presOpts);
  const headBase = headPres ? headPres.value : predForceThreeExp(handFits[best.hand].amps, best.T);
  best.loadKg = capPeak(best.hand, headBase != null ? headBase * oFactor : headBase);
  best.loadBeforeOverload = headBase;
  best.scale = headPres ? headPres.scale : 1.0;
  best.anchor = headPres ? headPres.anchor : null;
  best.peakCapped = headPres?.peakCapped === true
    || (headBase != null && best.loadKg != null && best.loadKg < headBase * oFactor);

  const loadByHand = {};
  for (const hand of Object.keys(handFits)) {
    const p = prescription(history, hand, grip, best.T, presOpts);
    loadByHand[hand] = p && p.value > 0 ? capPeak(hand, p.value * oFactor) : null;
  }
  best.loadByHand = loadByHand;

  // Fresh short-T test advisory — see shortEndFailureStaleness above.
  // Attached unconditionally so the Why line can (a) prompt a fresh
  // max test when the short end is unanchored, and (b) remind the
  // user to do short-T picks BEFORE climbing.
  best.freshTest = shortEndFailureStaleness(gripHistory, todayStr);

  return best;
}

// ─────────────────────────────────────────────────────────────
// COOKEDNESS LOAD SCALING
// ─────────────────────────────────────────────────────────────
// The cookedness slider is an explicit user override: "I am beat up
// today, back the loads off." This module is the one place that turns
// that 0-10 self-report into a load multiplier.
//
// It is a fixed, transparent, published rate. There is no learner.
//
// ── Why there is no learner (September 2026) ─────────────────
// This file replaces fatigueBeta.js, which maintained a per-grip β
// updated by online SGD after every session — client-side, mirrored by
// a Postgres trigger on rep insert — with the multiplier exp(−β·c).
//
// It was disabled from the load path in July 2026 after it ran away
// (β ≈ 0.46, up to 3× load corrections, and a distorted curve fit),
// but the learner and its trigger were left running on the theory that
// the numbers were a harmless readiness diagnostic. They were not
// harmless. At deletion, live β values had railed to BOTH clamp
// boundaries across users and grips — 0.5 (the maximum, on two grips,
// one with 62 observations) and 0.0034 (effectively the minimum) —
// which is what a learner does when its gradient carries no signal.
// Had anything reconnected that output to loads, exp(−0.5 × 7) would
// have prescribed 3% of capacity.
//
// The deeper reason is that the quantity was never estimable from this
// data, for three independent reasons, any one of which is fatal:
//
//   1. NOT IDENTIFIED. The app scales the prescription BY the cooked
//      value before the pull happens. Treatment is a deterministic
//      function of the covariate, so the residual cannot separate "he
//      was tired" from "we already made it lighter." No amount of
//      cleaner input fixes this; only randomising the scaling would,
//      and nobody wants their training randomised.
//
//   2. NO VARIANCE IN THE REGRESSOR. 74% of sessions were unrated or
//      0, and the climb-derived suggestion that filled the rest
//      saturated at 10 on 72% of climbing days.
//
//   3. NON-CLASSICAL MEASUREMENT ERROR. The under-logging of
//      projecting sessions biased the suggestion LOW precisely on the
//      most fatiguing days, so what variance existed was partly
//      sign-flipped. (Fixed in climbingFatigue.js — but see 1.)
//
// What replaces it is closed-loop: the next prescription learns from
// the measured outcome of the last one. A miss is observable in the
// force trace, and a measured pull already contains whatever fatigue,
// sleep, or cold garage did to the athlete that day. Predicting the
// disturbance is open-loop control; measuring the output is not, and
// this app has the sensor.
//
// So the slider stays, because a person who knows they are wrecked
// should be able to say so and be listened to. It scales loads at a
// rate the UI states outright, and it is never inferred on the user's
// behalf.

export const COOKED_MIN = 0;
export const COOKED_MAX = 10;

// The published rate. A straight reduction per cooked point, floored
// so a slider at 10 cannot prescribe below 75% of fresh capacity.
// Chosen in July 2026: it cannot run away, the UI label shows exactly
// the multiplier applied, and the de-cook side (buildFreshLoadMap
// dividing it back out for the curve fit) is bounded at 1/0.75 = 1.33×,
// far inside the MAX_FRESH_INFLATION = 3 guard.
export const COOKED_SCALE_PER_POINT = 0.025;  // -2.5% per cooked point
export const COOKED_SCALE_FLOOR     = 0.75;   // never below -25% (cooked 10)

// Load multiplier for a cookedness value. Returns 1.0 (no scale-down)
// for null/undefined/0, so it is safe to apply unconditionally:
//
//   prescribedLoad = freshLoad * capacityMultiplier(cooked);
//
export function capacityMultiplier(cooked) {
  if (cooked == null) return 1.0;
  const c = Number(cooked);
  if (!Number.isFinite(c)) return 1.0;
  const clamped = Math.min(Math.max(c, COOKED_MIN), COOKED_MAX);
  if (!(clamped > 0)) return 1.0;
  return Math.max(COOKED_SCALE_FLOOR, 1 - COOKED_SCALE_PER_POINT * clamped);
}

// ── On provenance ────────────────────────────────────────────
// There is deliberately no `cooked_source` column. Every path that can
// now write reps.session_cooked or daily_state.cooked is the user's own
// input, so the field needs no qualifier: a value means they said it,
// and null means they didn't. The provenance problem was never a
// missing label — it was the app writing inferences into a field
// reserved for self-reports, and that is fixed at the source.
//
// Rows written before September 2026 are NOT clean: an untouched
// slider stored 0, and a climb-derived suggestion auto-filled and
// stored whatever it computed. Neither is distinguishable after the
// fact from a real report, so treat pre-September cookedness as
// unreliable rather than trying to repair it.

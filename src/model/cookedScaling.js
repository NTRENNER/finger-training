// ─────────────────────────────────────────────────────────────
// COOKEDNESS LOAD SCALING
// ─────────────────────────────────────────────────────────────
// The cookedness slider records how the athlete feels. A separate explicit
// choice applies a load reduction; keeping the recommended load is the default.
// This module defines that reduction and resolves the saved session choice.
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
// The rating is never inferred on the user's behalf. When the athlete opts
// into a reduction, the UI states its rate and the session saves that choice.

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

// New sessions freeze both the stated rating and the multiplier used at start.
// A later diary edit must not rewrite the adjustment actually prescribed.
export function sessionAdjustment(cooked, adjustLoad = false) {
  const reported = cooked == null || !Number.isFinite(Number(cooked))
    ? null : Math.max(COOKED_MIN, Math.min(COOKED_MAX, Number(cooked)));
  return { version: 1, reported_cooked: reported, load_choice: adjustLoad ? "adjust" : "keep",
    applied_multiplier: adjustLoad ? capacityMultiplier(reported) : 1 };
}

export function recordedAdjustment(rep, cookedByDate = null) {
  const snapshot = rep?.session_adjustment;
  if (snapshot != null) {
    const mult = snapshot.applied_multiplier;
    if (snapshot.version === 1 && typeof mult === "number" && Number.isFinite(mult)
        && mult >= COOKED_SCALE_FLOOR && mult <= 1) {
      return { multiplier: mult, basis: ["legacy_session_estimate", "unrecorded_adjustment"].includes(snapshot.source)
        ? snapshot.source : "recorded_session_adjustment" };
    }
    // Corrupt or future metadata must not reopen the day-level fallback.
    return { multiplier: 1, basis: "unknown_session_adjustment" };
  }
  // Older explicit session values retain the historical estimate. They are
  // not proof of what the old client applied (some old sliders auto-filled).
  if (rep?.session_cooked != null && Number.isFinite(Number(rep.session_cooked))) {
    return { multiplier: capacityMultiplier(rep.session_cooked), basis: "legacy_session_estimate" };
  }
  // A diary rating cannot tell us whether THIS session was adjusted.
  return { multiplier: 1, basis: cookedByDate?.[rep?.date] != null
    ? "unknown_legacy_adjustment" : "unrecorded_adjustment" };
}

// Before changing a historical rating, preserve the interpretation already in
// use. Older rows have no snapshot; label that preserved value as an estimate,
// never as proof that the original client actually adjusted the load.
export function sessionRatingUpdates(rep, cooked) {
  const prior = recordedAdjustment(rep);
  return {
    session_cooked: cooked == null ? null : Number(cooked),
    session_adjustment: rep.session_adjustment ?? {
      version: 1,
      reported_cooked: rep.session_cooked ?? null,
      applied_multiplier: prior.multiplier,
      source: prior.basis,
    },
  };
}

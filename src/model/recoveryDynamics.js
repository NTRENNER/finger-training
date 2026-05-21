// ─────────────────────────────────────────────────────────────
// RECOVERY DYNAMICS — between-rep capacity restoration
// ─────────────────────────────────────────────────────────────
// The F-D model + RepCurveChart already show how force declines
// during a single rep. This module surfaces the OTHER side of the
// model: how much capacity comes back between reps.
//
// At constant load (which the runner enforces post-commit 90),
// time-to-failure scales monotonically with available capacity at
// the start of the rep. So the ratio
//
//     actual_time_s(N) / actual_time_s(1)
//
// is a reasonable proxy for "what fraction of fresh capacity did
// rep N start with?" Rep 1 is the baseline (always 1.0); subsequent
// reps land below depending on how well recovery keeps up with
// depletion over the inter-rep rest interval.
//
// The predicted series uses the same three-component physModel
// that drives RepCurveChart's forecast. The diagnostic is the
// gap between observed and predicted: observed > predicted means
// the user recovered FASTER than their personal recovery taus
// suggest (good — taus may need a re-fit); observed < predicted
// means they recovered SLOWER (under-rested, undertrained
// recovery side, or external fatigue).
//
// Pure functions; no React, no Supabase. Tested in isolation.

import { predictRepTimes } from "./fatigue.js";

// Observed recovered fraction per rep, computed from a session's
// rep records. Rep 1 always anchors at 1.0; subsequent reps return
// actual_time_s(N) / actual_time_s(1).
//
// Inputs:
//   reps - array of rep records for ONE session, ONE hand. Must
//          carry actual_time_s. Caller is responsible for the
//          single-hand filter and the constant-load assumption
//          (the runner enforces constant load within a set; this
//          function trusts the data).
//
// Returns: array of { rep, observedFraction } points, ordered by
//   rep_num. observedFraction is null when actual_time_s is missing
//   or zero (UI should skip rendering null points).
export function buildObservedRecoverySeries(reps) {
  if (!Array.isArray(reps) || reps.length === 0) return [];
  const sorted = [...reps].sort((a, b) => (a.rep_num ?? 0) - (b.rep_num ?? 0));
  const t1 = Number(sorted[0]?.actual_time_s);
  // No valid rep 1 → ratio undefined for the whole set.
  if (!(t1 > 0)) {
    return sorted.map((_, i) => ({ rep: i + 1, observedFraction: null }));
  }
  return sorted.map((r, i) => {
    const t = Number(r.actual_time_s);
    if (!(t > 0)) return { rep: i + 1, observedFraction: null };
    return { rep: i + 1, observedFraction: t / t1 };
  });
}

// Model-predicted recovered fraction per rep using the user's
// three-component physModel. Forecasts what rep N's time SHOULD
// be given rep 1's time + the inter-rep rest interval, then
// converts to a fraction of rep 1.
//
// By construction predictedFraction at rep 1 is 1.0 (the seed).
// Returns [] when inputs are insufficient to run the model.
export function buildPredictedRecoverySeries({
  numReps, firstRepTime, restSeconds, physModel,
}) {
  if (!(numReps > 0) || !(firstRepTime > 0) || !(restSeconds >= 0)) return [];
  if (!physModel) return [];
  const predictedTimes = predictRepTimes({
    numReps, firstRepTime, restSeconds, physModel,
  });
  if (!Array.isArray(predictedTimes) || predictedTimes.length === 0) return [];
  const t1 = predictedTimes[0];
  if (!(t1 > 0)) return [];
  return predictedTimes.map((t, i) => ({
    rep: i + 1,
    predictedFraction: t / t1,
  }));
}

// Reference rep for the headline "gap" metric. Rep 2 is the first
// inter-rep recovery measurement and the most diagnostic — it
// answers "did the rest before rep 2 give me back what the model
// expected?" Later reps accumulate noise from multiple recovery
// intervals.
export const GAP_TARGET_REP = 2;

// Operating-zone thresholds. Used by the chart for the reference
// band, and reported here so coaching helpers can read off the
// same numbers without re-deriving them.
export const OPERATING_LOW  = 0.7;  // below = meaningfully degraded
export const OPERATING_HIGH = 0.9;  // above = rest interval has slack

// Classify the observed recovery at the target rep into a coaching
// bucket. Returns one of:
//   "well_calibrated" — within [LOW, HIGH], healthy operating zone
//   "under_rested"    — below LOW, rep is meaningfully degraded
//   "over_rested"     — above HIGH, rest interval has slack
//   null              — observed value missing
export function classifyRecovery(observedFraction) {
  if (observedFraction == null || !Number.isFinite(observedFraction)) return null;
  if (observedFraction < OPERATING_LOW) return "under_rested";
  if (observedFraction > OPERATING_HIGH) return "over_rested";
  return "well_calibrated";
}

// One-shot bundle for the chart. Given a session's reps + the
// personalized physModel, build both series + a headline gap
// metric in one call.
//
// Caller passes pre-filtered reps (single session, single hand).
// The function assumes constant load — see module header for the
// theoretical basis.
export function buildRecoveryBundle({ reps, restSeconds, physModel }) {
  if (!Array.isArray(reps) || reps.length === 0) {
    return { observed: [], predicted: [], gapAtTarget: null, observedAtTarget: null };
  }
  const sorted = [...reps].sort((a, b) => (a.rep_num ?? 0) - (b.rep_num ?? 0));
  const firstRepTime = Number(sorted[0]?.actual_time_s);
  const observed = buildObservedRecoverySeries(sorted);
  const predicted = (firstRepTime > 0 && restSeconds >= 0 && physModel)
    ? buildPredictedRecoverySeries({
        numReps: sorted.length, firstRepTime, restSeconds, physModel,
      })
    : [];
  const obsAtTarget = observed.find(p => p.rep === GAP_TARGET_REP)?.observedFraction ?? null;
  const predAtTarget = predicted.find(p => p.rep === GAP_TARGET_REP)?.predictedFraction ?? null;
  const gapAtTarget = (obsAtTarget != null && predAtTarget != null)
    ? obsAtTarget - predAtTarget
    : null;
  return {
    observed, predicted,
    gapAtTarget,
    observedAtTarget: obsAtTarget,
  };
}

// ─────────────────────────────────────────────────────────────
// Cross-session trend
// ─────────────────────────────────────────────────────────────
// Per-session observed recovered fraction at the target rep,
// aggregated across the history for trend rendering in AnalysisView.
// "Is my recovery improving over weeks/months?" — the question the
// per-session chart can't answer.
//
// Grouping: by (session_id || date) — falls back to date when
// session_id is missing on legacy rows. Per-hand averaging within a
// session (Both-mode sessions have both L and R; we average their
// observed fractions so one point per session per grip).

export function buildRecoveryTrend(history, grip) {
  if (!Array.isArray(history) || history.length === 0 || !grip) return [];

  // Group reps by (session_id, grip, hand).
  const groups = new Map();
  for (const r of history) {
    if (r.grip !== grip) continue;
    if (!(Number(r.actual_time_s) > 0)) continue;
    const sessKey = r.session_id || r.date;
    const handKey = r.hand || "L";
    const key = `${sessKey}|${handKey}`;
    if (!groups.has(key)) groups.set(key, { sessKey, date: r.date, hand: handKey, reps: [] });
    groups.get(key).reps.push(r);
  }
  if (groups.size === 0) return [];

  // For each (session, hand), compute observed fraction at target rep.
  // Average across hands within the same session for a single
  // per-session datapoint (avoids double-plotting Both-mode sessions).
  const bySession = new Map();
  for (const grp of groups.values()) {
    if (grp.reps.length < GAP_TARGET_REP) continue;
    const observed = buildObservedRecoverySeries(grp.reps);
    const v = observed.find(p => p.rep === GAP_TARGET_REP)?.observedFraction;
    if (v == null) continue;
    const entry = bySession.get(grp.sessKey) || { date: grp.date, values: [] };
    entry.values.push(v);
    entry.date = grp.date; // last write wins; dates should match within sessKey
    bySession.set(grp.sessKey, entry);
  }
  if (bySession.size === 0) return [];

  // Aggregate per-session: mean of L/R observed fractions, sorted by date ASC.
  return [...bySession.values()]
    .map(({ date, values }) => ({
      date,
      observedAtTarget: values.reduce((s, v) => s + v, 0) / values.length,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// Add a 3-session rolling mean column to a trend series so the
// chart can render dots (raw) + a smoothed trend line, same pattern
// CapacityTrajectoryCard uses. Returns a new array with the same
// length; the smoothed value at index i is the mean of indices
// [max(0, i-2)..i].
export function withRollingMean(trend, window = 3) {
  if (!Array.isArray(trend) || trend.length === 0) return [];
  return trend.map((row, i) => {
    const start = Math.max(0, i - (window - 1));
    const slice = trend.slice(start, i + 1).map(r => r.observedAtTarget).filter(Number.isFinite);
    const smoothed = slice.length > 0
      ? slice.reduce((s, v) => s + v, 0) / slice.length
      : null;
    return { ...row, observedSmoothed: smoothed };
  });
}

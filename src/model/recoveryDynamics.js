// ──────────────────────────────────────────────────────────────
// RECOVERY DYNAMICS — between-rep capacity restoration
// ──────────────────────────────────────────────────────────────
// The F-D model + RepCurveChart already show how force declines
// during a single rep. This module surfaces the OTHER side of the
// model: how repeated failure time changes between reps.
//
// At constant load (which the runner enforces post-commit 90), the
// directly observed quantity is rep-duration retention:
//
//     actual_time_s(N) / actual_time_s(1)
//
// Rep 1 is the baseline (always 1.0); subsequent reps land below
// depending on how well recovery keeps up with depletion. This ratio
// is NOT labeled a physiological capacity fraction: the model forecast
// now solves the nonlinear force-duration equation at constant load.
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
import { buildPhysModel } from "./repCurveData.js";

// Observed rep-duration-retention ratio, computed from a session's
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

// Model-predicted rep-duration-retention ratio using the user's
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

// Classify the observed recovery at the target rep. Purely
// descriptive of the depletion depth — the rest interval is fixed
// by the protocol, so we don't moralize about "under-rested." A
// deeply-depleted rep 2 means rep 1 was hard + 20s wasn't enough
// to refill; that's not a discipline issue, it's set shape.
// Returns one of:
//   "operating_zone"    — within [LOW, HIGH], typical training depth
//   "deep_depletion"    — below LOW, steep loss between reps
//   "shallow_depletion" — above HIGH, plenty of headroom in rest
//   null                — observed value missing
export function classifyRecovery(observedFraction) {
  if (observedFraction == null || !Number.isFinite(observedFraction)) return null;
  if (observedFraction < OPERATING_LOW) return "deep_depletion";
  if (observedFraction > OPERATING_HIGH) return "shallow_depletion";
  return "operating_zone";
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

// ──────────────────────────────────────────────────────────────
// Cross-session trend
// ──────────────────────────────────────────────────────────────
// Per-session metrics at the target rep, aggregated across the
// history for trend rendering in AnalysisView. "Is my recovery
// improving over weeks/months?" — the question the per-session
// chart can't answer.
//
// Two metrics per session:
//   observedAtTarget — raw rep2/rep1 ratio. Easy to read but
//     confounded by rep 1 time changes: as the user gets stronger
//     and lasts longer on rep 1, the same rest interval refills a
//     smaller fraction of the (now deeper) depletion. Observed
//     trends down even when the recovery side is unchanged.
//   gapAtTarget — observed minus model-predicted at rep 2. The
//     predicted fraction also drops as rep 1 lengthens, so the GAP
//     stays flat when recovery is actually unchanged. A negative,
//     widening gap is the real "recovery is degrading" signal.
//
// Grouping: by (session_id || date) — falls back to date when
// session_id is missing on legacy rows. Per-hand averaging within a
// session (Both-mode sessions have both L and R; we average their
// values so one point per session per grip).
//
// physModel is optional (back-compat). When supplied, gapAtTarget is
// populated using predictRepTimes seeded with each session's actual
// rep 1 time + rest_s. When omitted, gapAtTarget is null and only
// observedAtTarget is filled.

export function buildRecoveryTrend(history, grip, { physModel = null } = {}) {
  if (!Array.isArray(history) || history.length === 0 || !grip) return [];

  // Group reps by (session_id, grip, hand, set). set_num must be in
  // the key: rep_num restarts per set, so a multi-set session grouped
  // only by (session, hand) paired SOME set's rep 1 with SOME other
  // set's rep N (insertion-order dependent, not stable after cloud
  // sync re-orders rows) — corrupting the observed/predicted gap that
  // feeds the deload detector. Per-set gaps from the same session
  // still average into one datapoint via the bySession pass below.
  const groups = new Map();
  for (const r of history) {
    if (r.grip !== grip) continue;
    if (!(Number(r.actual_time_s) > 0)) continue;
    const sessKey = r.session_id || r.date;
    const handKey = r.hand || "L";
    const key = `${sessKey}|${handKey}|${r.set_num ?? 1}`;
    if (!groups.has(key)) groups.set(key, { sessKey, date: r.date, hand: handKey, reps: [] });
    groups.get(key).reps.push(r);
  }
  if (groups.size === 0) return [];

  // For each (session, hand), compute observed fraction at target rep
  // and (when physModel is supplied) the model-predicted fraction.
  // Average across hands within the same session for a single
  // per-session datapoint (avoids double-plotting Both-mode sessions).
  const bySession = new Map();
  for (const grp of groups.values()) {
    if (grp.reps.length < GAP_TARGET_REP) continue;
    const sorted = [...grp.reps].sort((a, b) => (a.rep_num ?? 0) - (b.rep_num ?? 0));
    const rep1 = sorted[0];
    const repTarget = sorted.find(r => r.rep_num === GAP_TARGET_REP) ?? sorted[GAP_TARGET_REP - 1];
    const t1 = Number(rep1?.actual_time_s);
    const tT = Number(repTarget?.actual_time_s);
    if (!(t1 > 0) || !(tT > 0)) continue;
    const observed = tT / t1;

    // Predicted fraction at the target rep, seeded with THIS session's
    // actual rep 1 time + rest. Falls back to 20s rest if rest_s is
    // missing on the rep row (same convention as HistoryView).
    let gap = null;
    if (physModel) {
      const rawRest = Number(rep1.rest_s);
      const rest = Number.isFinite(rawRest) && rawRest >= 0 ? rawRest : 20;
      const predTimes = predictRepTimes({
        numReps: GAP_TARGET_REP,
        firstRepTime: t1,
        restSeconds: rest,
        physModel,
      });
      if (Array.isArray(predTimes) && predTimes.length >= GAP_TARGET_REP && predTimes[0] > 0) {
        const predicted = predTimes[GAP_TARGET_REP - 1] / predTimes[0];
        gap = observed - predicted;
      }
    }

    const entry = bySession.get(grp.sessKey) || {
      date: grp.date, observedVals: [], gapVals: [],
    };
    entry.observedVals.push(observed);
    if (gap != null && Number.isFinite(gap)) entry.gapVals.push(gap);
    entry.date = grp.date; // last write wins; dates should match within sessKey
    bySession.set(grp.sessKey, entry);
  }
  if (bySession.size === 0) return [];

  // Aggregate per-session: mean of L/R values, sorted by date ASC.
  const mean = (vals) => vals.reduce((s, v) => s + v, 0) / vals.length;
  return [...bySession.values()]
    .map(({ date, observedVals, gapVals }) => ({
      date,
      observedAtTarget: observedVals.length > 0 ? mean(observedVals) : null,
      gapAtTarget: gapVals.length > 0 ? mean(gapVals) : null,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// Add 3-session rolling-mean columns to a trend series so the chart
// can render dots (raw) + smoothed trend lines, same pattern as
// CapacityTrajectoryCard. Smooths both observedAtTarget and
// gapAtTarget when present; emits null when a window has no finite
// values for a field.
export function withRollingMean(trend, window = 3) {
  if (!Array.isArray(trend) || trend.length === 0) return [];
  return trend.map((row, i) => {
    const start = Math.max(0, i - (window - 1));
    const slice = trend.slice(start, i + 1);
    const meanField = (field) => {
      const vals = slice.map(r => r[field]).filter(Number.isFinite);
      return vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
    };
    return {
      ...row,
      observedSmoothed: meanField("observedAtTarget"),
      gapSmoothed: meanField("gapAtTarget"),
    };
  });
}

// Threshold for the "matches model" band on the gap chart, and the
// per-grip trigger the deload detector reads off. A time-separated
// holdout of the July 2026 nonlinear constant-force solver on ~5 months
// of real sessions (see scripts/recovery-validation.md) put the
// session-to-session gap noise well above the old ±0.10: the 3-session
// smoothed gap has std ≈ 0.14 (Micro) to 0.24 (Crusher). The old ±0.10
// — tuned against the retired LINEAR predictor — was ~half the real
// noise, so most on-track sessions fell "outside" it and the deload
// trigger / recovery early-warn were needlessly twitchy. Widened to
// ±0.15 (≈ one smoothed-gap sigma for the better-behaved grip): a band
// the smoothed line mostly sits inside, and a deload/early-warn trigger
// that needs a real dip below the user's own baseline, not noise.
export const GAP_NOISE_BAND = 0.15;


// ──────────────────────────────────────────────────────────────
// COACHING SIGNALS — compact per-grip recovery read for coachNotes
// ──────────────────────────────────────────────────────────────
// The DeloadGauge consumes the same recovery gap but only CROSS-grip
// (it fires when EVERY grip is down), so it can't catch a single grip
// slipping and it never reassures. This distills, per grip, the two
// things the coaching layer needs: the recent smoothed model gap
// (percentage points — negative = recovering worse than predicted) and
// how far the smoothed recovery FRACTION has drifted over the last
// `window` points. Self-contained (builds its own per-grip physModel)
// so the caller just passes history.
export const RECOVERY_COACH_MIN_POINTS = 4;   // need this many recovery datapoints to speak up
export const RECOVERY_TREND_WINDOW     = 3;   // smoothed now vs this many points back

export function recoveryCoachSignals(history, {
  minPoints = RECOVERY_COACH_MIN_POINTS,
  window = RECOVERY_TREND_WINDOW,
} = {}) {
  if (!Array.isArray(history) || history.length === 0) return [];
  const grips = [...new Set(history.map(r => r && r.grip).filter(Boolean))];
  const out = [];
  for (const grip of grips) {
    // Seed the physModel with whichever hand actually has reps for this
    // grip; recovery taus are grip-level so the hand barely moves the gap.
    const hand = history.some(r => r.grip === grip && r.hand === "R" && Number(r.actual_time_s) > 0) ? "R" : "L";
    let physModel = null;
    try { physModel = buildPhysModel(history, hand, grip); } catch (e) { physModel = null; }
    const trend = withRollingMean(buildRecoveryTrend(history, grip, { physModel }), window);
    const recPts = trend.filter(r => Number.isFinite(r.observedSmoothed));
    if (recPts.length < minPoints) continue;
    const last  = recPts[recPts.length - 1];
    const prior = recPts[Math.max(0, recPts.length - 1 - window)];
    const recentGapPct = Number.isFinite(last.gapSmoothed) ? Math.round(last.gapSmoothed * 100) : null;
    const recoveryDeltaPct = (Number.isFinite(last.observedSmoothed) && Number.isFinite(prior.observedSmoothed))
      ? Math.round((last.observedSmoothed - prior.observedSmoothed) * 100)
      : null;
    out.push({ grip, recentGapPct, recoveryDeltaPct, nPoints: recPts.length });
  }
  return out;
}

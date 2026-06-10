// ─────────────────────────────────────────────────────────────
// REP-CURVE DATA HELPERS
// ─────────────────────────────────────────────────────────────
// Source-of-truth assembly for the four series rendered by the
// shared RepCurveChart component:
//
//   forecasted     — predicted hold time per rep under the user's
//                    personal recovery model
//   actual         — observed hold times from the session (live or
//                    historical)
//   prevSession    — last similar-zone session's actuals overlaid for
//                    "am I beating last time?"
//   asymptoticHold — convergent hold time after many reps at the
//                    same protocol; a single horizontal floor line
//
// Pure functions; no React, no Supabase. Tested in isolation.

import { predictRepTimes, getPhysModel } from "./fatigue.js";
import { computePersonalRecoveryTausForGrip } from "./recoveryFit.js";
import { zoneOf } from "./zones.js";

// How far out to run the recovery model to read the asymptote. With
// the default time constants the system converges within ~20-30 reps;
// 50 is safely past convergence without being expensive.
const ASYMPTOTE_REPS = 50;

// Build a physModel personalized to (grip, hand) when enough data
// exists, otherwise falls back to the population default. Pure
// wrapper around computePersonalRecoveryTausForGrip + getPhysModel.
export function buildPhysModel(history, hand, grip, opts = {}) {
  const base = getPhysModel(history, hand, grip, opts);
  const personal = grip ? computePersonalRecoveryTausForGrip(history, grip) : null;
  // computePersonalRecoveryTausForGrip returns flat {fast, medium,
  // slow, nSets} — there is no nested .tauR. The original guard here
  // checked `!personal.tauR`, which was always true, so every
  // forecast silently fell back to the population model and the
  // personal recovery fit never reached this surface. (deload.js
  // consumes the same return correctly: `personalTaus.get(grip)`.)
  if (!personal) return base;
  return {
    ...base,
    tauR: { fast: personal.fast, medium: personal.medium, slow: personal.slow },
  };
}

// Build the Forecasted series. Pass the same seed first-rep time the
// user actually held (or the target_duration if rep 1 hasn't landed
// yet). Returns an array of { rep, t } points indexed from rep 1.
export function buildForecastSeries({
  numReps, firstRepTime, restSeconds, physModel,
}) {
  if (!(numReps > 0) || !(firstRepTime > 0) || !(restSeconds >= 0)) return [];
  const times = predictRepTimes({
    numReps, firstRepTime, restSeconds, physModel,
  });
  return times.map((t, i) => ({ rep: i + 1, t }));
}

// Build the Actual series from a list of rep records sorted by
// (set_num, rep_num). Returns { rep, t } per rep. Caller filters
// to the session of interest before passing in.
export function buildActualSeries(reps) {
  if (!Array.isArray(reps) || reps.length === 0) return [];
  const sorted = [...reps].sort((a, b) => {
    const sa = a.set_num ?? 1, sb = b.set_num ?? 1;
    if (sa !== sb) return sa - sb;
    return (a.rep_num ?? 0) - (b.rep_num ?? 0);
  });
  return sorted
    .filter(r => Number(r.actual_time_s) > 0)
    .map((r, i) => ({ rep: i + 1, t: Number(r.actual_time_s) }));
}

// Find the most recent prior session for the same (grip, hand) that
// trained the same zone (bucketed by zoneOf(target_duration)). Returns
// the array of that session's reps, or null if no match exists.
//
// "Same zone" is the right grouping because absolute target_duration
// drifts session to session, but the zone bucket stays stable — so
// last week's 60s power session matches this week's 45s power session.
export function findPrevSessionReps(history, { grip, hand, beforeDate, targetDuration }) {
  if (!Array.isArray(history) || history.length === 0 || !grip) return null;
  const zone = zoneOf(targetDuration);
  if (!zone) return null;

  // Group history by session_id (or date as fallback), keeping only
  // sessions matching (grip, hand, zone) and dated strictly before
  // beforeDate. handMatch: 'B'/'Both' reps belong to neither L nor R
  // specifically — fall back to grip-only match.
  const byKey = new Map();
  for (const r of history) {
    if (r.grip !== grip) continue;
    if (hand && r.hand !== hand && r.hand !== "B") continue;
    if (zoneOf(r.target_duration) !== zone) continue;
    if (beforeDate && r.date >= beforeDate) continue;
    const key = r.session_id || r.date;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  if (byKey.size === 0) return null;

  // Most recent session by max(date) across its reps.
  let best = null;
  let bestDate = null;
  for (const reps of byKey.values()) {
    const d = reps.reduce((mx, r) => (r.date > mx ? r.date : mx), "");
    if (!bestDate || d > bestDate) {
      bestDate = d;
      best = reps;
    }
  }
  return best;
}

// Run the recovery model out to N=ASYMPTOTE_REPS and return the
// convergent hold time. That's the floor — the hold duration the
// user could (in theory) sustain forever at this protocol, given
// the fast/medium/slow recovery balance.
export function computeAsymptoticHold({ firstRepTime, restSeconds, physModel }) {
  if (!(firstRepTime > 0) || !(restSeconds >= 0)) return null;
  const times = predictRepTimes({
    numReps: ASYMPTOTE_REPS,
    firstRepTime, restSeconds, physModel,
  });
  // Take the mean of the last few reps to smooth any rounding noise
  // around the asymptote.
  const tail = times.slice(-3);
  return tail.reduce((s, x) => s + x, 0) / tail.length;
}

// One-shot bundle: given session params + history + the personalized
// physModel, build all four series in one call. Consumers pass the
// result straight to <RepCurveChart>.
//
// For an in-progress session, pass `actualReps` as the reps logged so
// far and `firstRepTime` as either rep 1's actual_time_s (if known) or
// the prescribed target_duration (before rep 1).
export function buildRepCurveBundle({
  history, grip, hand, numReps, firstRepTime, restSeconds,
  actualReps = [], targetDuration, beforeDate, physModel,
}) {
  const model = physModel || buildPhysModel(history, hand, grip);
  return {
    forecasted: buildForecastSeries({
      numReps, firstRepTime, restSeconds, physModel: model,
    }),
    actual: buildActualSeries(actualReps),
    prevSession: ((reps) => reps ? buildActualSeries(reps) : [])(
      findPrevSessionReps(history, { grip, hand, beforeDate, targetDuration })
    ),
    asymptoticHold: computeAsymptoticHold({
      firstRepTime, restSeconds, physModel: model,
    }),
    targetS: targetDuration,
  };
}

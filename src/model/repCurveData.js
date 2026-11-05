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
import { effectiveLoad } from "./load.js";
import { isValidFailureRep } from './forceRecording.js';

// A hold whose time can be compared with other holds. Load provenance does
// not matter here: a manual-load hold is timed as honestly as a measured one.
export function isComparableHold(rep) {
  const recording = rep?.force_recording;
  return isValidFailureRep(rep) && recording?.capacity_eligible !== false && Number(rep.actual_time_s) > 0
    && !['interrupted', 'equipment_interruption', 'target_not_reached'].includes(rep.end_reason)
    && !recording?.redo_pending && !recording?.redo_attempts?.length
    && recording?.recording_stop_reason !== 'release_not_observed';
}

function sessionStart(rep) {
  for (const value of [rep.session_started_at, rep.rep_timing?.started_at_ms, rep.created_at]) {
    const time = typeof value === 'number' ? value : Date.parse(value);
    if (Number.isFinite(time)) return time;
  }
  return null;
}

// How far out to run the recovery model to read the asymptote. With
// the default time constants the system converges within ~20-30 reps;
// 50 is safely past convergence without being expensive.
const ASYMPTOTE_REPS = 50;

// Build a physModel personalized to (grip, hand) when enough data
// exists, otherwise falls back to the population default. Pure
// wrapper around computePersonalRecoveryTausForGrip + getPhysModel.
export function buildPhysModel(history, hand, grip, opts = {}) {
  // Retain ordering/preceding work: filtering an invalid opener out could
  // promote its later rep into fresh evidence in downstream fitting.
  const evidence = (history || []).map(rep => isComparableHold(rep) ? rep : {
    ...rep, failure_valid: false,
    force_recording: {...rep.force_recording, capacity_eligible:false, recovery_eligible:false},
  });
  const base = getPhysModel(evidence, hand, grip, opts);
  const personal = grip ? computePersonalRecoveryTausForGrip(evidence, grip) : null;
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
// (set_num, rep_num). Returns { rep, t, weightKg, date } per rep so the
// chart can show the exact load × time actually performed and identify
// the previous comparable session. Caller filters to the session of
// interest before passing in.
export function buildActualSeries(reps) {
  if (!Array.isArray(reps) || reps.length === 0) return [];
  const sorted = [...reps].sort((a, b) => {
    const sa = a.set_num ?? 1, sb = b.set_num ?? 1;
    if (sa !== sb) return sa - sb;
    return (a.rep_num ?? 0) - (b.rep_num ?? 0);
  });
  return sorted
    .map((r, i) => ({
      rep: Number(r.rep_num) > 0 ? Number(r.rep_num) : i + 1,
      t: Number(r.actual_time_s) > 0 ? Number(r.actual_time_s) : null,
      weightKg: effectiveLoad(r) || null,
      date: r.date || null,
      ...(!isComparableHold(r) && Number(r.actual_time_s) > 0 ? {activityOnly:true} : {}),
    }));
}

// Find the most recent prior session for the same (grip, hand) that
// trained the same zone (bucketed by zoneOf(target_duration)). Returns
// the array of that session's reps, or null if no match exists.
//
// "Same zone" is the right grouping because absolute target_duration
// drifts session to session, but the zone bucket stays stable — so
// last week's 60s power session matches this week's 45s power session.
export function findPrevSessionReps(history, { grip, hand, beforeDate, targetDuration,
  setNum = 1, excludeSessionId = null }) {
  if (!Array.isArray(history) || history.length === 0 || !grip) return null;
  const zone = zoneOf(targetDuration);
  if (!zone) return null;

  // Group history by session_id (or date as fallback), keeping only
  // sessions matching (grip, hand, zone) and dated strictly before
  // beforeDate. handMatch: 'B'/'Both' reps belong to neither L nor R
  // specifically — fall back to grip-only match.
  const byKey = new Map();
  for (const r of history) {
    if (!isComparableHold(r)) continue;
    if (r.force_recording?.session_protocol?.id === 'whole_curve_beta') continue;
    // An optional/Volume second set is a separate fatigued sequence. Never
    // flatten it into the first set or substitute it for a fresh comparison.
    if (Number(r.set_num ?? 1) !== Number(setNum)) continue;
    if (excludeSessionId != null && r.session_id === excludeSessionId) continue;
    if (r.grip !== grip) continue;
    if (hand && r.hand !== hand && r.hand !== "B") continue;
    if (zoneOf(r.target_duration) !== zone) continue;
    if (beforeDate && r.date >= beforeDate) continue;
    const key = r.session_id || r.date;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  if (byKey.size === 0) return null;

  // Same-day sessions need measured/session timestamps, never input order.
  let best = null;
  let bestDate = null;
  let bestStart = null;
  let ambiguous = false;
  for (const reps of byKey.values()) {
    const d = reps.reduce((mx, r) => (r.date > mx ? r.date : mx), "");
    const starts = reps.map(sessionStart).filter(Number.isFinite);
    const start = starts.length ? Math.min(...starts) : null;
    if (!bestDate || d > bestDate || (d === bestDate && start != null && bestStart != null && start > bestStart)) {
      bestDate = d;
      bestStart = start;
      best = reps;
      ambiguous = false;
    } else if (d === bestDate && (start == null || bestStart == null || start === bestStart)) {
      ambiguous = true;
    }
  }
  return ambiguous ? null : best;
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
  actualReps = [], targetDuration, beforeDate, physModel, setNum = 1, excludeSessionId = null,
}) {
  const model = physModel || buildPhysModel(history, hand, grip);
  const opener = actualReps.find(rep => Number(rep.rep_num ?? 1) === 1);
  const seed = actualReps.length
    ? (isComparableHold(opener) ? opener.actual_time_s : null) : firstRepTime;
  return {
    forecasted: buildForecastSeries({
      numReps, firstRepTime:seed, restSeconds, physModel: model,
    }),
    actual: buildActualSeries(actualReps),
    prevSession: ((reps) => reps ? buildActualSeries(reps) : [])(
      findPrevSessionReps(history, { grip, hand, beforeDate, targetDuration, setNum, excludeSessionId })
    ),
    asymptoticHold: computeAsymptoticHold({
      firstRepTime:seed, restSeconds, physModel: model,
    }),
    targetS: targetDuration,
  };
}

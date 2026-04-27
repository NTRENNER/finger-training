// ─────────────────────────────────────────────────────────────
// WORKOUT PROGRESSION RECOMMENDER
// ─────────────────────────────────────────────────────────────
// Given the user's workout history and an exercise definition,
// returns a recommended { weight, reps, reasoning } for each set
// of the next session — so startSession can pre-fill the inputs
// with a sensible target instead of just copying the previous
// session's numbers verbatim.
//
// Two progression strategies:
//
//   1. Plate (single progression). Default for any exercise
//      WITHOUT an availableLoads list. After a clean session
//      (all target reps hit), bump weight by ~5%, snapping to a
//      2.5 lb increment. After a missed-reps session, hold the
//      weight and aim for the same target reps. Backs off only
//      on catastrophic misses (≤50% of target).
//
//   2. Double progression (rep-up). For exercises WITH an
//      availableLoads list — typically kettlebells with discrete
//      weight ladders (35, 50, 55, 62, 70 lbs etc.). Instead of
//      bumping the weight every time (which would mean +10–15%
//      per jump for KBs), we add a rep at the current weight
//      until reps reach the top of the range, then jump to the
//      next available load and reset reps to the target.
//
// Unilateral exercises run both strategies per side, because
// hands are often asymmetric.
//
// Pure JS, no React. The startSession path consumes this; the
// SessionExRow display can also call recommendSet to render the
// "↑ +5 lbs (clean session)" hint underneath each input.

import { isBodyweightAdditive, parseRepsCount } from "./workout-volume.js";

// Parse a reps string like "5", "8", "8–12", "8-12", "6/side" into
// { targetReps, topReps }. targetReps is the lower bound (or only
// number); topReps is the upper bound — explicit if a range was
// given, otherwise computed as round(targetReps × 1.6) so we have
// room for double-progression on KB exercises whose template only
// names a single rep target.
//
// "/side" suffixes have already been stripped from current
// DEFAULT_WORKOUTS entries (the unilateral schema replaces them);
// parseRepsCount handles any legacy strings that still carry one.
export function parseRepRange(repsStr) {
  if (!repsStr) return { targetReps: 0, topReps: 0 };
  const s = String(repsStr);
  // Match "8–12" or "8-12" with either dash. The first number is the
  // target/lower bound, the second is the top of the range.
  const m = s.match(/^(\d+)\s*[–-]\s*(\d+)/);
  if (m) {
    const lo = parseInt(m[1], 10);
    const hi = parseInt(m[2], 10);
    if (isFinite(lo) && isFinite(hi) && lo > 0 && hi >= lo) {
      return { targetReps: lo, topReps: hi };
    }
  }
  const target = parseRepsCount(s);
  if (target <= 0) return { targetReps: 0, topReps: 0 };
  // Default top = target × 1.6 (e.g., target=5 → top=8; target=8 → top=13).
  // Wide enough that you spend a few sessions repping up before
  // jumping to the next KB; tight enough that the rep-up phase
  // doesn't turn into endless conditioning work.
  return { targetReps: target, topReps: Math.round(target * 1.6) };
}

// Round a weight to the nearest 2.5 lb increment, with a floor on
// the bump size so a 1% calculation still nudges by something
// usable. Used for plate exercises where the user has 2.5 / 5 lb
// plates available.
function roundToPlateIncrement(weight) {
  return Math.round(weight / 2.5) * 2.5;
}

// Pick the next-larger available load from a sorted ladder, or null
// if already at the top. availableLoads is an array of numbers (in
// display unit, since per-set weights are stored in display unit).
function nextAvailableLoad(currentWeight, availableLoads) {
  if (!Array.isArray(availableLoads) || availableLoads.length === 0) return null;
  const sorted = [...availableLoads].sort((a, b) => a - b);
  for (const load of sorted) {
    if (load > currentWeight + 0.001) return load; // small epsilon for fp safety
  }
  return null; // already at top
}

// Recommend a single side's load + reps based on what was done last
// time at this set index. Returns { weight, reps, reasoning } where
// reasoning is a short human-readable string ("↑ +5 lbs (clean)" /
// "= hold (missed reps)" / "→ next KB · 35 → 50, reset reps") that
// the UI surfaces under the input so the user understands the
// suggestion.
function recommendSide(prev, exDef, repRange) {
  const { targetReps, topReps } = repRange;
  const usesAvailableLoads = Array.isArray(exDef?.availableLoads) && exDef.availableLoads.length > 0;

  // No prior data — use the template's target reps and let the
  // user fill in the weight (they know their own equipment best
  // for the very first session).
  if (!prev || (!prev.weight && !prev.reps)) {
    return {
      weight: prev?.weight ?? "",
      reps:   String(targetReps || exDef?.reps || ""),
      reasoning: "",
    };
  }

  const prevWeight = parseFloat(prev.weight);
  const prevReps   = parseRepsCount(prev.reps);
  const prevDone   = !!prev.done;
  const hasWeight  = isFinite(prevWeight) && prevWeight > 0;
  const hasReps    = prevReps > 0;
  const hitTarget  = hasReps && targetReps > 0 && prevReps >= targetReps;
  const cleanLast  = prevDone && hitTarget;
  const badMiss    = prevDone && hasReps && targetReps > 0 && prevReps <= targetReps * 0.5;

  // Strategy 1: KB-style double progression — rep up at the
  // current weight, jump to the next load when at top of range.
  if (usesAvailableLoads && hasWeight) {
    if (cleanLast && prevReps >= topReps) {
      const nextLoad = nextAvailableLoad(prevWeight, exDef.availableLoads);
      if (nextLoad != null) {
        return {
          weight: String(nextLoad),
          reps:   String(targetReps),
          reasoning: `→ next KB · ${prevWeight} → ${nextLoad}, reset reps`,
        };
      }
      // Already at top KB AND top of rep range — stay flat,
      // there's nowhere higher to go without different equipment.
      return {
        weight: String(prevWeight),
        reps:   String(prevReps),
        reasoning: "= hold (top KB, top reps)",
      };
    }
    if (cleanLast) {
      return {
        weight: String(prevWeight),
        reps:   String(prevReps + 1),
        reasoning: `↑ +1 rep (rep-up at ${prevWeight} lbs)`,
      };
    }
    // Missed reps last time at the current KB — try to hit the
    // same target before progressing further.
    return {
      weight: String(prevWeight),
      reps:   String(targetReps || prevReps),
      reasoning: hasReps ? `= hold (missed ${targetReps - prevReps} rep${targetReps - prevReps !== 1 ? "s" : ""})` : "= hold (incomplete)",
    };
  }

  // Strategy 2: Plate single progression — bump weight ~5% on
  // a clean session, snap to 2.5 lb increments. Ensure at least
  // a 2.5 lb bump so the recommendation actually moves.
  if (hasWeight) {
    if (cleanLast) {
      const raw = prevWeight * 1.05;
      const bumped = roundToPlateIncrement(Math.max(raw, prevWeight + 2.5));
      return {
        weight: String(bumped),
        reps:   String(targetReps || prevReps),
        reasoning: `↑ +${(bumped - prevWeight).toFixed(1).replace(/\.0$/, "")} lbs (clean last session)`,
      };
    }
    if (badMiss) {
      const raw = prevWeight * 0.92;
      const dropped = roundToPlateIncrement(Math.max(raw, prevWeight - 5));
      return {
        weight: String(dropped),
        reps:   String(targetReps || prevReps),
        reasoning: `↓ -${(prevWeight - dropped).toFixed(1).replace(/\.0$/, "")} lbs (back off, missed badly)`,
      };
    }
    // Mild miss — hold the weight, retry the target.
    return {
      weight: String(prevWeight),
      reps:   String(targetReps || prevReps),
      reasoning: hasReps && targetReps > prevReps
        ? `= hold (missed ${targetReps - prevReps} rep${targetReps - prevReps !== 1 ? "s" : ""})`
        : "= hold",
    };
  }

  // Bodyweight-only or no-weight exercise — just suggest the rep
  // target and let the user log what they actually did.
  return {
    weight: String(prev.weight ?? ""),
    reps:   String(prev.reps ?? targetReps ?? ""),
    reasoning: "",
  };
}

// Find the most recent USABLE session matching the given predicate.
// Sorts candidates by date DESC (then completedAt DESC as tiebreaker)
// rather than walking the array backward, because the array's
// insertion order can drift from chronological order — a tombstone
// reconcile, an out-of-order cloud sync, or a manual edit can leave
// an older session sitting at a higher index than a newer one. Picking
// by array position let those older sessions shadow newer ones (e.g.,
// an empty-weight 04-16 dips entry was returned instead of a clean
// 04-21 dips entry, leaving the recommender with no weight to work with).
//
// "Usable" still means at least one set was marked done. Non-empty
// weight/reps alone aren't enough because startSession pre-fills both
// from the recommendation — an aborted session looks just like a
// partially-typed real one and would otherwise shadow real prior data.
function findLastSessionWhere(history, exId, predicate) {
  const candidates = [];
  for (const s of history) {
    if (!predicate(s)) continue;
    const sets = s?.exercises?.[exId]?.sets;
    if (!Array.isArray(sets) || sets.length === 0) continue;
    if (!sets.some(set => !!(set && set.done))) continue;
    candidates.push(s);
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const ad = a?.date || "";
    const bd = b?.date || "";
    if (ad !== bd) return bd.localeCompare(ad); // newer date first
    const ac = a?.completedAt || "";
    const bc = b?.completedAt || "";
    return bc.localeCompare(ac); // newer completion first
  });
  return candidates[0];
}

// Find the most recent usable session for `exId`. Two-pass:
//   1. Prefer a session whose `workout` key matches the active one
//      (so Workout B's curls history isn't crowded out by Workout A's).
//   2. Fall back to ANY workout that contains the exercise — useful
//      for shared lifts like curls that the user does in multiple
//      workouts but logs more often in one of them. Without this
//      fallback, a sparse exercise in a freshly-rotated workout sees
//      no prev/recommendation even though the user has clearly been
//      doing it elsewhere.
// The caller can compare the returned session's `workout` to the
// requested key to detect a cross-workout fallback (we surface this
// via a "[from <workout>]" hint prepended to the reasoning string).
function findLastSession(history, workoutKey, exId) {
  if (!Array.isArray(history)) return null;
  const sameWorkout = findLastSessionWhere(history, exId, s => s?.workout === workoutKey);
  if (sameWorkout) return sameWorkout;
  return findLastSessionWhere(history, exId, s => !!s);
}

// Public API: recommend a single set's pre-fill given history,
// the exercise definition, the active workout key, and which set
// index we're computing for. Returns either a bilateral
// { weight, reps, reasoning } or a unilateral
// { leftWeight, leftReps, leftReasoning, rightWeight, rightReps, rightReasoning }
// shape based on exDef.unilateral. Either shape is consumed
// directly by the UI's input pre-fill + reasoning annotation.
//
// `bw` is the user's bodyweight at the (intended) session date in
// display units — used to resolve effective load on bodyweight-
// additive exercises. Currently only fed to the bodyweight-additive
// detector for conditional reasoning text; the recommender does
// NOT add bodyweight to the recorded weight (the user types added
// weight, the volume math folds bodyweight in separately).
export function recommendSet(history, exDef, workoutKey, setIdx, bw = null) {
  const repRange = parseRepRange(exDef?.reps);
  const lastSession = findLastSession(history, workoutKey, exDef.id);
  const lastSet = lastSession?.exercises?.[exDef.id]?.sets?.[setIdx];

  // If we fell back across workouts, prepend a small hint to the
  // reasoning so the user understands why the suggestion exists when
  // the current workout has no history for this exercise.
  const fromOtherWorkout = lastSession && lastSession.workout && lastSession.workout !== workoutKey
    ? lastSession.workout
    : null;
  const decorate = (rec) => {
    if (!fromOtherWorkout) return rec;
    const hint = `[from ${fromOtherWorkout}]`;
    const r = rec?.reasoning;
    return { ...rec, reasoning: r ? `${hint} ${r}` : hint };
  };

  if (exDef?.unilateral) {
    // Per-side history: prefer L/R fields if the prior session was
    // unilateral, fall back to the bilateral weight/reps fields
    // mirrored to both sides for legacy data.
    const leftPrev = lastSet ? {
      weight: lastSet.leftWeight ?? lastSet.weight ?? "",
      reps:   lastSet.leftReps   ?? lastSet.reps   ?? "",
      done:   !!lastSet.done,
    } : null;
    const rightPrev = lastSet ? {
      weight: lastSet.rightWeight ?? lastSet.weight ?? "",
      reps:   lastSet.rightReps   ?? lastSet.reps   ?? "",
      done:   !!lastSet.done,
    } : null;
    const left  = decorate(recommendSide(leftPrev,  exDef, repRange));
    const right = decorate(recommendSide(rightPrev, exDef, repRange));
    return {
      leftWeight:    left.weight,
      leftReps:      left.reps,
      leftReasoning: left.reasoning,
      rightWeight:    right.weight,
      rightReps:      right.reps,
      rightReasoning: right.reasoning,
    };
  }

  const prev = lastSet ? {
    weight: lastSet.weight ?? lastSet.leftWeight ?? "",
    reps:   lastSet.reps   ?? lastSet.leftReps   ?? "",
    done:   !!lastSet.done,
  } : null;
  // Inform the bodyweight-additive check via the exDef so it can
  // shape future reasoning text (kept for parity even though the
  // current logic doesn't branch on it).
  void isBodyweightAdditive(exDef);
  void bw;
  return decorate(recommendSide(prev, exDef, repRange));
}

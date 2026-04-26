// ─────────────────────────────────────────────────────────────
// WORKOUT VOLUME + 1RM ESTIMATION
// ─────────────────────────────────────────────────────────────
// Per-exercise tonnage (volume = reps × weight summed across sets)
// and Epley-formula estimated 1RM. Used by WorkoutHistoryView to
// show "you did X today vs Y last time" annotations and (later)
// by the workout coaching layer to suggest next-session targets.
//
// Bodyweight-additive exercises (pull-ups, dips) record only the
// ADDED weight; the true load per rep is bodyweight + added. Pass
// the user's bodyweight at the session date and the helpers fold
// it in. For non-additive exercises (overhead press with a KB,
// bench press, etc.) the recorded weight IS the load.
//
// Pure JS, no React. Storage convention here matches what
// WorkoutHistoryView reads: per-set `weight` is a number in DISPLAY
// units (lbs or kg as the user types it), `reps` is a string that
// usually parses to a number but may carry suffixes like "/side".

// Identify a bodyweight-additive exercise. Explicit flag on the
// exercise definition wins; otherwise fall back to a name-based
// heuristic for the obvious cases. The heuristic isn't exhaustive
// — custom exercises with unusual names will need the explicit
// flag in DEFAULT_WORKOUTS — but the false-positive rate on the
// listed substrings is essentially zero in a strength context.
export function isBodyweightAdditive(exDef) {
  if (exDef && exDef.bodyweightAdditive === true) return true;
  if (exDef && exDef.bodyweightAdditive === false) return false;
  const name = (exDef?.name || "").toLowerCase();
  return /\bpull[- ]?ups?\b|\bchin[- ]?ups?\b|\bmuscle[- ]?ups?\b|\bdips?\b|\bweighted dip|\bweighted pull/i.test(name);
}

// Parse a reps string like "5", "5/side", "8–10", "12" into a single
// integer count. Conventions:
//   * leading number wins ("8–10" → 8 — under-counts, but a safe
//     under-count is better than over-counting volume),
//   * "/side" or "/each" doubles ("5/side" → 10),
//   * unparseable / empty → 0.
export function parseRepsCount(repsStr) {
  if (repsStr == null) return 0;
  const s = String(repsStr);
  const n = parseFloat(s);
  if (!isFinite(n) || n <= 0) return 0;
  if (/\/(side|each)\b/i.test(s)) return Math.round(n * 2);
  return Math.round(n);
}

// Effective per-rep load: weight as recorded, plus bodyweight if the
// exercise is bodyweight-additive. Bodyweight is in display units
// (already converted by the caller). Returns 0 if both are 0/missing.
function effectiveLoad(weight, bw, additive) {
  const w = parseFloat(weight);
  const bwN = parseFloat(bw);
  const safeW = isFinite(w) && w > 0 ? w : 0;
  const safeBw = additive && isFinite(bwN) && bwN > 0 ? bwN : 0;
  return safeW + safeBw;
}

// Sum of (reps × effective_load) across all DONE sets. Skips any
// set marked done=false — those are sets the user planned but
// didn't complete, and including them would inflate "what I
// actually did". Returns 0 when nothing usable.
//
// `bw` should be the user's bodyweight at the session date (display
// units), not the current one — bodyweight changes meaningfully
// across training cycles and we want apples-to-apples comparisons.
export function sessionExerciseVolume(sets, bw, exDef) {
  if (!Array.isArray(sets) || sets.length === 0) return 0;
  const additive = isBodyweightAdditive(exDef);
  let total = 0;
  for (const s of sets) {
    if (!s || !s.done) continue;
    const reps = parseRepsCount(s.reps);
    if (reps <= 0) continue;
    const load = effectiveLoad(s.weight, bw, additive);
    if (load <= 0) continue;
    total += reps * load;
  }
  return Math.round(total);
}

// Epley estimated 1RM: weight × (1 + reps/30). Computed per done
// set; the session's est. 1RM is the MAX across sets (any single
// hard set sets the ceiling — averaging would understate). Returns
// 0 when no usable data.
//
// Same bodyweight handling as sessionExerciseVolume — additive
// exercises use bw + added.
export function sessionExerciseEst1RM(sets, bw, exDef) {
  if (!Array.isArray(sets) || sets.length === 0) return 0;
  const additive = isBodyweightAdditive(exDef);
  let best = 0;
  for (const s of sets) {
    if (!s || !s.done) continue;
    const reps = parseRepsCount(s.reps);
    if (reps <= 0) continue;
    const load = effectiveLoad(s.weight, bw, additive);
    if (load <= 0) continue;
    const est = load * (1 + reps / 30);
    if (est > best) best = est;
  }
  return Math.round(best * 10) / 10;
}

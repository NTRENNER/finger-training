// ─────────────────────────────────────────────────────────────
// WORKOUT TAB — pure-data helpers
// ─────────────────────────────────────────────────────────────
// Extracted from WorkoutTab.js (late May 2026) as part of the #228
// decomposition pass. These are pure data transforms — no React, no
// DOM, no module-level side effects — used internally by WorkoutTab
// and the row components in src/views/workout/. Kept colocated with
// the workout view rather than promoted to src/model/ because they
// describe the workout log's display shape (set summary strings,
// session counting rules) rather than training-physiology math.
//
// Three helpers live here:
//   • countSupportSessions — cumulative session index for save time
//   • setSummary           — "prev" column value for SessionExRow
//   • findLastSessionFor   — wLog walker for band-mode seeding

import { ROTATION_PIN_KEY } from "../../lib/storage.js";

// Count non-pin sessions in the log. Used to assign sessionNumber
// on save. Counts both legacy and new sessions — sessionNumber is
// a simple cumulative index, schema-agnostic.
export function countSupportSessions(wLog) {
  return (wLog || []).filter(s => s && s.workout !== ROTATION_PIN_KEY).length;
}

// Reduce a stored set object into a compact "prev" display value for
// SessionExRow's prev column. Three shapes:
//   - weight: { reps, weight, done } (or unilateral { leftReps, ... })
//     → returns a string like "5@80" or { L: "5@80", R: "5@80" }.
//   - band:   { reps, band } / { leftReps, leftBand, ... } where band
//     is an array of color keys (or, for older sessions, a single
//     string)
//     → returns { bands: [...], reps } so the prev pill can render
//     a swatch stack.
//   - circles-only: { done } → returns "✓" if done else "".
export function setSummary(set) {
  if (set == null) return null;
  const toBandShape = (bands, reps) => {
    const arr = Array.isArray(bands) ? bands : (bands ? [bands] : []);
    if (arr.length === 0 && (reps == null || reps === "")) return "";
    return { bands: arr, reps };
  };
  // Unilateral with band
  if (set.leftBand !== undefined || set.rightBand !== undefined) {
    return {
      L: toBandShape(set.leftBand,  set.leftReps),
      R: toBandShape(set.rightBand, set.rightReps),
    };
  }
  // Unilateral with weight
  if (set.leftReps != null || set.leftWeight != null) {
    const fmt = (r, w) => {
      if ((r == null || r === "") && (w == null || w === "")) return "";
      return `${r ?? ""}${r && w ? "@" : ""}${w ?? ""}`;
    };
    return {
      L: fmt(set.leftReps, set.leftWeight),
      R: fmt(set.rightReps, set.rightWeight),
    };
  }
  // Bilateral with band
  if (set.band !== undefined) {
    return toBandShape(set.band, set.reps);
  }
  // Bilateral with weight
  if (set.reps !== undefined || set.weight !== undefined) {
    const r = set.reps, w = set.weight;
    if ((r == null || r === "") && (w == null || w === "")) return "";
    return `${r ?? ""}${r && w ? "@" : ""}${w ?? ""}`;
  }
  // Circles-only — return a checkmark when done.
  return set.done ? "✓" : "";
}

// The same exercise can appear in different workouts. Seed only performed
// sets from its latest chronological session; skipped prefilled bands, variants,
// and weights are not evidence of work. Do not mutate the saved history.
export function findLastSessionFor(wLog, workoutId, exId) {
  const s = (wLog || []).filter(s => s && s.workout !== ROTATION_PIN_KEY
    && s.exercises?.[exId]?.sets?.some(t => t.done)).slice()
    .sort((a,b) => (b.date || '').localeCompare(a.date || '')
      || (b.completedAt || '').localeCompare(a.completedAt || ''))[0];
  if (!s) return null;
  return { ...s, exercises: { ...s.exercises, [exId]: { ...s.exercises[exId],
    sets: s.exercises[exId].sets.filter(t => t.done) } } };
}

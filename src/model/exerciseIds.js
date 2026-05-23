// ─────────────────────────────────────────────────────────────
// EXERCISE ID MIGRATION MAP
// ─────────────────────────────────────────────────────────────
// Old snake_case ids → current ids (mostly camelCase, in line with
// the supportTraining.js definitions). Sessions in the user's
// workout log are stored under whichever id the active plan used at
// log time, so old sessions carry old ids. This map lets every
// rendering surface — Lifts analysis chart, workout history rows,
// CSV exports — resolve a logged id to the canonical current id so
// names display consistently and one exercise renders as ONE thing
// instead of splitting "old name" vs "new name" cards.
//
// Audit when adding entries: an exercise belongs here ONLY if the
// legacy and current ids refer to the same physical movement (same
// muscle action, same loading pattern). Don't bridge cosmetically-
// similar exercises (e.g. step_up → splitSquat) — those are real
// re-prescriptions and their histories should stay separate.
//
// Single source of truth: every surface imports migrateExerciseId
// from this file. Don't duplicate the map elsewhere — three copies
// is a future-rename trap.

export const ID_MIGRATIONS = {
  // Legacy snake_case → current snake_case. The current ids here have
  // no camelCase equivalent in supportTraining.js, but the renamed
  // legacy id is what current data uses.
  ohp: "kb_press",

  // Legacy snake_case → current camelCase. These exercises have a
  // current supportTraining definition with the same physical movement
  // but the new id casing. Without migration, the user sees two cards
  // — one with old data, one with new — for the same exercise.
  pull_ups:     "weightedPullup",
  bench_press:  "benchPress",
  bicep_curls:  "bicepCurls",
  hammer_curls: "bicepCurls",     // even-older legacy, chained through
  slam_balls:   "medBallThrows",
  kb_snatch:    "kbSnatch",
};

// Resolve a logged exercise id to its canonical current id. Returns
// the input unchanged if no migration applies, so safe to call on
// every id whether or not it's an old one.
export function migrateExerciseId(id) {
  if (!id) return id;
  return ID_MIGRATIONS[id] || id;
}

// Build a flat { id → exDef } map from a workout plan, applying id
// migration so a legacy `kb_snatch` exercise lands at the same key
// as the current `kbSnatch`. Last definition wins so when a current
// supportTraining def collides with a legacy one (post-migration),
// the current name and metadata take precedence. Caller is
// responsible for the iteration order of `plan` — for
// ALL_WORKOUTS_LOOKUP that's legacy first, then current, which is
// exactly what we want here.
export function buildExerciseDefIndex(plan) {
  const index = {};
  for (const wk of Object.values(plan || {})) {
    for (const ex of (wk?.exercises || [])) {
      if (!ex?.id) continue;
      index[migrateExerciseId(ex.id)] = ex;
    }
  }
  return index;
}

// Resolve a (possibly legacy) exercise id to its display name via a
// pre-built exDef index. Falls back to a snake-to-space rendering of
// the id when no def is found, so brand-new ids the plan doesn't
// know about (custom exercises, future schemas) still render
// readably instead of as a raw key.
export function exerciseName(exId, exDefIndex) {
  if (!exId) return "";
  const def = exDefIndex?.[migrateExerciseId(exId)];
  return def?.name || exId.replace(/_/g, " ");
}

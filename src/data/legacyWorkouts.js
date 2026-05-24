// ─────────────────────────────────────────────────────────────
// LEGACY WORKOUT TEMPLATES + lookup dictionary
// ─────────────────────────────────────────────────────────────
// Workout templates from the pre-2026 schema, kept ONLY so
// historical sessions logged under those keys still resolve
// their exercise names in History / WorkoutHistory /
// WorkoutAnalysis surfaces. The current Workout tab does NOT
// consume any of this — it uses the workouts map from
// src/model/supportTraining.js.
//
// Don't add new templates here. New templates go in
// src/model/supportTraining.js.
//
// Lives in src/data/ rather than src/views/workout/ because it's
// pure data, not a view component (move late May 2026; was previously
// in src/views/workout/workoutLegacy.js). Anyone — view, hook, model
// helper — can import it directly without conceptually crossing into
// "the workout view's internals."

import { workouts as SUPPORT_WORKOUTS } from "../model/supportTraining.js";

export const LEGACY_WORKOUTS = {
  A: {
    name: "Lift Day 1 (Push + Pull)",
    exercises: [
      { id: "pull_ups",      name: "Weighted pull-ups",     type: "S", sets: 2,    reps: "5",      logWeight: true,  bodyweightAdditive: true, note: "Add weight when all reps clean" },
      { id: "landmine_rows", name: "One-arm landmine rows", type: "S", sets: 2,    reps: "5",      logWeight: true,  unilateral: true, note: "Alternate sides" },
      { id: "bench_press",   name: "Bench press",           type: "S", sets: 2,    reps: "5",      logWeight: true,  note: "" },
      { id: "dips",          name: "Dips",                  type: "S", sets: 2,    reps: "5",      logWeight: true,  bodyweightAdditive: true, note: "Weighted when bodyweight is easy" },
      { id: "bicep_curls",   name: "Bicep curls",           type: "S", sets: 2,    reps: "8",      logWeight: true,  unilateral: true, availableLoads: [20, 25, 40], note: "Undercling strength — rep up at current DB, jump when at top" },
      { id: "rdl",           name: "RDL",                   type: "S", sets: 2,    reps: "3–5",    logWeight: true,  note: "Heavy — load in lengthened position" },
      { id: "trx_ham_curl",  name: "TRX hamstring curl",    type: "S", sets: 2,    reps: "6–8",    logWeight: false, note: "Slow eccentric; single-leg when ready" },
      { id: "goblet_squat",  name: "Goblet squat",          type: "S", sets: 1,    reps: "8",      logWeight: true,  note: "Joint health — keep load moderate" },
      { id: "stretch",       name: "Stretching",            type: "X", sets: null, reps: null,     logWeight: false, note: "Couch · Splits machine · Hamstring lockout · Forearms · Lat" },
    ],
  },
  B: {
    name: "Lift Day 2 (Push + Pull)",
    exercises: [
      { id: "pull_ups",      name: "Weighted pull-ups",     type: "S", sets: 2,    reps: "5",      logWeight: true,  bodyweightAdditive: true, note: "Add weight when all reps clean" },
      { id: "landmine_rows", name: "One-arm landmine rows", type: "S", sets: 2,    reps: "5",      logWeight: true,  unilateral: true, note: "Alternate sides" },
      { id: "kb_press",      name: "KB press",              type: "S", sets: 2,    reps: "5",      logWeight: true,  unilateral: true, availableLoads: [35, 50, 55, 62, 70], note: "Single-arm — alternating sides" },
      { id: "dips",          name: "Dips",                  type: "S", sets: 2,    reps: "5",      logWeight: true,  bodyweightAdditive: true, note: "Weighted when bodyweight is easy" },
      { id: "bicep_curls",   name: "Bicep curls",           type: "S", sets: 2,    reps: "8",      logWeight: true,  unilateral: true, availableLoads: [20, 25, 40], note: "Undercling strength — rep up at current DB, jump when at top" },
      { id: "rdl",           name: "RDL",                   type: "S", sets: 2,    reps: "3–5",    logWeight: true,  note: "Heavy — load in lengthened position" },
      { id: "trx_ham_curl",  name: "TRX hamstring curl",    type: "S", sets: 2,    reps: "6–8",    logWeight: false, note: "Slow eccentric; single-leg when ready" },
      { id: "step_up",       name: "Step-up",               type: "S", sets: 1,    reps: "6–8",    logWeight: true,  unilateral: true, note: "Climbing & hiking strength — load when bodyweight easy" },
      { id: "stretch",       name: "Stretching",            type: "X", sets: null, reps: null,     logWeight: false, note: "Couch · Splits machine · Hamstring lockout · Forearms · Lat" },
    ],
  },
  C: {
    name: "Power",
    exercises: [
      { id: "slam_balls",  name: "Slam balls", type: "P", sets: 2,    reps: "8–10",   logWeight: true,  note: "Advance weight when 10 reps hold full speed" },
      { id: "kb_snatch",   name: "KB snatch",  type: "P", sets: 2,    reps: "5",      logWeight: true,  unilateral: true, note: "Full hip snap, crisp catch" },
      { id: "stretch",     name: "Stretching", type: "X", sets: null, reps: null,     logWeight: false, note: "Couch · Splits machine · Hamstring lockout · Forearms · Lat" },
    ],
  },
};

// Back-compat alias — App.js + History views still import
// DEFAULT_WORKOUTS by name. Don't rename without sweeping consumers.
export const DEFAULT_WORKOUTS = LEGACY_WORKOUTS;

// Merged dictionary of legacy + current workouts, with legacy keys
// prefixed `legacy_` to avoid collision with the current
// A / B / C / STRETCH keys. Used by HistoryView / WorkoutHistoryView /
// WorkoutAnalysisView to resolve exercise names regardless of
// which schema a session was logged under.
//
// Consumers that need to render a "current workouts" picker (e.g.
// the reclassify dropdown on a History session edit) should filter
// to non-legacy keys via `key => !key.startsWith("legacy_")`.
export const ALL_WORKOUTS_LOOKUP = {
  ...Object.fromEntries(
    Object.entries(LEGACY_WORKOUTS).map(([k, v]) => [`legacy_${k}`, v])
  ),
  ...SUPPORT_WORKOUTS,
};

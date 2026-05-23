// ─────────────────────────────────────────────────────────────
// LOCALSTORAGE HELPERS
// ─────────────────────────────────────────────────────────────
// Thin JSON wrappers around the localStorage API. Returns null when
// reads fail (key missing, quota exceeded, parse error) so callers can
// safely use `loadLS(key) || defaultValue`. Writes silently no-op when
// localStorage is unavailable (private browsing modes, quota full).
//
// The LS_*_KEY constants exported here are the storage keys the
// extracted view modules consume. Other LS keys consumed only by App.js
// remain inlined there until those views are extracted too.

export function loadLS(key) {
  try {
    const r = localStorage.getItem(key);
    return r ? JSON.parse(r) : null;
  } catch {
    return null;
  }
}

export function saveLS(key, v) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // Storage unavailable (quota, private mode) — silently drop.
  }
}

// Canonical client-side rep array. Owned by useRepHistory; the
// pullFromCloud action in App.js also reads it during the
// "reconcile local-only reps before overwriting" pre-flight.
export const LS_HISTORY_KEY = "ft_v3";

// Body-weight log: [{ date: "YYYY-MM-DD", kg: number }]
export const LS_BW_LOG_KEY = "ft_bw_log";

// Strength-workout log: [{ id, date, workout, exercises: { [id]: { sets: [...] } } }]
//
// Special entries with `workout === ROTATION_PIN_KEY` are NOT real
// workouts — they're synced markers used by WorkoutTab to set the
// next-up rotation manually (recovery valve when devices drift or
// the user wants to restart a cycle). Every consumer that displays
// or aggregates the log should filter these out; only WorkoutTab's
// rotation-derivation useMemo cares about them.
export const LS_WORKOUT_LOG_KEY = "ft_workout_log";

// Marker workout name for rotation-override entries (see comment
// above). Kept in storage.js so WorkoutTab, WorkoutHistoryView,
// TrendsView, and the CSV export can all import the same constant.
export const ROTATION_PIN_KEY = "__rotation_pin";

// Set<id> of workout sessions confirmed in Supabase. Used to render
// the cloud/local sync badge in WorkoutHistoryView.
export const LS_WORKOUT_SYNCED_KEY = "ft_workout_synced";

// Set<id> of workout-session tombstones. Once a session id is in
// here, the merge-from-Supabase pass never re-adds it, so deletes
// stick across sync cycles.
export const LS_WORKOUT_DELETED_KEY = "ft_workout_deleted";

// Last-selected History-tab domain ("fingers" / "workout" / "climbing").
// Persisted so the History tab opens to the same domain across sessions.
export const LS_HISTORY_DOMAIN_KEY = "ft_history_domain";

// Set<id> of rep tombstones — Supabase rep ids that have been deleted
// from this device. Mirrors LS_WORKOUT_DELETED_KEY's role for whole
// workouts. The cloud-reconcile pass in useRepHistory uses this to
// avoid re-uploading deleted reps: any local rep whose id is on this
// list gets filtered out of the toSync push set, even if it's
// "missing" from cloud. Without this, a reconcile after a direct
// DB delete (or after another device's delete that hasn't propagated
// to this device's local cache) would resurrect the deleted reps by
// pushing them back up as if they were unsynced offline work.
//
// Scope: local-only. A future enhancement could sync the tombstone
// list to Supabase for true cross-device delete durability, but for
// now each device maintains its own list. The list is keyed by id;
// reps without an id (unsynced offline reps that never reached
// Supabase) can't be tombstoned this way and rely on local state
// removal alone — which is fine because they have no cloud presence
// to be resurrected from.
export const LS_REP_DELETED_KEY = "ft_rep_deleted";

// (LS_TRAINING_FOCUS_KEY retired May 2026 with the Training Focus
// feature itself. The "ft_training_focus" entries on existing devices
// are orphaned but harmless; the key isn't read anywhere.)

// AnalysisContainer sub-tab selector ("fingers" | "lifts"). Persisted
// so the user lands on whichever side they last looked at when they
// re-enter the Analysis tab. Unset = defaults to "fingers".
export const LS_ANALYSIS_SUBTAB_KEY = "ft_analysis_subtab";

// AnalysisView × BW normalize toggle. When true, all metric surfaces
// (F-D chart, AUC trajectory, Curve Improvement, Hand Asymmetry)
// render in bodyweight-relative units rather than absolute force.
// Per-session-date BW is used so historical points get divided by
// the BW from THAT date, not just current BW. Persisted across
// navigations.
export const LS_BW_NORMALIZE_KEY = "ft_bw_normalize";

// Climbing history filter pills — persists the active filter selection
// (named-only toggle + per-category single-select for discipline, venue,
// wall) so re-opening the History tab lands on the same view the user
// left. Shape: { named: bool, discipline: str, venue: str, wall: str }.
// Local-only — view state, not worth syncing to the cloud.
export const LS_CLIMBING_HISTORY_FILTERS_KEY = "ft_climbing_history_filters";

// Climbing grade pyramid — pinned project grade per (discipline,
// venue, wall) combination. Map shape: keys are pipe-separated
// `${discipline}|${venue}|${wall}` strings; values are grade strings.
// Example:
//   {
//     "boulder|indoor|commercial": "V7",
//     "boulder|indoor|moonboard":  "V5",
//     "boulder|outdoor|all":       "V6",
//     "lead|all|all":              "5.13a",
//   }
// Why per-combination: a V4 on a MoonBoard isn't the same as a V4
// on a commercial set or outdoors. Each context deserves its own
// project anchor.
export const LS_PYRAMID_PROJECT_KEY = "ft_pyramid_project";

// Climbing grade pyramid — warmup floor per (discipline, venue, wall).
// Same composite-key shape as LS_PYRAMID_PROJECT_KEY. Grades at or
// below the floor are excluded from the pyramid chart and surfaced as
// a small "plus N warmup sends" caption underneath. Per-combination
// because warmup grades differ across walls (V3 is a warmup on
// commercial sets but a real climb on a MoonBoard).
export const LS_PYRAMID_WARMUP_KEY = "ft_pyramid_warmup";

// Build a stable composite key for the pyramid pin maps from the
// active filter set. Wall only matters for indoor boulder; for any
// other combination we force "all" so the key reflects only the
// actually-active filters and we don't fragment the pin namespace
// over irrelevant axes.
export function pyramidPinKey(discipline, venue, wall) {
  const wallPart = (discipline === "boulder" && venue !== "outdoor")
    ? (wall || "all")
    : "all";
  return `${discipline || "boulder"}|${venue || "all"}|${wallPart}`;
}

// Convert a legacy discipline-keyed pin map (`{ boulder: "V6" }`) to
// the composite-key shape. Legacy entries get the broadest filter
// combo (all venues, all walls). Already-migrated entries pass through.
// Returns a fresh object; safe to call on undefined/null/non-object.
export function migrateLegacyPyramidPins(map) {
  if (!map || typeof map !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(map)) {
    if (typeof k !== "string" || !k || !v) continue;
    if (k.includes("|")) {
      out[k] = v;
    } else {
      out[`${k}|all|all`] = v;
    }
  }
  return out;
}

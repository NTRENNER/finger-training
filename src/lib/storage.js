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

// Current training focus key — one of TRAINING_FOCUS (balanced /
// bouldering / power_sport / endurance_sport). Drives the per-zone
// bias multiplier in coachingRecommendation. Defaults to "balanced"
// when unset so existing users see no behaviour change.
export const LS_TRAINING_FOCUS_KEY = "ft_training_focus";

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
  let raw = null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return null;   // storage API itself unavailable
  }
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // QUARANTINE, don't just return null. Returning null for a
    // corrupt blob made callers initialize to [] and their
    // persistence effects immediately OVERWROTE the original bytes —
    // for a signed-out user that destroyed the entire training
    // history unrecoverably. Stash the raw string under a timestamped
    // sibling key first so the data is recoverable by hand, then
    // remove the corrupt original so we don't quarantine again on
    // every read.
    try {
      localStorage.setItem(`${key}__corrupt_${Date.now()}`, raw);
      localStorage.removeItem(key);
    } catch { /* quota — the original stays in place, still readable by hand */ }
    console.error(`loadLS: corrupt JSON under "${key}" — quarantined a copy; treating as empty`);
    return null;
  }
}

// Returns true when the write landed, false when it didn't (quota
// exceeded, private mode). Callers persisting CRITICAL data (rep
// history, retry queues, tombstones) should check the return value —
// a silently-dropped queue write means a failed push is never
// retried and the rep exists only in memory.
export function saveLS(key, v) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
    return true;
  } catch (e) {
    console.error(`saveLS: write failed for "${key}" (${e?.name || "unknown"}) — data NOT persisted`);
    return false;
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

// Daily cookedness cache — per-date 0–10 scalar mirroring the
// Supabase daily_state table for offline reads + retroactive edits.
// Shape: { [ymdDate]: cooked }. Cloud-synced on sign-in by useDailyState;
// retroactive edits from AnalysisView's session-detail modal write
// both LS and cloud so the curve-fit pipeline (buildFreshLoadMap) can
// down-weight cooked sessions immediately, without waiting for a cloud
// round-trip.
export const LS_DAILY_STATE_KEY = "ft_daily_state";

// Accepted deload week — { start: "YYYY-MM-DD", severity: "mild"|"strong" }
// or null. Set when the user accepts the deload banner's proposal;
// keeps the weekly plan + reminder showing for DELOAD_WEEK_DAYS even as
// the (reduced) sessions clear the recovery signal. Device-local — a
// deload is a personal week-scoped choice, not synced training data.
export const LS_DELOAD_WEEK_KEY = "ft_deload_week";

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

// Adaptive warmup mode — "boulder" (perfusion + BORK potentiation)
// or "route" (perfusion only, longer holds). The WarmupView surfaces
// a pill toggle on the preview screen; this LS key remembers the
// last choice so it persists across sessions on the same device.
// Unset / unrecognized values default to "boulder" in the view.
export const LS_WARMUP_MODE_KEY = "ft_warmup_mode";

// Per-grip baselines, frozen at first seed. Shape:
//   { [grip]: { date: "YYYY-MM-DD", amps: [a, b, c] } }
//
// Why frozen: useGripFits used to recompute the baseline window from
// raw history on every render. The window was "earliest 5 reps spanning
// 3 distinct target_durations" sorted by date ascending, so adding an
// older rep (e.g., a stale device finally syncing up backdated data,
// or an accidental import) would slide the anchor backward and crash
// the Curve Improvement % overnight — the user's "now" curve was
// suddenly being compared against an earlier, weaker baseline.
//
// With this key, the first time a grip's seed window is satisfied,
// the {date, amps} get pinned here AND mirrored to
// user_settings.pinned_grip_baselines on cloud. Subsequent renders
// read the pinned baseline directly; backdated reps add to the AUC
// trajectory and history overlay but don't shift the comparison frame.
//
// To rebuild a baseline intentionally (e.g., a multi-week layoff
// followed by a deload reset), drop the corresponding key from
// localStorage / user_settings and the next render reseeds.
export const LS_PINNED_GRIP_BASELINES_KEY = "ft_pinned_grip_baselines";

// Per-(grip, hand) pinned baselines — same freeze-on-first-seed
// contract as LS_PINNED_GRIP_BASELINES_KEY but keyed `${grip}|${hand}`
// (June 2026, added with the analysis hand selector so the per-hand
// Curve Improvement / Capacity views compare against a FROZEN frame,
// not a recomputed one that backdated syncs could slide). Synced to
// user_settings.pinned_perhand_baselines; useGripFits owns the
// pin-on-first-seed effect, same gating as the pooled pins.
export const LS_PINNED_PERHAND_BASELINES_KEY = "ft_pinned_perhand_baselines";

// (LS_PYRAMID_WARMUP_KEY existed when the pyramid card had a
// "Warmups ≤ Vx" floor selector — May 2026. The redesigned 5-tier
// silhouette doesn't filter by warmup, so the key was removed. Any
// orphaned `ft_pyramid_warmup` entries in localStorage are now
// ignored and can be cleared by a future migration if desired.)

// Last signed-in Supabase user id. Used by useAuth to detect an
// account switch on a shared device: every ft_* cache below is
// user-scoped data but none of the keys are namespaced by user, so
// without this guard, user B signing in after user A would reconcile
// A's cached reps/workouts/BW/activities as "local-only work" and
// push A's entire training history into B's account.
export const LS_LAST_USER_KEY = "ft_last_user";

// Wipe all user-scoped local caches. Called by useAuth when the
// signed-in user id differs from LS_LAST_USER_KEY. Removes every
// ft_* key plus the legacy unprefixed "unit_pref". Deliberately
// leaves Supabase's own sb-* auth/session keys alone.
export function clearUserScopedLS() {
  try {
    const doomed = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith("ft_") || k === "unit_pref")) doomed.push(k);
    }
    doomed.forEach(k => localStorage.removeItem(k));
  } catch {
    // Storage unavailable — nothing cached, nothing to clear.
  }
}

// ─────────────────────────────────────────────────────────────
// DIRTY-KEY TRACKING (per-domain unsynced-edit sets)
// ─────────────────────────────────────────────────────────────
// The activities / daily_state / BW cloud reconciles used to merge
// with a blanket "local wins on collision" rule. That rule is only
// right when the local copy actually carries a newer edit; for
// untouched entries it permanently shadowed edits made on OTHER
// devices, so two devices could diverge forever (each one's stale
// copy beating the other's newer cloud write on every sign-in).
//
// Instead of per-row timestamps (schema migration + clock-skew
// trust), each domain keeps a small LS set of keys with local edits
// that haven't been confirmed by a successful cloud push:
//
//   * save/update → markDirty(key)        (before the push)
//   * push resolves ok → clearDirty(key)  (only if the local value
//                                          still matches what was
//                                          pushed — see hooks)
//   * reconcile → local wins ONLY for dirty keys; cloud wins for
//     everything else. A dirty key with no local entry records a
//     local DELETE that hasn't reached the cloud yet — reconcile
//     honors it (drops the cloud copy and retries the delete)
//     instead of resurrecting.
//
// Sets are arrays in LS (JSON has no Set). Helpers below normalize.

// Per-date daily_state edits (Set<"YYYY-MM-DD">).
export const LS_DAILY_STATE_DIRTY_KEY = "ft_daily_state_dirty";
// Per-id activity edits (Set<id>).
export const LS_ACTIVITY_DIRTY_KEY = "ft_activity_dirty";
// Per-date body-weight edits (Set<"YYYY-MM-DD">).
export const LS_BW_DIRTY_KEY = "ft_bw_dirty";

export function loadDirtySet(key) {
  const raw = loadLS(key);
  return new Set(Array.isArray(raw) ? raw.filter(Boolean) : []);
}

export function markDirty(key, id) {
  if (!id) return;
  const set = loadDirtySet(key);
  if (set.has(id)) return;
  set.add(id);
  saveLS(key, [...set]);
}

export function clearDirty(key, id) {
  if (!id) return;
  const set = loadDirtySet(key);
  if (!set.delete(id)) return;
  saveLS(key, [...set]);
}

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

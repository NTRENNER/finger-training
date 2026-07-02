// ─────────────────────────────────────────────────────────────
// LOCALSTORAGE HELPERS
// ─────────────────────────────────────────────────────────────
// Thin JSON wrappers around the localStorage API. Returns null when
// reads fail (key missing, quota exceeded, parse error) so callers can
// safely use `loadLS(key) || defaultValue`. Writes silently no-op when
// localStorage is unavailable (private browsing modes, quota full).
//
// Every key handed to loadLS/saveLS is a LOGICAL key: it's mapped to
// a physical localStorage key through the per-user namespace resolver
// in the USER NAMESPACING section below before it touches the storage
// API. Callers never see the prefix.
//
// The LS_*_KEY constants exported here are the storage keys the
// extracted view modules consume. Other LS keys consumed only by App.js
// remain inlined there until those views are extracted too.

// ─────────────────────────────────────────────────────────────
// USER NAMESPACING — postmortem, July 2026
// ─────────────────────────────────────────────────────────────
// Incident: every ft_* cache in this file is user-scoped data, but
// the keys themselves were global. The original mitigation
// (ft_last_user + clearUserScopedLS() on account switch, then a
// reload) had two holes, both of which ended with user A's training
// history pushed into user B's cloud account by the reconcile loops:
//
//   HOLE (a) — devices that predate the guard had caches but no
//   ft_last_user. The first sign-in after upgrading saw last == null,
//   treated it as "first sign-in adopts the device's local data", and
//   adopted WHOEVER's data happened to be cached — not necessarily
//   the person signing in.
//
//   HOLE (b) — the wipe raced the app. Between clearUserScopedLS()
//   and window.location.reload(), already-mounted hooks still held
//   user A's data in React state, and their persistence effects
//   rewrote it into the freshly-wiped localStorage. Post-reload, the
//   reconciles classified that data as B's "local-only work" and
//   pushed it into B's account.
//
// Fix: namespace the storage instead of wiping it.
//
//   * Every user-scoped key is physically stored as `u:<uid>:<key>`.
//     Bare (unprefixed) keys are the anonymous / signed-out namespace.
//   * `nsUid` — the namespace this page instance reads and writes —
//     is captured ONCE at module load from ft_last_user and never
//     changes for the life of the page. On an account switch,
//     setLastUserRaw() records the new uid for the NEXT page load but
//     deliberately leaves nsUid alone, so in-flight persistence
//     effects keep writing to the OLD user's namespace until the
//     reload lands. That closes hole (b) structurally: there is no
//     window in which A's in-memory data can land in a namespace B
//     will ever read.
//   * A one-time migration at module load moves legacy bare keys into
//     the namespace of whichever user the OLD system itself recorded
//     in ft_last_user — attributing pre-namespacing data to the
//     person who was actually signed in. That closes hole (a).
//   * Nothing is wiped on switch anymore: each user's caches sit
//     safely under their own prefix, and offline work survives.
//
// Device-scoped keys (never namespaced): ft_last_user only. Everything
// else — every other ft_* key plus the legacy unprefixed "unit_pref" —
// is user-scoped. Supabase's own sb-* auth/session keys are not ours
// and are never touched by any code in this file.

// Last signed-in Supabase user id. Written RAW (setLastUserRaw) and
// read RAW (readRawLastUser) — never routed through loadLS/saveLS's
// key resolution, because it's the key that DEFINES the resolution.
export const LS_LAST_USER_KEY = "ft_last_user";

// Keys that describe the device, not the user. resolveKey passes
// these through bare no matter who is signed in.
const DEVICE_SCOPED_KEYS = new Set([LS_LAST_USER_KEY]);

// Is `k` a BARE physical key holding user-scoped data? Used by the
// legacy migration, anon-data adoption, and the signed-out branch of
// clearUserScopedLS. Quarantine siblings ("ft_v3__corrupt_<ts>",
// "unit_pref__corrupt_<ts>") match too — they're user data and must
// travel with their user.
function isUserScopedBareKey(k) {
  if (k.startsWith("ft_")) return !DEVICE_SCOPED_KEYS.has(k);
  return k === "unit_pref" || k.startsWith("unit_pref__corrupt_");
}

// Read ft_last_user directly — no namespacing, no quarantine-on-
// corrupt (there'd be nothing useful to recover). The value is JSON
// (historically written via saveLS, now via setLastUserRaw); any
// failure — missing key, storage unavailable, corrupt JSON, non-
// string value — reads as "no recorded user".
export function readRawLastUser() {
  try {
    const raw = localStorage.getItem(LS_LAST_USER_KEY);
    if (raw == null) return null;
    const v = JSON.parse(raw);
    return (typeof v === "string" && v) ? v : null;
  } catch {
    return null;
  }
}

// The namespace this page instance lives in. Captured once at module
// load and frozen; see the postmortem above for why it must NOT track
// later ft_last_user writes (hole (b)).
let nsUid = readRawLastUser();

// Map a logical key to its physical localStorage key. Device-scoped
// keys pass through bare. User-scoped keys get the page's namespace
// prefix; with no namespace (signed out / never signed in) the bare
// key IS the namespace — the anonymous one.
function resolveKey(key) {
  if (DEVICE_SCOPED_KEYS.has(key)) return key;
  return nsUid ? `u:${nsUid}:${key}` : key;
}

// Move every bare user-scoped key into `uid`'s namespace. Shared by
// the legacy migration (hole (a)) and first-sign-in adoption.
//
// Conflict rule: if the namespaced copy already exists it was written
// AFTER namespacing shipped — newer by construction — so keep it and
// drop the stale bare duplicate. Quota rule: if the namespaced write
// throws mid-move, the catch skips the removeItem, leaving that bare
// key in place so the next module load retries the move instead of
// silently losing data.
function moveBareKeysToNamespace(uid) {
  if (!uid) return;
  try {
    const bare = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && isUserScopedBareKey(k)) bare.push(k);
    }
    for (const k of bare) {
      try {
        const target = `u:${uid}:${k}`;
        if (localStorage.getItem(target) == null) {
          localStorage.setItem(target, localStorage.getItem(k));
        }
        localStorage.removeItem(k);
      } catch {
        // Quota / availability failure mid-move — leave this bare key
        // untouched; the next load retries it.
      }
    }
  } catch {
    // Storage API unavailable — nothing to move.
  }
}

// Record `uid` as the last signed-in user for the NEXT page load.
// CRITICAL: does not touch nsUid. After an account switch the caller
// (useAuth's guard) forces a reload; until that reload lands, every
// persistence effect on the current page keeps writing to the OLD
// user's namespace. Retargeting writes here would reopen hole (b) —
// A's in-memory state would start landing in B's namespace.
export function setLastUserRaw(uid) {
  try {
    localStorage.setItem(LS_LAST_USER_KEY, JSON.stringify(uid));
  } catch {
    // Storage unavailable — nothing recorded; the guard simply runs
    // again on the next load.
  }
}

// First-sign-in adoption: fold the anonymous namespace's training
// data (bare user-scoped keys) into `uid`'s namespace — signed-out
// local work belongs to the first account that signs in on the
// device. Same move/conflict/quota semantics as the legacy migration.
export function adoptAnonDataForUser(uid) {
  moveBareKeysToNamespace(uid);
}

// One-time legacy migration (closes hole (a)): if this device
// recorded a last user under the OLD un-namespaced system, any bare
// user-scoped keys still lying around are THAT user's data — move
// them into their namespace before any hook can read them. Runs at
// module load, so by the time loadLS is callable the physical layout
// is already namespaced. No-op when there are no bare keys left.
function runLegacyMigration() {
  if (nsUid) moveBareKeysToNamespace(nsUid);
}
runLegacyMigration();

// ─────────────────────────────────────────────────────────────
// SUBSCRIPTIONS + SNAPSHOT CACHE — reactive layer, July 2026
// ─────────────────────────────────────────────────────────────
// localStorage used to be an unowned shadow store: half a dozen views
// read it independently at mount (or on every render) with no way to
// hear about later writes, so they went stale the moment the cloud
// reconcile or a manual pull rewrote LS behind them. Every workaround
// for that grew somewhere else — App.js's pullFromCloud ended in a
// full window.location.reload() because "WorkoutView reads LS on
// mount", WorkoutHistoryView bumped a `tick` counter to force
// re-reads after its own edits, and SetupView's BwPrompt re-parsed
// the BW log JSON on every render. This layer makes storage.js the
// owner: saveLS notifies per-key subscribers after each successful
// write, and src/hooks/useLSValue.js turns that into a
// useSyncExternalStore hook so a view's read of a key stays live for
// as long as it's mounted.
//
// Keys here are LOGICAL keys — the strings callers already pass to
// loadLS/saveLS — not resolved physical keys. That's safe because the
// logical→physical mapping is constant for the life of the page:
// nsUid is frozen at module load and account switches always reload
// (see the namespacing postmortem up top).
//
// Contract: values flowing through this layer are IMMUTABLE.
// getLSSnapshot returns the same reference on every call until the
// key is next written (useSyncExternalStore requires referentially
// stable snapshots to avoid render loops), so callers must never
// mutate a value they read — build a NEW array/object and hand it to
// saveLS instead. Plain loadLS stays uncached for one-off readers;
// only getLSSnapshot consults the cache. saveLS keeps the cache
// coherent even for keys nobody currently subscribes to, so a later
// subscriber's first snapshot is never stale.

const lsListeners = new Map();     // logical key → Set<callback>
const lsSnapshotCache = new Map(); // logical key → last parsed value

function notifyLS(key) {
  const subs = lsListeners.get(key);
  if (!subs) return;
  // Copy before iterating — a callback may (un)subscribe
  // synchronously, and mutating a Set mid-iteration skips entries.
  for (const cb of [...subs]) {
    try {
      cb();
    } catch (e) {
      console.error(`subscribeLS: listener for "${key}" threw`, e);
    }
  }
}

// Drop every cached snapshot and wake every subscriber. Used when the
// physical layout changes out from under the whole logical mapping:
// a cross-tab localStorage.clear(), clearUserScopedLS, or the test
// seams re-pointing nsUid.
function invalidateAllLS() {
  const keys = new Set([...lsSnapshotCache.keys(), ...lsListeners.keys()]);
  lsSnapshotCache.clear();
  keys.forEach(k => notifyLS(k));
}

// Subscribe to writes on a logical key. Returns the unsubscribe fn.
export function subscribeLS(key, cb) {
  let set = lsListeners.get(key);
  if (!set) {
    set = new Set();
    lsListeners.set(key, set);
  }
  set.add(cb);
  return () => {
    set.delete(cb);
    if (set.size === 0) lsListeners.delete(key);
  };
}

// Cached parsed read. On a miss, loads through loadLS (so the corrupt-
// JSON quarantine still runs) and caches the result — including null,
// which is a perfectly stable snapshot for "key absent".
export function getLSSnapshot(key) {
  if (lsSnapshotCache.has(key)) return lsSnapshotCache.get(key);
  const v = loadLS(key);
  lsSnapshotCache.set(key, v);
  return v;
}

// Inverse of resolveKey for THIS page's namespace: map a physical
// localStorage key back to the logical key it resolves from, or null
// when the physical key belongs to another user's namespace (or isn't
// ours at all). Used by the cross-tab storage listener below.
function logicalKeyFor(physicalKey) {
  if (DEVICE_SCOPED_KEYS.has(physicalKey)) return physicalKey;
  if (nsUid) {
    const prefix = `u:${nsUid}:`;
    return physicalKey.startsWith(prefix) ? physicalKey.slice(prefix.length) : null;
  }
  // Signed out: bare keys ARE the (anonymous) namespace; any u:* key
  // is some signed-in user's data, not this page's.
  return physicalKey.startsWith("u:") ? null : physicalKey;
}

// Cross-tab coherence. "storage" fires in OTHER tabs of this origin
// when localStorage changes; the writing tab already went through
// saveLS. Invalidate (don't eagerly re-parse — the next getLSSnapshot
// does that lazily) and notify so mounted useLSValue hooks re-read.
// Guarded for SSR / non-window test environments.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (e) => {
    try {
      // Ignore sessionStorage events; e.storageArea can be absent on
      // synthetic events, and touching window.localStorage can throw
      // in locked-down modes — treat both as "assume it's ours".
      if (e.storageArea && e.storageArea !== window.localStorage) return;
    } catch { /* assume localStorage */ }
    if (e.key == null) {
      // localStorage.clear() in another tab — everything is suspect.
      invalidateAllLS();
      return;
    }
    const logical = logicalKeyFor(e.key);
    if (logical == null) return;
    lsSnapshotCache.delete(logical);
    notifyLS(logical);
  });
}

// ─────────────────────────────────────────────────────────────
// TEST SEAMS — not for production use
// ─────────────────────────────────────────────────────────────
// nsUid is deliberately frozen at module load in production; tests
// need to simulate different sign-in states (and re-run the module-
// load migration) within a single module instance, so these poke the
// module state directly.

// Force the active namespace (null = signed-out / anonymous).
// Re-pointing nsUid changes the logical→physical mapping, so every
// cached snapshot is stale — flush the reactive layer too.
export function __setNsUidForTests(uid) {
  nsUid = uid || null;
  invalidateAllLS();
}

// Re-read ft_last_user and re-run the legacy migration, exactly as a
// fresh page load would.
export function __runLegacyMigrationForTests() {
  nsUid = readRawLastUser();
  runLegacyMigration();
  invalidateAllLS();
}

export function loadLS(key) {
  const k = resolveKey(key);
  let raw = null;
  try {
    raw = localStorage.getItem(k);
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
    // Quarantine keys are siblings of the RESOLVED key, so a corrupt
    // blob stays inside the namespace (with the user) it came from.
    try {
      localStorage.setItem(`${k}__corrupt_${Date.now()}`, raw);
      localStorage.removeItem(k);
    } catch { /* quota — the original stays in place, still readable by hand */ }
    console.error(`loadLS: corrupt JSON under "${k}" — quarantined a copy; treating as empty`);
    // Whatever the reactive layer cached for this key no longer
    // matches the (now quarantined-away) bytes — snapshot readers
    // should see the same null this call returns.
    lsSnapshotCache.set(key, null);
    notifyLS(key);
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
    localStorage.setItem(resolveKey(key), JSON.stringify(v));
  } catch (e) {
    console.error(`saveLS: write failed for "${key}" (${e?.name || "unknown"}) — data NOT persisted`);
    return false;
  }
  // Write landed — the value just written IS the current snapshot.
  // Cache it (even with zero subscribers, so a later subscriber's
  // first read stays coherent) and notify. Failed writes return above
  // WITHOUT notifying: localStorage still holds the old value, and
  // telling subscribers about a value that never persisted would
  // desync them from what a reload will read.
  lsSnapshotCache.set(key, v);
  notifyLS(key);
  return true;
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

// (LS_LAST_USER_KEY now lives in the USER NAMESPACING section at the
// top of this file — it defines the namespace, so it's declared with
// the resolver that consumes it.)

// Clear the CURRENT namespace's user-scoped caches: the signed-in
// user's `u:<uid>:*` keys, or the bare anonymous keys when signed
// out. NO LONGER called by the auth guard — account switches are
// handled by namespacing, not wiping (see the postmortem up top) —
// but retained as a utility for explicit "clear local data" flows.
// Never touches ft_last_user, other users' namespaces, or Supabase's
// own sb-* auth/session keys.
export function clearUserScopedLS() {
  try {
    const prefix = nsUid ? `u:${nsUid}:` : null;
    const doomed = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (prefix ? k.startsWith(prefix) : isUserScopedBareKey(k)) doomed.push(k);
    }
    doomed.forEach(k => localStorage.removeItem(k));
    // The whole namespace just vanished — flush the reactive layer so
    // mounted useLSValue hooks re-read (to null) instead of serving
    // snapshots of deleted data.
    invalidateAllLS();
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

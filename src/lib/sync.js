// ─────────────────────────────────────────────────────────────
// SUPABASE SYNC HELPERS
// ─────────────────────────────────────────────────────────────
// Round-trip helpers for the two cloud tables: `reps` (per-rep
// finger-training rows) and `workout_sessions` (per-session
// barbell/calisthenic rows). Each helper is a thin async wrapper
// that swallows network errors into a boolean (true = succeeded)
// or a null/array (true if data, null if error).
//
// The local-retry queue (`enqueueReps`, `flushQueue`) handles the
// offline-first case: a rep that can't reach Supabase is parked in
// localStorage under LS_QUEUE_KEY and replayed on the next online
// auth-ready cycle (App's reconcile path).
//
// SQL schemas (run once in the Supabase SQL editor):
//
//   CREATE TABLE workout_sessions (
//     id text PRIMARY KEY,
//     date text, workout text, session_number integer,
//     was_recommended boolean,
//     exercises jsonb,
//     created_at timestamptz DEFAULT now()
//   );
//   ALTER TABLE workout_sessions ENABLE ROW LEVEL SECURITY;
//   CREATE POLICY "auth_all" ON workout_sessions
//     FOR ALL USING (auth.uid() IS NOT NULL);
//
// For existing tables (added later — run once in the Supabase SQL
// editor; safe to re-run because of IF NOT EXISTS):
//   ALTER TABLE workout_sessions
//     ADD COLUMN IF NOT EXISTS was_recommended boolean;
//   ALTER TABLE reps
//     ADD COLUMN IF NOT EXISTS perceived_rpe integer;
//
// `perceived_rpe` was the per-rep stamp for the legacy per-zone gain
// learner. The new per-grip β learner reads cookedness from the
// daily_state table (joined by date) inside the server-side trigger
// update_fatigue_beta_from_rep_trg. Column preserved on `reps` for
// historical reads; always null on new writes.
//
// `was_recommended` carries the WorkoutTab rotation signal across
// devices. WorkoutTab derives "next workout" from the synced log,
// counting only sessions where this flag is true (or null, treated
// as true for legacy rows). Without the column, two devices see
// the same set of sessions but drift on rotation when the user
// occasionally picks off-rotation.
//
//   CREATE TABLE reps (
//     id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//     created_at timestamptz DEFAULT now(),
//     date text, grip text, hand text,
//     target_duration integer,
//     prescribed_load_kg real,  -- program-suggested kg load (set on every write)
//     manual_load_kg real,      -- user-entered actual kg for non-Tindeq sessions (nullable)
//     weight_kg real,           -- LEGACY: equivalent to prescribed_load_kg, kept for safety
//     actual_time_s real,
//     avg_force_kg real, peak_force_kg real,
//     set_num integer, rep_num integer,
//     rest_s integer, session_id text,
//     failed boolean DEFAULT false
//   );
//   ALTER TABLE reps ENABLE ROW LEVEL SECURITY;
//   CREATE POLICY "auth_all" ON reps
//     FOR ALL USING (auth.uid() IS NOT NULL);
//
//   CREATE TABLE body_weights (
//     id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
//     date        text NOT NULL UNIQUE,
//     kg          real NOT NULL,
//     created_at  timestamptz DEFAULT now()
//   );
//   ALTER TABLE body_weights ENABLE ROW LEVEL SECURITY;
//   CREATE POLICY "auth_all" ON body_weights
//     FOR ALL USING (auth.uid() IS NOT NULL);
//   CREATE INDEX body_weights_date_idx ON body_weights (date DESC);
//
//   CREATE TABLE activities (
//     id          text PRIMARY KEY,
//     type        text NOT NULL,
//     date        text NOT NULL,
//     discipline  text, venue text, grade text, ascent text,
//     wall        text, rpe integer,
//     created_at  timestamptz DEFAULT now()
//   );
//   ALTER TABLE activities ENABLE ROW LEVEL SECURITY;
//   CREATE POLICY "auth_all" ON activities
//     FOR ALL USING (auth.uid() IS NOT NULL);
//   CREATE INDEX activities_date_idx ON activities (date DESC);
//   CREATE INDEX activities_type_idx ON activities (type);

import { supabase } from "./supabase.js";
import { loadLS, saveLS, LS_REP_DELETED_KEY } from "./storage.js";
import { today } from "../util.js";

// localStorage key for the offline retry queue. Reps that failed an
// authenticated push end up here and are flushed on the next sync.
export const LS_QUEUE_KEY = "ft_push_queue";

// Fetch the current user's id from the live Supabase auth session.
// Returns null if not signed in (caller bails out of the push). All
// per-row inserts call this and attach the returned id as user_id
// so RLS WITH CHECK passes and the row is correctly attributed.
// Server-side, each table also has DEFAULT auth.uid() on user_id —
// belt and suspenders, but the explicit field avoids a round-trip
// surprise if the default ever gets dropped.
async function currentUserId() {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    return user?.id ?? null;
  } catch (e) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// WORKOUT-SESSION HELPERS (workout_sessions table)
// ─────────────────────────────────────────────────────────────

export async function pushWorkoutSession(session) {
  try {
    const userId = await currentUserId();
    if (!userId) return false;
    const { error } = await supabase.from("workout_sessions").upsert({
      id:               session.id,
      user_id:          userId,
      date:             session.date,
      completed_at:     session.completedAt ?? null,
      workout:          session.workout,
      session_number:   session.sessionNumber,
      // null when the session was logged before the wasRecommended
      // flag existed; the WorkoutTab derivation treats null as "yes"
      // for back-compat (the old code always advanced on completion
      // in the common case).
      was_recommended:  session.wasRecommended ?? null,
      exercises:        session.exercises,
      // Notes round-trip via the workout_sessions_add_notes migration
      // (May 2026). Empty string normalized to null so a wiped-out
      // notes field actually clears the column.
      notes:            (typeof session.notes === "string" && session.notes.trim().length > 0)
                          ? session.notes : null,
    }, { onConflict: "id" });
    if (error) { console.warn("Supabase workout push:", error.message); return false; }
    return true;
  } catch (e) {
    console.warn("Supabase workout push exception:", e.message);
    return false;
  }
}

export async function fetchWorkoutSessions() {
  const { data, error } = await supabase
    .from("workout_sessions")
    .select("*")
    .order("date", { ascending: false });
  if (error) { console.warn("Supabase workout fetch:", error.message); return null; }
  return (data || []).map(s => ({
    id:              s.id,
    date:            s.date,
    completedAt:     s.completed_at ?? null,
    workout:         s.workout,
    // The DB column is named `workout`; the client-side schema added
    // a separate `workoutId` field later. Mirror on read so cloud-
    // synced sessions look identical to locally-saved ones — without
    // this, every downstream consumer that filters by workoutId
    // (stretchState, daysSinceLastOfType, computeTagDaysSince) misses
    // cloud-pulled rows and the user sees "no stretches logged"
    // even though History happily renders them.
    workoutId:       s.workout,
    sessionNumber:   s.session_number,
    // Carry was_recommended through. Null/undefined means "legacy or
    // pre-column row" — WorkoutTab's rotation derivation treats !== false
    // as a positive, so unknowns advance the rotation. Only an explicit
    // false suppresses advancement.
    wasRecommended:  s.was_recommended ?? undefined,
    exercises:       s.exercises || {},
    notes:           s.notes ?? "",
  }));
}

export async function deleteWorkoutSession(id) {
  try {
    // Tombstone FIRST, then delete. The per-device LS_WORKOUT_DELETED_KEY
    // only protects this device; any other device that still holds the
    // session in its local cache sees it "missing from cloud" on its
    // next reconcile and re-pushes it (deterministic delete-resurrection
    // — the same bug rep_tombstones was built to stop for reps). The
    // synced table is the cross-device authority; ordering it before
    // the delete means a crash between the two calls leaves a tombstone
    // and a soon-to-be-filtered row, not a resurrectable orphan.
    await pushWorkoutSessionTombstones([id]);
    const { error } = await supabase.from("workout_sessions").delete().eq("id", id);
    if (error) { console.warn("Supabase workout delete:", error.message); return false; }
    return true;
  } catch (e) {
    console.warn("Supabase workout delete exception:", e.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// WORKOUT-SESSION TOMBSTONES (workout_session_tombstones table)
// ─────────────────────────────────────────────────────────────
// Synced delete tracking for strength-workout sessions — mirrors the
// rep_tombstones design. Table created June 2026 (migration
// synced_tombstones_for_workouts_activities_bw): (user_id, session_id)
// PK, RLS gated on auth.uid().

export async function pushWorkoutSessionTombstones(ids) {
  const valid = (ids || []).filter(Boolean);
  if (valid.length === 0) return true;
  try {
    const userId = await currentUserId();
    if (!userId) return false;
    const { error } = await supabase
      .from("workout_session_tombstones")
      .upsert(valid.map(id => ({ user_id: userId, session_id: id })),
        { onConflict: "user_id,session_id" });
    if (error) { console.warn("Supabase workout tombstone push:", error.message); return false; }
    return true;
  } catch (e) {
    console.warn("Supabase workout tombstone push exception:", e.message);
    return false;
  }
}

// Returns null on error so callers fall back to the per-device
// LS_WORKOUT_DELETED_KEY set rather than risk re-pushing.
export async function fetchWorkoutSessionTombstoneIds() {
  try {
    const { data, error } = await supabase
      .from("workout_session_tombstones")
      .select("session_id");
    if (error) { console.warn("Supabase workout tombstone fetch:", error.message); return null; }
    return (data || []).map(r => r.session_id).filter(Boolean);
  } catch (e) {
    console.warn("Supabase workout tombstone fetch exception:", e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// REP HELPERS (reps table)
// ─────────────────────────────────────────────────────────────

// Strip a local rep down to the columns Supabase expects. Defensive
// `?? null` / `?? false` so a partial rep (e.g. mid-edit) doesn't
// blow up the upsert with undefined values.
//
// IMPORTANT: `id` is included. Reps get a client-generated UUID at
// creation time (see useRepHistory.addReps), so the same rep always
// upserts onto the same cloud row regardless of how many times push
// fires. Without this, `.insert` would let Postgres generate a fresh
// UUID each time and every re-push (offline-queue flush, reconcile,
// retry, tab-focus event) created a duplicate row. The May 2026
// duplicate-storm bug across multiple workouts was exactly this.
export function repPayload(rep, userId) {
  return {
    // Only included when present so legacy reps without ids still go
    // through .insert-style path (Postgres assigns UUID). Modern reps
    // always carry one, so upsert(onConflict: "id") deduplicates.
    ...(rep.id ? { id: rep.id } : {}),
    user_id: userId,
    date: rep.date, grip: rep.grip, hand: rep.hand,
    target_duration: rep.target_duration,
    // Schema split (late May 2026): prescribed_load_kg is the new
    // "what the program suggested" field; manual_load_kg is the new
    // "what the user actually lifted" field for non-Tindeq sessions.
    // weight_kg is mirrored from prescribed_load_kg as a legacy safety
    // net; will be dropped in a follow-up commit once the read sweep
    // is confirmed clean.
    prescribed_load_kg: rep.prescribed_load_kg ?? rep.weight_kg ?? null,
    manual_load_kg:     rep.manual_load_kg ?? null,
    weight_kg:          rep.prescribed_load_kg ?? rep.weight_kg ?? null,
    actual_time_s: rep.actual_time_s, avg_force_kg: rep.avg_force_kg,
    // Preserve null for "no measurement" vs an actual zero reading.
    // The DB column is nullable; collapsing null → 0 was a stale
    // default from before manual-load entries existed and now muddies
    // the "did Tindeq capture this rep?" signal that downstream code
    // (and any future code) might reasonably want to check.
    peak_force_kg: rep.peak_force_kg ?? null,
    set_num: rep.set_num, rep_num: rep.rep_num,
    rest_s: rep.rest_s, session_id: rep.session_id,
    failed: rep.failed ?? false,
    session_started_at: rep.session_started_at ?? null,
    // perceived_rpe was the per-rep stamp for the old per-zone
    // shrinkage learner (perceivedFatigueLearning, removed). The new
    // per-grip β learner reads cookedness from daily_state via the
    // server-side trigger, not from this column. Preserved here for
    // back-compat with historical reads and to avoid dropping the
    // column from the table — always null on new writes.
    perceived_rpe: rep.perceived_rpe ?? null,
    // Per-session cookedness override (migration: reps_add_session_cooked,
    // late May 2026). Same value across every rep in the session — stamped
    // at session start from the cookedness slider. Null = no override; the
    // curve fit falls back to daily_state.cooked for the rep's date.
    session_cooked: (rep.session_cooked != null
                      && Number.isFinite(Number(rep.session_cooked)))
      ? Number(rep.session_cooked)
      : null,
  };
}

// Returns a tri-state result:
//   'ok'         — push succeeded
//   'tombstoned' — server-side trigger rejected because this rep matches
//                  an id / slot / session tombstone. Caller MUST drop the
//                  rep from any local queue / history (don't retry — the
//                  rep is permanently dead).
//   'error'      — transient failure (network, RLS, type mismatch, etc.).
//                  Caller should enqueue for retry.
//
// Uses upsert on the WORKOUT-SLOT unique constraint
// (session_id, set_num, rep_num, hand) instead of the primary key.
// Why: a legacy rep whose local `id` doesn't match its cloud id (the
// pre-fix corruption pattern — pushRep used .insert() and Postgres
// generated a server UUID the client never learned) will, on re-push,
// collide on the workout-slot key instead of generating a fresh row.
// Postgres treats it as an update of the existing slot, dedup happens
// at the DB level, and the client-side reconcile races become safe.
//
// The DB-level UNIQUE constraint reps_workout_slot_unique was added
// in migration `reps_unique_workout_slot` (May 2026) — see the
// migration for the full rationale.
//
// Tombstone-rejection detection: the server trigger
// reject_tombstoned_rep_insert raises EXCEPTION with the message
// prefix "TOMBSTONE_REJECTION:" when a rep matches any of the three
// tombstone tables (id, slot, session). We pattern-match that prefix
// here and return 'tombstoned' so callers don't loop the retry queue
// forever on permanently-rejected reps. See migration
// tombstone_trigger_raise_exception (May 2026).
const TOMBSTONE_REJECTION_PREFIX = "TOMBSTONE_REJECTION:";
function isTombstoneRejection(err) {
  if (!err) return false;
  const msg = String(err.message || err.hint || err.details || "");
  return msg.includes(TOMBSTONE_REJECTION_PREFIX);
}

// id column on reps is type uuid. Anything that isn't a valid UUID
// makes Postgres reject with "invalid input syntax for type uuid: ..."
// — pushRep returns false, the rep enters the retry queue, and it
// fails forever. Old client bundles stamped session-id-style 8-char
// base-36 strings as rep ids (e.g. "22beh911", "5p5cts4k"); reps
// created by those bundles never sync. Validate the id at push time
// and re-stamp anything that doesn't match the UUID v4 shape so the
// queue can finally drain. The DB row will have a fresh server-side
// id; dedup happens on the workout-slot unique constraint, so a
// re-stamped local id can't create a duplicate.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function ensureUuidId(rep) {
  if (rep.id && UUID_RE.test(rep.id)) return rep;
  const newId = (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    // Fallback for environments without crypto.randomUUID (very old
    // browsers, some sandboxes). Builds a v4-shaped string with
    // 12 hex chars of entropy in the last group.
    : `${Date.now().toString(16).padStart(8, "0").slice(-8)}-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`;
  if (rep.id) {
    console.warn(`pushRep: re-stamping non-UUID id "${rep.id}" → "${newId}"`);
  }
  return { ...rep, id: newId };
}

export async function pushRep(rep) {
  try {
    const userId = await currentUserId();
    if (!userId) return "error";
    const safeRep = ensureUuidId(rep);
    const { error } = await supabase
      .from("reps")
      .upsert([repPayload(safeRep, userId)],
        { onConflict: "user_id,session_id,set_num,rep_num,hand" });
    if (error) {
      if (isTombstoneRejection(error)) {
        console.info(`pushRep: tombstone rejection for rep ${safeRep.id} — dropping`);
        return "tombstoned";
      }
      console.warn("Supabase push:", error.message);
      return "error";
    }
    return "ok";
  } catch (e) {
    if (isTombstoneRejection(e)) {
      console.info(`pushRep: tombstone rejection (exception path) — dropping`);
      return "tombstoned";
    }
    console.warn("Supabase push exception:", e.message);
    return "error";
  }
}

// Add reps to the local retry queue. De-dupes by id so a rep that
// fails twice doesn't end up in the queue twice.
export function enqueueReps(reps) {
  const q = loadLS(LS_QUEUE_KEY) || [];
  const existing = new Set(q.map(r => r.id));
  const toAdd = reps.filter(r => r.id && !existing.has(r.id));
  if (toAdd.length > 0) saveLS(LS_QUEUE_KEY, [...q, ...toAdd]);
}

// Attempt to push every queued rep; remove each one on success or on
// permanent tombstone rejection.
//
// Returns the count successfully flushed so the caller can show a
// "synced N pending reps" toast.
//
// Tombstone gates: pre-fetches all three tombstone tables (id / slot /
// session) and drops matches before attempting to push. The reconcile
// path in App.js / useRepHistory.js does the same — this brings flushQueue
// to parity. Without this, slot- or session-tombstoned reps would hit
// the server trigger every retry and never drain (after the trigger was
// changed from RETURN NULL to RAISE EXCEPTION in May 2026).
//
// Safety net: even with all three client-side gates in place, a race
// (rep queued before a tombstone got synced) can still cause the trigger
// to throw. pushRep returns 'tombstoned' in that case and the rep is
// dropped from the queue here, same as a pre-filtered match.
// Mutex: flushQueue is triggered concurrently from at least three
// places (the auth reconcile, pullFromCloud, and the Settings retry
// button). Two interleaved flushes double-push every rep (harmless,
// thanks to the slot upsert) but — worse — each one's final save was
// derived from its own STALE snapshot, so a rep enqueued mid-flight
// by enqueueReps could be silently overwritten out of the queue.
// Single-flight + a fresh re-read at save time close both holes.
let flushQueueInFlight = false;

export async function flushQueue() {
  if (flushQueueInFlight) return 0;
  flushQueueInFlight = true;
  try {
    return await flushQueueOnce();
  } finally {
    flushQueueInFlight = false;
  }
}

async function flushQueueOnce() {
  const q = loadLS(LS_QUEUE_KEY) || [];
  if (q.length === 0) return 0;
  const compositeKey = r => `${r.session_id || r.date}|${r.set_num}|${r.rep_num}|${r.hand}`;
  // Fetch all three tombstone shapes in parallel — parity with the
  // App.js / useRepHistory.js reconcile path.
  const [cloudIdTombs, cloudSlotKeys, cloudSessionIds] = await Promise.all([
    fetchRepTombstoneIds(),
    fetchRepSlotTombstoneKeys(),
    fetchSessionTombstoneIds(),
  ]);
  const idTombs = new Set([
    ...(loadLS(LS_REP_DELETED_KEY) || []),
    ...(cloudIdTombs || []),
  ]);
  const slotTombs    = new Set(cloudSlotKeys   || []);
  const sessionTombs = new Set(cloudSessionIds || []);
  // Track which queue entries were terminally processed (pushed or
  // dropped) by id, then subtract them from a FRESH read of the queue
  // at save time. Anything enqueued during the awaits below survives.
  const processed = new Set();
  let flushed = 0;
  let dropped = 0;
  for (const rep of q) {
    // Pre-flight tombstone gate. Treats matches as "successfully
    // processed" — drop from queue, don't retry, don't push.
    if ((rep.id && idTombs.has(rep.id))
        || slotTombs.has(compositeKey(rep))
        || (rep.session_id && sessionTombs.has(rep.session_id))) {
      if (rep.id) processed.add(rep.id);
      dropped++;
      continue;
    }
    const result = await pushRep(rep);
    if (result === "ok") {
      if (rep.id) processed.add(rep.id);
      flushed++;
    } else if (result === "tombstoned") {
      // Race: rep wasn't in our pre-fetched tombstone snapshot but the
      // server trigger rejected it. Drop from queue same as pre-flight.
      if (rep.id) processed.add(rep.id);
      dropped++;
    }
    // result === "error" → leave in queue for next flush
  }
  const fresh = loadLS(LS_QUEUE_KEY) || [];
  const remaining = fresh.filter(r => !(r.id && processed.has(r.id)));
  saveLS(LS_QUEUE_KEY, remaining);
  if (dropped > 0) console.info(`flushQueue: dropped ${dropped} tombstoned rep(s) from queue`);
  return flushed;
}

// ─────────────────────────────────────────────────────────────
// REP UPDATE QUEUE (edit dirty-tracking)
// ─────────────────────────────────────────────────────────────
// Edits (updateRep / updateSession) used to fire one Supabase update
// and only console.warn on failure. The reconcile then classified
// local reps by EXISTENCE in cloud — an edited rep exists, so the
// stale cloud copy won the wholesale setHistory replacement and the
// edit was silently destroyed. This queue makes edits durable: a
// failed (or signed-out) edit is recorded here, retried on every
// reconcile, and applied OVER the fetched cloud rows until it lands.
//
// Entry shapes:
//   { kind: "rep",     id,         updates, ts }
//   { kind: "session", sessionKey, updates, ts }
// Same-target entries merge (later updates win key-by-key), so
// editing the same rep twice offline yields one entry with the
// combined patch.

export const LS_UPDATE_QUEUE_KEY = "ft_update_queue";

const updateTargetKey = (e) =>
  e.kind === "rep" ? `rep:${e.id}` : `session:${e.sessionKey}`;

export function enqueueRepUpdate(entry) {
  if (!entry || (entry.kind === "rep" && !entry.id)
      || (entry.kind === "session" && !entry.sessionKey)) return;
  const q = loadLS(LS_UPDATE_QUEUE_KEY) || [];
  const key = updateTargetKey(entry);
  const existing = q.find(e => updateTargetKey(e) === key);
  const next = existing
    ? q.map(e => e === existing
        ? { ...e, updates: { ...e.updates, ...entry.updates }, ts: Date.now() }
        : e)
    : [...q, { ...entry, ts: Date.now() }];
  saveLS(LS_UPDATE_QUEUE_KEY, next);
}

// Apply pending edits over an array of cloud-fetched reps so the
// reconcile's setHistory can't revert an edit that hasn't synced yet.
// Pure function — does no IO beyond the LS read.
export function applyPendingUpdates(reps) {
  const q = loadLS(LS_UPDATE_QUEUE_KEY) || [];
  if (q.length === 0 || !Array.isArray(reps) || reps.length === 0) return reps;
  const repPatches = new Map();
  const sessionPatches = new Map();
  for (const e of q) {
    if (e.kind === "rep" && e.id) repPatches.set(e.id, e.updates);
    if (e.kind === "session" && e.sessionKey) sessionPatches.set(e.sessionKey, e.updates);
  }
  return reps.map(r => {
    let out = r;
    const sp = sessionPatches.get(r.session_id || r.date);
    if (sp) out = { ...out, ...sp };
    const rp = r.id ? repPatches.get(r.id) : null;
    if (rp) out = { ...out, ...rp };
    return out;
  });
}

// Retry every queued edit. Same single-flight + fresh-save discipline
// as flushQueue. Entries are removed only when Supabase confirms the
// write; an edit that keeps failing keeps being applied locally via
// applyPendingUpdates, so the user's view stays correct either way.
let updateFlushInFlight = false;

export async function flushUpdateQueue() {
  if (updateFlushInFlight) return 0;
  updateFlushInFlight = true;
  try {
    const q = loadLS(LS_UPDATE_QUEUE_KEY) || [];
    if (q.length === 0) return 0;
    const done = new Set();
    for (const e of q) {
      try {
        if (e.kind === "rep") {
          const { error } = await supabase.from("reps")
            .update(e.updates).eq("id", e.id);
          if (!error) done.add(updateTargetKey(e));
        } else if (e.kind === "session") {
          const { error } = await supabase.from("reps")
            .update(e.updates).eq("session_id", e.sessionKey);
          if (!error) done.add(updateTargetKey(e));
        }
      } catch {
        // Network-level failure — keep the entry for the next flush.
      }
    }
    if (done.size > 0) {
      const fresh = loadLS(LS_UPDATE_QUEUE_KEY) || [];
      saveLS(LS_UPDATE_QUEUE_KEY, fresh.filter(e => !done.has(updateTargetKey(e))));
    }
    return done.size;
  } finally {
    updateFlushInFlight = false;
  }
}

// Pull all reps from Supabase, normalised to the local rep shape.
// Defensive defaults so a row with a missing field doesn't crash
// downstream model code that expects numbers.
export async function fetchReps() {
  const { data, error } = await supabase
    .from("reps").select("*").order("date", { ascending: false });
  if (error) { console.warn("Supabase fetch:", error.message); return null; }
  return (data || []).map(r => ({
    id: r.id, date: r.date ?? today(),
    grip: r.grip ?? "", hand: r.hand ?? "L",
    target_duration: Number(r.target_duration) || 45,
    // Schema split (late May 2026). prescribed_load_kg falls back to
    // weight_kg for legacy rows that pre-date the split (the migration
    // backfilled cloud rows, but offline-cached rows on this device
    // may still have only weight_kg until the next pull). manual_load_kg
    // stays null when unset — effectiveLoad's fallback chain handles
    // the "no manual override" case naturally.
    prescribed_load_kg: Number(r.prescribed_load_kg ?? r.weight_kg) || 0,
    manual_load_kg:     r.manual_load_kg != null ? Number(r.manual_load_kg) : null,
    weight_kg: Number(r.weight_kg ?? r.prescribed_load_kg) || 0,
    actual_time_s: Number(r.actual_time_s) || 0,
    // Same null-vs-zero semantics as the push side: null means "no
    // Tindeq measurement" (manual entry, or a rep where the device
    // wasn't recording), 0 would mean "measured zero force." Mirror
    // the manual_load_kg pattern a few lines up so the round-trip
    // preserves the distinction.
    avg_force_kg:  r.avg_force_kg  != null ? Number(r.avg_force_kg)  : null,
    peak_force_kg: r.peak_force_kg != null ? Number(r.peak_force_kg) : null,
    set_num: Number(r.set_num) || 1,
    rep_num: Number(r.rep_num) || 1,
    rest_s: Number(r.rest_s) || 20,
    session_id: r.session_id ?? "",
    failed: r.failed ?? false,
    session_started_at: r.session_started_at ?? null,
    // Null for legacy rows / sessions where the user didn't dial the
    // RPE slider. Numbers > 1 carry a learning signal.
    perceived_rpe: r.perceived_rpe ?? null,
    // Per-session cookedness override — null falls back to
    // daily_state.cooked when the curve fit looks up r.date.
    session_cooked: r.session_cooked != null ? Number(r.session_cooked) : null,
  }));
}

// ─────────────────────────────────────────────────────────────
// DAILY STATE (cooked scalar — drives the per-grip β learner)
// ─────────────────────────────────────────────────────────────
// One row per date, holding the user's pre-workout "How cooked
// today?" scalar (0 = fresh, 10 = wrecked). Written by SessionPlanCard
// before the user accepts a prescription, so it can't be biased by
// session outcome.
//
// The Postgres trigger update_fatigue_beta_from_rep_trg joins this
// table on NEW.date when rep 1 of a session arrives, then steps
// user_settings.settings.fatigue_model[grip].beta. Without a row in
// daily_state for the session's date, the learner sits this rep out.

export async function pushDailyState(date, cooked) {
  if (!date || cooked == null) return false;
  try {
    const userId = await currentUserId();
    if (!userId) return false;
    const { error } = await supabase.from("daily_state").upsert(
      { user_id: userId, date, cooked: Number(cooked) },
      { onConflict: "user_id,date" }
    );
    if (error) { console.warn("Supabase daily_state push:", error.message); return false; }
    return true;
  } catch (e) {
    console.warn("Supabase daily_state push exception:", e.message);
    return false;
  }
}

export async function fetchDailyStateForDate(date) {
  if (!date) return null;
  try {
    const { data, error } = await supabase
      .from("daily_state")
      .select("date, cooked")
      .eq("date", date)
      .maybeSingle();
    if (error) { console.warn("Supabase daily_state fetch:", error.message); return null; }
    return data ? { date: data.date, cooked: data.cooked } : null;
  } catch (e) {
    console.warn("Supabase daily_state fetch exception:", e.message);
    return null;
  }
}

// Bulk fetch — pulls every daily_state row for the signed-in user.
// Used by useDailyState's cloud reconcile so the retroactive-
// cookedness UI on AnalysisView's session-detail modal can show + edit
// any past day's value without round-tripping per session.
// Returns an array of { date, cooked } rows, or null on error.
export async function fetchAllDailyStates() {
  try {
    const { data, error } = await supabase
      .from("daily_state")
      .select("date, cooked");
    if (error) { console.warn("Supabase daily_state bulk fetch:", error.message); return null; }
    return (data || []).map(r => ({ date: r.date, cooked: r.cooked }));
  } catch (e) {
    console.warn("Supabase daily_state bulk fetch exception:", e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// USER SETTINGS (cloud-synced preferences)
// ─────────────────────────────────────────────────────────────
// One row per user keyed on auth.uid(). settings is JSONB so new
// keys can be added without schema migrations — see the
// `user_settings` migration for the rationale.

// Fetch the signed-in user's settings object. Returns {} when no
// row exists yet (new user) and null on error. The caller should
// merge with local defaults rather than treating null as empty.
export async function fetchUserSettings() {
  try {
    const { data, error } = await supabase
      .from("user_settings")
      .select("settings")
      .maybeSingle();
    if (error) { console.warn("Supabase settings fetch:", error.message); return null; }
    return data?.settings || {};
  } catch (e) {
    console.warn("Supabase settings fetch exception:", e.message);
    return null;
  }
}

// Upsert the user's settings. The row's user_id defaults from
// auth.uid() via RLS, so we just send the settings object. Patch
// semantics: pass only the keys you want to change; server-side
// uses JSONB || operator? No — Supabase upsert overwrites the
// whole row. Caller should fetch first, merge, then push, or this
// helper can do it. For now we accept the full settings object;
// the App.js layer merges with local cached settings before push.
export async function pushUserSettings(settings) {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user?.id) return false;
    const { error } = await supabase
      .from("user_settings")
      .upsert({
        user_id: user.id,
        settings,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
    if (error) { console.warn("Supabase settings push:", error.message); return false; }
    return true;
  } catch (e) {
    console.warn("Supabase settings push exception:", e.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// REP TOMBSTONE HELPERS (rep_tombstones table)
// ─────────────────────────────────────────────────────────────
// Synced delete tracking. Previously LS_REP_DELETED_KEY was per-device,
// which meant deleting a rep on Device A didn't tell Device B not to
// re-push the same rep on its next reconcile. Result: deletes
// resurrected. The rep_tombstones table is the synced authority.
//
// Schema migration `rep_tombstones` (May 2026) — see migration for
// rationale. Just id + created_at, RLS gated on auth.uid().

// Push N tombstones to cloud in a single batch. Returns true on
// success. ON CONFLICT (id) DO NOTHING server-side, so re-pushing the
// same id is harmless.
export async function pushRepTombstones(ids) {
  const valid = (ids || []).filter(Boolean);
  if (valid.length === 0) return true;
  try {
    const userId = await currentUserId();
    if (!userId) return false;
    const { error } = await supabase
      .from("rep_tombstones")
      .upsert(valid.map(id => ({ id, user_id: userId })), { onConflict: "id" });
    if (error) { console.warn("Supabase tombstone push:", error.message); return false; }
    return true;
  } catch (e) {
    console.warn("Supabase tombstone push exception:", e.message);
    return false;
  }
}

// Fetch every tombstoned id. Used by reconcile to union with the
// local tombstone set before deciding which local reps to push.
// Returns null on error so the caller can fall back to local-only
// dedup rather than risk re-pushing.
export async function fetchRepTombstoneIds() {
  try {
    const { data, error } = await supabase
      .from("rep_tombstones")
      .select("id");
    if (error) { console.warn("Supabase tombstone fetch:", error.message); return null; }
    return (data || []).map(r => r.id).filter(Boolean);
  } catch (e) {
    console.warn("Supabase tombstone fetch exception:", e.message);
    return null;
  }
}

// Slot-based tombstones (companion to rep_tombstones).
// Id-based tombstones only catch re-pushes that re-use the same UUID.
// Old clients running the broken pushRep(.insert) path get fresh
// server-assigned UUIDs that aren't in the id table — so the
// resurrection slips through. The slot table tracks the workout-slot
// identity (session_id, set_num, rep_num, hand) which is stable
// across re-pushes regardless of id, closing that last gap.

// Build the workout-slot key string used as the local cache key
// for slot tombstones in LS. Same shape as the reconcile dedup
// compositeKey so the two sets unify cleanly.
export const repSlotKey = (r) =>
  `${r.session_id || r.date}|${r.set_num}|${r.rep_num}|${r.hand}`;

// Push N slot tombstones to cloud. Each row is the workout-slot
// tuple. ON CONFLICT DO NOTHING server-side (composite PK).
export async function pushRepSlotTombstones(slots) {
  const valid = (slots || []).filter(s =>
    s && s.session_id && s.set_num != null && s.rep_num != null && s.hand
  );
  if (valid.length === 0) return true;
  try {
    const userId = await currentUserId();
    if (!userId) return false;
    const { error } = await supabase
      .from("rep_slot_tombstones")
      .upsert(valid.map(s => ({
        user_id:    userId,
        session_id: s.session_id,
        set_num:    s.set_num,
        rep_num:    s.rep_num,
        hand:       s.hand,
      })), { onConflict: "user_id,session_id,set_num,rep_num,hand" });
    if (error) { console.warn("Supabase slot tombstone push:", error.message); return false; }
    return true;
  } catch (e) {
    console.warn("Supabase slot tombstone push exception:", e.message);
    return false;
  }
}

// Fetch every slot tombstone. Returns an array of slot-key strings
// (built via repSlotKey) for cheap Set-membership checks. Null on
// error so callers can fall back to id-only dedup.
export async function fetchRepSlotTombstoneKeys() {
  try {
    const { data, error } = await supabase
      .from("rep_slot_tombstones")
      .select("session_id, set_num, rep_num, hand");
    if (error) { console.warn("Supabase slot tombstone fetch:", error.message); return null; }
    return (data || []).map(repSlotKey);
  } catch (e) {
    console.warn("Supabase slot tombstone fetch exception:", e.message);
    return null;
  }
}

// Session-level tombstones: nuke an entire bad session_id regardless
// of id, slot, or hand. Catches the case where an old-bundle client
// keeps re-pushing legacy data with fresh server-assigned UUIDs into
// slots we didn't pre-tombstone. The server trigger enforces at the
// DB level; this fetch lets the client filter local data + the
// reconcile push list to match.
export async function fetchSessionTombstoneIds() {
  try {
    const { data, error } = await supabase
      .from("session_tombstones")
      .select("session_id");
    if (error) { console.warn("Supabase session tombstone fetch:", error.message); return null; }
    return (data || []).map(r => r.session_id).filter(Boolean);
  } catch (e) {
    console.warn("Supabase session tombstone fetch exception:", e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// ACTIVITY HELPERS (activities table)
// ─────────────────────────────────────────────────────────────
// Climbing log entries (and any future activity types) live here.
// id is the client-generated uid() string, so upsert(onConflict: id)
// replaces an entry on its origin device after edits without
// duplicating across devices. Same-id collisions across devices
// resolve to last-writer-wins, which is fine for this domain
// (climb entries don't get edited; if they do, the latest write
// is the right answer).

export async function pushActivity(act) {
  if (!act?.id) return false;
  try {
    const userId = await currentUserId();
    if (!userId) return false;
    const { error } = await supabase.from("activities").upsert({
      id:         act.id,
      user_id:    userId,
      type:       act.type ?? "climbing",
      date:       act.date,
      discipline: act.discipline ?? null,
      venue:      act.venue      ?? null,
      grade:      act.grade      ?? null,
      ascent:     act.ascent     ?? null,
      wall:       act.wall       ?? null,
      // Outdoor metadata — null on indoor climbs so cleared edits
      // (e.g. switching outdoor → indoor) actually clear the column.
      route_name: act.route_name ?? null,
      crag:       act.crag       ?? null,
      area:       act.area       ?? null,
      rpe:         Number.isFinite(act.rpe) ? act.rpe : null,
      session_rpe: Number.isFinite(act.session_rpe) ? act.session_rpe : null,
      // 1–5 star rating for climb quality (optional). Migration:
      // activities_add_stars_and_notes (May 2026). Null clears the
      // column on edit; sane-bounded server-side via CHECK constraint.
      stars: Number.isFinite(act.stars) && act.stars >= 1 && act.stars <= 5
        ? Math.round(act.stars) : null,
      // Free-text notes (optional). Empty string normalized to null
      // so deleted notes actually clear the column rather than leaving
      // a sticky "" that disagrees with the local LS shape.
      notes: typeof act.notes === "string" && act.notes.trim().length > 0
        ? act.notes.trim() : null,
    }, { onConflict: "id" });
    if (error) { console.warn("Supabase activity push:", error.message); return false; }
    return true;
  } catch (e) {
    console.warn("Supabase activity push exception:", e.message);
    return false;
  }
}

export async function deleteActivityCloud(id) {
  if (!id) return false;
  try {
    // Tombstone first, then delete — see deleteWorkoutSession for the
    // ordering rationale. Without the synced tombstone, every other
    // device that still holds this activity locally re-pushes it on
    // its next reconcile backfill ("local-only entry" by id), making
    // delete-resurrection deterministic, not rare.
    await pushActivityTombstones([id]);
    const { error } = await supabase.from("activities").delete().eq("id", id);
    if (error) { console.warn("Supabase activity delete:", error.message); return false; }
    return true;
  } catch (e) {
    console.warn("Supabase activity delete exception:", e.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// ACTIVITY TOMBSTONES (activity_tombstones table)
// ─────────────────────────────────────────────────────────────
// Synced delete tracking for climbing-log entries / 1RM logs —
// mirrors rep_tombstones. Table created June 2026: (user_id,
// activity_id) PK, RLS gated on auth.uid().

export async function pushActivityTombstones(ids) {
  const valid = (ids || []).filter(Boolean);
  if (valid.length === 0) return true;
  try {
    const userId = await currentUserId();
    if (!userId) return false;
    const { error } = await supabase
      .from("activity_tombstones")
      .upsert(valid.map(id => ({ user_id: userId, activity_id: id })),
        { onConflict: "user_id,activity_id" });
    if (error) { console.warn("Supabase activity tombstone push:", error.message); return false; }
    return true;
  } catch (e) {
    console.warn("Supabase activity tombstone push exception:", e.message);
    return false;
  }
}

// Returns null on error so callers skip tombstone filtering rather
// than treating "fetch failed" as "nothing is deleted".
export async function fetchActivityTombstoneIds() {
  try {
    const { data, error } = await supabase
      .from("activity_tombstones")
      .select("activity_id");
    if (error) { console.warn("Supabase activity tombstone fetch:", error.message); return null; }
    return (data || []).map(r => r.activity_id).filter(Boolean);
  } catch (e) {
    console.warn("Supabase activity tombstone fetch exception:", e.message);
    return null;
  }
}

export async function fetchActivities() {
  try {
    const { data, error } = await supabase
      .from("activities")
      .select("*")
      .order("date", { ascending: false });
    if (error) { console.warn("Supabase activities fetch:", error.message); return null; }
    return (data || []).map(a => {
      const out = { id: a.id, type: a.type, date: a.date };
      // Only attach optional fields when present so the local shape
      // stays minimal for non-climbing types or older entries.
      if (a.discipline != null) out.discipline = a.discipline;
      if (a.venue      != null) out.venue      = a.venue;
      if (a.grade      != null) out.grade      = a.grade;
      if (a.ascent     != null) out.ascent     = a.ascent;
      if (a.wall       != null) out.wall       = a.wall;
      if (a.route_name != null) out.route_name = a.route_name;
      if (a.crag       != null) out.crag       = a.crag;
      if (a.area       != null) out.area       = a.area;
      if (a.rpe         != null) out.rpe         = a.rpe;
      if (a.session_rpe != null) out.session_rpe = a.session_rpe;
      // stars/notes were pushed by pushActivity but never mapped back
      // here — so on another device they vanished, and a subsequent
      // updateActivity push (which normalizes missing → null) cleared
      // the cloud columns permanently.
      if (a.stars != null) out.stars = a.stars;
      if (a.notes != null) out.notes = a.notes;
      return out;
    });
  } catch (e) {
    console.warn("Supabase activities fetch exception:", e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// BODY-WEIGHT HELPERS (body_weights table)
// ─────────────────────────────────────────────────────────────
// BW lives in two places locally — LS_BW_KEY (scalar current weight,
// what every consumer reads) and LS_BW_LOG_KEY (per-date history
// the trends + per-session-date normalization consume). The cloud
// table is the per-date log; the scalar is derived from the latest
// log entry on boot (see App.js bodyWeight init). Same-day re-logs
// upsert via the UNIQUE date constraint, so logging twice in one
// day overwrites cleanly across devices.

export async function pushBW(date, kg) {
  if (!date || !(kg > 0)) return false;
  try {
    const userId = await currentUserId();
    if (!userId) return false;
    const { error } = await supabase.from("body_weights").upsert(
      { user_id: userId, date, kg },
      { onConflict: "user_id,date" }
    );
    if (error) { console.warn("Supabase BW push:", error.message); return false; }
    return true;
  } catch (e) {
    console.warn("Supabase BW push exception:", e.message);
    return false;
  }
}

// Delete a single BW entry by date. Mirrors deleteActivityCloud /
// deleteWorkoutSession. Returns true on success. Caller is responsible
// for removing the matching local entry from LS_BW_LOG_KEY too — these
// helpers don't touch localStorage.
export async function deleteBW(date) {
  if (!date) return false;
  try {
    // Tombstone first — without it, any other device whose
    // LS_BW_LOG_KEY still holds this date re-pushes it on its next
    // reconcile backfill ("local-only date"), resurrecting the delete.
    await pushBWTombstones([date]);
    const { error } = await supabase.from("body_weights").delete().eq("date", date);
    if (error) { console.warn("Supabase BW delete:", error.message); return false; }
    return true;
  } catch (e) {
    console.warn("Supabase BW delete exception:", e.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// BW TOMBSTONES (bw_tombstones table)
// ─────────────────────────────────────────────────────────────
// Synced delete tracking for body-weight entries, keyed by date —
// mirrors rep_tombstones. Table created June 2026: (user_id, date)
// PK, RLS gated on auth.uid().

export async function pushBWTombstones(dates) {
  const valid = (dates || []).filter(Boolean);
  if (valid.length === 0) return true;
  try {
    const userId = await currentUserId();
    if (!userId) return false;
    const { error } = await supabase
      .from("bw_tombstones")
      .upsert(valid.map(date => ({ user_id: userId, date })),
        { onConflict: "user_id,date" });
    if (error) { console.warn("Supabase BW tombstone push:", error.message); return false; }
    return true;
  } catch (e) {
    console.warn("Supabase BW tombstone push exception:", e.message);
    return false;
  }
}

// Returns null on error so callers skip tombstone filtering rather
// than treating "fetch failed" as "nothing is deleted".
export async function fetchBWTombstoneDates() {
  try {
    const { data, error } = await supabase
      .from("bw_tombstones")
      .select("date");
    if (error) { console.warn("Supabase BW tombstone fetch:", error.message); return null; }
    return (data || []).map(r => r.date).filter(Boolean);
  } catch (e) {
    console.warn("Supabase BW tombstone fetch exception:", e.message);
    return null;
  }
}

// Returns array of { date, kg } sorted ascending by date, or null on
// error. Shape matches the local LS_BW_LOG_KEY contents so the merge
// path can union the two and dedupe by date trivially.
export async function fetchBWLog() {
  try {
    const { data, error } = await supabase
      .from("body_weights")
      .select("date, kg")
      .order("date", { ascending: true });
    if (error) { console.warn("Supabase BW fetch:", error.message); return null; }
    return (data || [])
      .filter(r => r?.date && Number(r.kg) > 0)
      .map(r => ({ date: r.date, kg: Number(r.kg) }));
  } catch (e) {
    console.warn("Supabase BW fetch exception:", e.message);
    return null;
  }
}

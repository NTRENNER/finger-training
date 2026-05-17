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
// `perceived_rpe` is the session-level "how cooked do you feel today"
// scalar (1-10) the user dials on the PrescribedLoadCard slider. Same
// value is stamped onto every rep in the session. Null when the
// slider was left at fresh (1) — those reps don't carry a learning
// signal for perceivedFatigueLearning.computePersonalGains.
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
//     target_duration integer, weight_kg real, actual_time_s real,
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

// ─────────────────────────────────────────────────────────────
// WORKOUT-SESSION HELPERS (workout_sessions table)
// ─────────────────────────────────────────────────────────────

export async function pushWorkoutSession(session) {
  try {
    const { error } = await supabase.from("workout_sessions").upsert({
      id:               session.id,
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
    sessionNumber:   s.session_number,
    // Carry was_recommended through. Null/undefined means "legacy or
    // pre-column row" — WorkoutTab's rotation derivation treats !== false
    // as a positive, so unknowns advance the rotation. Only an explicit
    // false suppresses advancement.
    wasRecommended:  s.was_recommended ?? undefined,
    exercises:       s.exercises || {},
  }));
}

export async function deleteWorkoutSession(id) {
  try {
    const { error } = await supabase.from("workout_sessions").delete().eq("id", id);
    if (error) { console.warn("Supabase workout delete:", error.message); return false; }
    return true;
  } catch (e) {
    console.warn("Supabase workout delete exception:", e.message);
    return false;
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
export function repPayload(rep) {
  return {
    // Only included when present so legacy reps without ids still go
    // through .insert-style path (Postgres assigns UUID). Modern reps
    // always carry one, so upsert(onConflict: "id") deduplicates.
    ...(rep.id ? { id: rep.id } : {}),
    date: rep.date, grip: rep.grip, hand: rep.hand,
    target_duration: rep.target_duration, weight_kg: rep.weight_kg,
    actual_time_s: rep.actual_time_s, avg_force_kg: rep.avg_force_kg,
    peak_force_kg: rep.peak_force_kg ?? 0,
    set_num: rep.set_num, rep_num: rep.rep_num,
    rest_s: rep.rest_s, session_id: rep.session_id,
    failed: rep.failed ?? false,
    session_started_at: rep.session_started_at ?? null,
    // Session-level perceived fatigue (1-10) when the user dialed
    // the PrescribedLoadCard slider. Null when fresh — those reps
    // don't carry a learning signal for perceivedFatigueLearning.
    perceived_rpe: rep.perceived_rpe ?? null,
  };
}

// Returns true on success, false on failure (caller should queue the rep).
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
export async function pushRep(rep) {
  try {
    const { error } = await supabase
      .from("reps")
      .upsert([repPayload(rep)], { onConflict: "session_id,set_num,rep_num,hand" });
    if (error) { console.warn("Supabase push:", error.message); return false; }
    return true;
  } catch (e) {
    console.warn("Supabase push exception:", e.message);
    return false;
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

// Attempt to push every queued rep; remove each one on success.
// Returns the count successfully flushed so the caller can show a
// "synced N pending reps" toast.
//
// Honors the synced tombstone set: a queued rep whose id has been
// tombstoned (deleted on this or another device since being queued)
// gets dropped from the queue silently. Without this check the queue
// would re-resurrect deleted reps the same way the May 2026 reconcile
// bug did — both push paths need the same gate.
export async function flushQueue() {
  const q = loadLS(LS_QUEUE_KEY) || [];
  if (q.length === 0) return 0;
  const cloudTombstones = await fetchRepTombstoneIds();
  const tombstoned = new Set([
    ...(loadLS(LS_REP_DELETED_KEY) || []),
    ...(cloudTombstones || []),
  ]);
  let remaining = [...q];
  let flushed = 0;
  let dropped = 0;
  for (const rep of q) {
    // Skip tombstoned reps; treat them as "successfully processed"
    // for queue-cleanup purposes (drop from queue, don't retry).
    if (rep.id && tombstoned.has(rep.id)) {
      remaining = remaining.filter(r => r.id !== rep.id);
      dropped++;
      continue;
    }
    const ok = await pushRep(rep);
    if (ok) {
      remaining = remaining.filter(r => r.id !== rep.id);
      flushed++;
    }
  }
  saveLS(LS_QUEUE_KEY, remaining);
  if (dropped > 0) console.info(`flushQueue: dropped ${dropped} tombstoned rep(s) from queue`);
  return flushed;
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
    weight_kg: Number(r.weight_kg) || 0,
    actual_time_s: Number(r.actual_time_s) || 0,
    avg_force_kg: Number(r.avg_force_kg) || 0,
    peak_force_kg: Number(r.peak_force_kg) || 0,
    set_num: Number(r.set_num) || 1,
    rep_num: Number(r.rep_num) || 1,
    rest_s: Number(r.rest_s) || 20,
    session_id: r.session_id ?? "",
    failed: r.failed ?? false,
    session_started_at: r.session_started_at ?? null,
    // Null for legacy rows / sessions where the user didn't dial the
    // RPE slider. Numbers > 1 carry a learning signal.
    perceived_rpe: r.perceived_rpe ?? null,
  }));
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
    const { error } = await supabase
      .from("rep_tombstones")
      .upsert(valid.map(id => ({ id })), { onConflict: "id" });
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
    const { error } = await supabase
      .from("rep_slot_tombstones")
      .upsert(valid.map(s => ({
        session_id: s.session_id,
        set_num:    s.set_num,
        rep_num:    s.rep_num,
        hand:       s.hand,
      })), { onConflict: "session_id,set_num,rep_num,hand" });
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
    const { error } = await supabase.from("activities").upsert({
      id:         act.id,
      type:       act.type ?? "climbing",
      date:       act.date,
      discipline: act.discipline ?? null,
      venue:      act.venue      ?? null,
      grade:      act.grade      ?? null,
      ascent:     act.ascent     ?? null,
      wall:       act.wall       ?? null,
      rpe:         Number.isFinite(act.rpe) ? act.rpe : null,
      session_rpe: Number.isFinite(act.session_rpe) ? act.session_rpe : null,
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
    const { error } = await supabase.from("activities").delete().eq("id", id);
    if (error) { console.warn("Supabase activity delete:", error.message); return false; }
    return true;
  } catch (e) {
    console.warn("Supabase activity delete exception:", e.message);
    return false;
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
      if (a.rpe         != null) out.rpe         = a.rpe;
      if (a.session_rpe != null) out.session_rpe = a.session_rpe;
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
    const { error } = await supabase.from("body_weights").upsert(
      { date, kg },
      { onConflict: "date" }
    );
    if (error) { console.warn("Supabase BW push:", error.message); return false; }
    return true;
  } catch (e) {
    console.warn("Supabase BW push exception:", e.message);
    return false;
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

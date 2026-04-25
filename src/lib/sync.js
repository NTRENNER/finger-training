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

import { supabase } from "./supabase.js";
import { loadLS, saveLS } from "./storage.js";
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
export function repPayload(rep) {
  return {
    date: rep.date, grip: rep.grip, hand: rep.hand,
    target_duration: rep.target_duration, weight_kg: rep.weight_kg,
    actual_time_s: rep.actual_time_s, avg_force_kg: rep.avg_force_kg,
    peak_force_kg: rep.peak_force_kg ?? 0,
    set_num: rep.set_num, rep_num: rep.rep_num,
    rest_s: rep.rest_s, session_id: rep.session_id,
    failed: rep.failed ?? false,
    session_started_at: rep.session_started_at ?? null,
  };
}

// Returns true on success, false on failure (caller should queue the rep).
export async function pushRep(rep) {
  try {
    const { error } = await supabase.from("reps").insert([repPayload(rep)]);
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
export async function flushQueue() {
  const q = loadLS(LS_QUEUE_KEY) || [];
  if (q.length === 0) return 0;
  let remaining = [...q];
  let flushed = 0;
  for (const rep of q) {
    const ok = await pushRep(rep);
    if (ok) {
      remaining = remaining.filter(r => r.id !== rep.id);
      flushed++;
    }
  }
  saveLS(LS_QUEUE_KEY, remaining);
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
  }));
}

// ─────────────────────────────────────────────────────────────
// SHARED UTILITIES
// ─────────────────────────────────────────────────────────────
// Pure JS helpers used by both the model layer and React views.
// No React or DOM dependencies — keep it that way so the model
// modules can import these without pulling React along.

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Local-date YYYY-MM-DD. toISOString() converts to UTC, which dated
// evening reps to "tomorrow" for users west of UTC (e.g. a 22:00
// Pacific rep would land on the next day's row, breaking the
// "this session was today" check used by recency-aware helpers
// (e.g. coaching.js's recencyFactor).
export const ymdLocal = (d = new Date()) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

export const today = () => ymdLocal();

// Short random id for local-only entities (activities, workout
// sessions, session_id keys). Not a UUID — just enough collision
// resistance for in-flight client state.
export const uid = () => Math.random().toString(36).slice(2, 10);

// Client-side UUID for rows whose id must round-trip to Supabase
// (reps). The cloud `reps.id` column is uuid; if the local id isn't
// a real UUID, pushRep re-stamps a different one into the cloud
// payload and every later id-based update/delete from this device
// silently matches 0 rows (the "edit a just-logged rep is lost"
// bug, June 2026). Fallback builds a v4-shaped string for
// environments without crypto.randomUUID.
export const uuid = () => {
  try { return crypto.randomUUID(); } catch {
    return `${Date.now().toString(16).padStart(8, "0").slice(-8)}-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`;
  }
};

// Wall-clock timestamp on rows that need a created-at column
// (rep.session_started_at, workout session.completedAt, etc.).
export const nowISO = () => new Date().toISOString();

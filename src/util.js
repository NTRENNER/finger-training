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
// "this session was today" check in computeReadiness and friends).
export const ymdLocal = (d = new Date()) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

export const today = () => ymdLocal();

// Short random id for local-only entities (reps, activities,
// workout sessions). Not a UUID — Supabase assigns its own
// uuid on insert; this is just enough collision resistance for
// in-flight client state.
export const uid = () => Math.random().toString(36).slice(2, 10);

// Wall-clock timestamp on rows that need a created-at column
// (rep.session_started_at, workout session.completedAt, etc.).
export const nowISO = () => new Date().toISOString();

// ─────────────────────────────────────────────────────────────
// TRIP / TARGET-DATE HELPERS
// ─────────────────────────────────────────────────────────────
// User-configurable target date (e.g. a climbing trip). Drives the
// countdown displayed in the Workout tab and the Settings tab. The
// model is intentionally training-philosophy-agnostic: it reports
// weeks/days remaining and a fixed 7-day taper window. It does NOT
// impose linear Build/Push/Peak/Taper blocks since those don't fit
// conjugate-style programming.

// Default trip used when no user setting is stored.
export const DEFAULT_TRIP = { date: "2026-08-22", name: "Tensleep" };

// Parse a "YYYY-MM-DD" trip date string. Returns null for empty/invalid input.
export function parseTripDate(tripDateStr) {
  if (!tripDateStr) return null;
  const d = new Date(tripDateStr + "T00:00:00");
  return isNaN(d) ? null : d;
}

// Weeks remaining until the trip date (rounded up, floored at 0).
export function weeksToTrip(tripDateStr) {
  const trip = parseTripDate(tripDateStr);
  if (!trip) return 0;
  return Math.max(0, Math.ceil((trip - new Date()) / (7 * 24 * 60 * 60 * 1000)));
}

// Trip countdown info — model-agnostic.
// Returns null for invalid/empty input. Returns { trip, days, weeks,
// tripLabel, taperLabel, inTaper, past } where:
//   trip       — the parsed Date object
//   days       — calendar days remaining (negative if past)
//   weeks      — Math.ceil(days/7), floored at 0
//   tripLabel  — short month-day string for the trip date
//   taperLabel — short month-day string for "1 week before trip"
//   inTaper    — true if the trip is within the next 7 days
//   past       — true if the trip date is in the past
export function tripCountdown(tripDateStr) {
  const trip = parseTripDate(tripDateStr);
  if (!trip) return null;
  const now = new Date();
  const msPerDay = 24 * 60 * 60 * 1000;
  const days = Math.ceil((trip - now) / msPerDay);
  const weeks = Math.max(0, Math.ceil(days / 7));
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const fmt = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const taperStart = addDays(trip, -7);
  return {
    trip,
    days,
    weeks,
    tripLabel: fmt(trip),
    taperLabel: fmt(taperStart),
    inTaper: days <= 7 && days >= 0,
    past: days < 0,
  };
}

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

// Body-weight log: [{ date: "YYYY-MM-DD", kg: number }]
export const LS_BW_LOG_KEY = "ft_bw_log";

// Strength-workout log: [{ id, date, workout, exercises: { [id]: { sets: [...] } } }]
export const LS_WORKOUT_LOG_KEY = "ft_workout_log";

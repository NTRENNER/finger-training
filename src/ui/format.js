// ─────────────────────────────────────────────────────────────
// DISPLAY FORMATTERS
// ─────────────────────────────────────────────────────────────
// Number / unit / time formatters used everywhere in the UI. Pure
// functions — no React. Kept separate from src/util.js (which holds
// model-layer helpers like clamp / today / ymdLocal) because these
// are display-layer concerns.

// kg → lbs conversion factor.
export const KG_TO_LBS = 2.20462;

// One-decimal number formatter; "—" for non-finite.
export const fmt1 = (n) =>
  (typeof n === "number" && isFinite(n)) ? n.toFixed(1) : "—";

// Integer formatter; "—" for non-finite.
export const fmt0 = (n) =>
  (typeof n === "number" && isFinite(n)) ? String(Math.round(n)) : "—";

// Convert a stored kg value into the display unit (kg or lbs).
export const toDisp = (kg, unit) =>
  (unit === "lbs" && typeof kg === "number") ? kg * KG_TO_LBS : kg;

// Convert a display-unit value (kg or lbs) back to kg for storage.
export const fromDisp = (val, unit) =>
  (unit === "lbs" && typeof val === "number") ? val / KG_TO_LBS : val;

// Format a kg value for display in the current unit (kg or lbs),
// rounded to one decimal.
export const fmtW = (kg, unit) => fmt1(toDisp(kg, unit));

// Bodyweight-relative force ratio — THE canonical helper (June 2026
// audit). BW-relative math was hand-rolled at several call sites in
// two correct-but-different styles (kg ÷ kg in some, display-unit ÷
// display-unit in others). Both reduce to the same unitless ratio,
// but mixing styles is exactly how a units bug slips in. Always pass
// KG for both arguments; the result is unitless (force as a fraction
// of bodyweight) so it never needs unit conversion. Returns null for
// unusable inputs so callers can render "—".
export const forceOverBW = (forceKg, bodyWeightKg) =>
  (forceKg > 0 && bodyWeightKg > 0) ? forceKg / bodyWeightKg : null;

// Format seconds as M:SS for ≥60s, or "<n>s" for <60s. "—" for invalid.
export const fmtTime = (s) => {
  if (!isFinite(s) || s < 0) return "—";
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m > 0 ? `${m}:${String(sec).padStart(2, "0")}` : `${Math.floor(s)}s`;
};

// Format an ISO timestamp as a localized clock time ("hh:mm AM/PM").
// Returns "" on invalid input rather than throwing.
export const fmtClock = (iso) => {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return "";
  }
};

// Return the most recent body-weight log entry on or before `date`
// (YYYY-MM-DD), or null. Used to attach a same-or-prior BW reading
// to historical session rows.
export const bwOnDate = (bwLog, date) => {
  const candidates = (bwLog || []).filter(e => e.date <= date);
  return candidates.length ? candidates[candidates.length - 1] : null;
};

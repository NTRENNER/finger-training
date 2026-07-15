// ──────────────────────────────────────────────────────────────
// TENDON PROTOCOL  (Abrahangs — Keith Baar minimal effective dose)
// ──────────────────────────────────────────────────────────────
// A deliberately SEPARATE, low-load adjunct to the muscular reps
// model. Submaximal isometric holds for connective-tissue robustness,
// NOT strength — nothing here touches the reps table or the F-D fit.
// The app only records "did the session happen"; no load/force.
//
// Two selectable presets, and the hold/rest seconds are editable, so
// you can slide between "more like Emil" (many short 10s holds) and
// "more like Keith's actual protocol" (fewer 30s holds). Baar's data
// says the molecular response is intensity/frequency-independent and
// caps around ~10 min of loading, so total time under tension is what
// matters — both presets sit comfortably under that ceiling.

const EMIL_GRIPS = [
  { name: "4-finger crimp",         detail: "14mm edge",               sets: 3 },
  { name: "3-finger drag",          detail: "deep pocket",             sets: 3 },
  { name: "Middle 2-finger pocket", detail: "",                        sets: 1 },
  { name: "Front 2-finger pocket",  detail: "",                        sets: 1 },
  { name: "Middle 2-finger crimp",  detail: "stretch pinkies on rest", sets: 1 },
  { name: "Front 2-finger crimp",   detail: "",                        sets: 1 },
];

// Barr's clinical block is grip-agnostic (30s holds, ~40%, 4–5 reps).
// Expressed here as a compact multi-grip set so it still rotates
// tissues the way climbing wants: 5 x 30s.
const BARR_GRIPS = [
  { name: "Half-crimp",    detail: "", sets: 2 },
  { name: "Open-hand",     detail: "", sets: 2 },
  { name: "3-finger drag", detail: "", sets: 1 },
];

export const TENDON_PRESETS = [
  {
    key: "abrahangs-emil", name: "Emil", subtitle: "6 grips · 10s holds",
    workSec: 10, restSec: 50, effortPct: 40, grips: EMIL_GRIPS,
  },
  {
    key: "barr", name: "Barr", subtitle: "30s holds · fewer reps",
    workSec: 30, restSec: 60, effortPct: 40, grips: BARR_GRIPS,
  },
];

export const DEFAULT_PRESET_KEY = "abrahangs-emil";
// Back-compat default export (Emil) for callers that predate presets.
export const TENDON_PRESET = TENDON_PRESETS[0];

export function getPreset(key) {
  return TENDON_PRESETS.find(p => p.key === key) || TENDON_PRESETS[0];
}

// Merge user time overrides { workSec, restSec, effortPct } onto a base
// preset. Overrides are clamped to sane bounds so a fat-fingered value
// can't produce a 9,000-second hold.
export function resolvePreset(baseKey, overrides = {}) {
  const base = getPreset(baseKey);
  const clamp = (v, lo, hi, dflt) =>
    Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : dflt;
  return {
    ...base,
    workSec:   clamp(overrides.workSec, 3, 120, base.workSec),
    restSec:   clamp(overrides.restSec, 5, 300, base.restSec),
    effortPct: clamp(overrides.effortPct, 10, 90, base.effortPct),
  };
}

// Expand the grip list into the flat sequence of hang intervals the
// timer steps through.
export function buildIntervals(preset = TENDON_PRESET) {
  const out = [];
  for (const g of preset.grips) {
    const n = g.sets || 1;
    for (let s = 1; s <= n; s++) {
      out.push({
        grip: g.name, detail: g.detail || "",
        set: s, ofSets: n,
        effortPct: preset.effortPct,
        workSec: preset.workSec, restSec: preset.restSec,
      });
    }
  }
  return out;
}

export const totalSets = (p = TENDON_PRESET) =>
  p.grips.reduce((a, g) => a + (g.sets || 1), 0);

export const totalWorkSeconds = (p = TENDON_PRESET) =>
  totalSets(p) * p.workSec;

// ymd string N days before todayStr (local calendar math).
function ymdMinus(todayStr, n) {
  const d = new Date(`${todayStr}T00:00:00`);
  d.setDate(d.getDate() - n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Adherence summary from a list of session rows ({ date }).
export function tendonAdherence(sessions, todayStr, goalPerWeek = 3) {
  const dates = new Set((sessions || []).map(s => s && s.date).filter(Boolean));
  const last7 = [];
  let weekCount = 0;
  for (let i = 6; i >= 0; i--) {
    const ds = ymdMinus(todayStr, i);
    const done = dates.has(ds);
    last7.push({ date: ds, done });
    if (done) weekCount++;
  }
  let streak = 0;
  for (let i = 0; i < 400; i++) {
    if (dates.has(ymdMinus(todayStr, i))) streak++;
    else break;
  }
  return {
    last7, weekCount, goalPerWeek,
    onTrack: weekCount >= goalPerWeek,
    streak, total: dates.size,
  };
}

// Display name for a preset key (History list, session records).
export function presetName(key) {
  return (TENDON_PRESETS.find(p => p.key === key) || {}).name || key || "Tendon";
}

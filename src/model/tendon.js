// ──────────────────────────────────────────────────────────────
// TENDON HEALTH PROTOCOL  (Abrahangs — after Keith Baar's work)
// ──────────────────────────────────────────────────────────────
// A deliberately SEPARATE, low-load adjunct to the muscular reps model.
// Nothing here touches the reps table or F-D fit; the app records
// completion + an effort cue, not measured force.
//
// Keith Baar's low-load isometric work is the gold standard for tendon
// adaptation in general (~40% of max, longer holds, high frequency);
// the finger application here is an extrapolation of that work, not
// finger-specific evidence. Both presets stay low-load and no-failure.
// Editable bounds stay in the 10–30s hold range and cap effort at 50%
// so an old saved override can't turn the adjunct into near-max training.

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
    workSec:   clamp(overrides.workSec, 10, 30, base.workSec),
    restSec:   clamp(overrides.restSec, 5, 300, base.restSec),
    effortPct: clamp(overrides.effortPct, 10, 50, base.effortPct),
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

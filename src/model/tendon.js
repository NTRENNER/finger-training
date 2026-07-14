// ──────────────────────────────────────────────────────────────
// TENDON PROTOCOL  (Abrahangs — Keith Baar minimal effective dose)
// ──────────────────────────────────────────────────────────────
// A deliberately SEPARATE, low-load adjunct to the muscular reps
// model. These are submaximal isometric holds for connective-tissue
// robustness (collagen synthesis / matrix remodeling), NOT strength
// work — so nothing here touches the reps table or the F-D curve fit.
// The app only records "did the session happen"; no load/force.
//
// Preset = Emil Abrahamsson's 6-grip routine, whole cloth (10s on /
// 50s off, 3+3+1+1+1+1 = 10 sets), with a single flat ~40%-of-max
// effort cue on every grip (per Nathan's call — Baar's data says the
// molecular response is intensity/frequency-independent, so total
// time under tension is what matters, ~100s here, well under the
// ~10-min refractory ceiling).

export const TENDON_PRESET = {
  key: "abrahangs-emil",
  name: "Abrahangs",
  subtitle: "6-grip tendon protocol",
  workSec: 10,
  restSec: 50,
  effortPct: 40, // flat recommendation for EVERY grip; no failure
  grips: [
    { name: "4-finger crimp",         detail: "14mm edge",               sets: 3 },
    { name: "3-finger drag",          detail: "deep pocket",             sets: 3 },
    { name: "Middle 2-finger pocket", detail: "",                        sets: 1 },
    { name: "Front 2-finger pocket",  detail: "",                        sets: 1 },
    { name: "Middle 2-finger crimp",  detail: "stretch pinkies on rest", sets: 1 },
    { name: "Front 2-finger crimp",   detail: "",                        sets: 1 },
  ],
};

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

// Adherence summary from a list of session rows ({ date }): the last 7
// days (oldest→newest) with a done flag, count this week vs goal, the
// current consecutive-day streak, and lifetime distinct-day total.
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

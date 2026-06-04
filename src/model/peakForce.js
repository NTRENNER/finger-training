// ─────────────────────────────────────────────────────────────
// PEAK FORCE TREND — max-strength trajectory over time
// ─────────────────────────────────────────────────────────────
// The F-D curve is built on SUSTAINED holds, so it underrepresents true
// max strength (its T→0 max is an extrapolation, and a long hold never
// samples peak recruitment). peak_force_kg, captured per rep, is a
// DIRECT measurement of instantaneous max force — the cleanest, least
// confounded strength metric in the app: no fit, and it honestly rises
// as you get stronger.
//
// Caveat baked into the design: peak only means "near-MVC" when the rep
// was a short, hard effort FROM a max-effort session. Two filters enforce
// that, and BOTH are needed:
//   1. actual_time_s ≤ PEAK_NEAR_MAX_T — the rep itself was short.
//   2. target_duration ≤ PEAK_MAX_PROTOCOL_T — the rep came from a
//      max/power protocol (5–10s targets), not an endurance block.
// Filter (1) alone is not enough: on a long endurance session (e.g. a
// 160s-target hold) the LATE reps fail in under 15s purely from fatigue,
// not because the load was maximal — their peak force is low (you're
// exhausted), so they plot as spurious "max strength dropped to 28 lbs"
// dips. Those are fatigue failures, not max tests. Gating on the
// protocol's target duration drops whole endurance sessions while
// keeping every rep of a real max session (including ramp-up reps, which
// can out-pull rep 1 — so we must NOT filter by rep position here).
// Per grip, best peak per session date, plus a running best-to-date PR.
//
// Pure functions; no React. Tested in isolation.

export const PEAK_NEAR_MAX_T = 15;        // s — rep duration at/under this ≈ MVC window
export const PEAK_MAX_PROTOCOL_T = 12;    // s — target_duration at/under this = max/power block
const PEAK_MAX_KG = 500;                  // sanity ceiling (matches load.js)

// Build the per-grip peak-force time series.
// Returns:
//   {
//     grips: string[],                         // grips with ≥1 near-max peak
//     rows:  [{ date, [grip]: kg, [grip]_pr: kg }],  // per-session best + running PR
//     best:  { [grip]: { kg, date } },         // all-time best near-max peak
//     latest:{ [grip]: { kg, date } },         // most recent session best
//   }
// or null when no grip has usable peak data.
export function buildPeakForceTrend(history, {
  nearMaxT = PEAK_NEAR_MAX_T,
  maxProtocolT = PEAK_MAX_PROTOCOL_T,
} = {}) {
  if (!Array.isArray(history) || history.length === 0) return null;

  // grip -> Map<date, bestPeakKg> over near-max reps only.
  const byGrip = {};
  for (const r of history) {
    if (!r || !r.grip || !r.date) continue;
    const peak = Number(r.peak_force_kg);
    if (!(peak > 0 && peak < PEAK_MAX_KG)) continue;
    const t = Number(r.actual_time_s);
    if (!(t > 0 && t <= nearMaxT)) continue;       // near-max efforts only
    // Max/power protocol only — drop endurance-session reps whose short
    // duration is fatigue, not maximal load. Missing target_duration
    // (legacy/manual rows) is kept: we can't prove it was endurance.
    const tgt = Number(r.target_duration);
    if (Number.isFinite(tgt) && tgt > maxProtocolT) continue;
    if (!byGrip[r.grip]) byGrip[r.grip] = new Map();
    const cur = byGrip[r.grip].get(r.date) || 0;
    if (peak > cur) byGrip[r.grip].set(r.date, peak);
  }

  const grips = Object.keys(byGrip).filter(g => byGrip[g].size > 0).sort();
  if (grips.length === 0) return null;

  // First (earliest) session best per grip — the baseline for "% since".
  const firstBest = {};
  for (const g of grips) {
    const earliest = [...byGrip[g].keys()].sort()[0];
    firstBest[g] = byGrip[g].get(earliest);
  }

  const allDates = [...new Set(grips.flatMap(g => [...byGrip[g].keys()]))].sort();
  const best = {};
  const latest = {};
  // Per-grip min/max for a ZOOMED axis — both grips share one chart and
  // Crusher (~170 lb) vs Micro (~24 lb) on a single 0-based axis makes a
  // real climb look flat; each grip gets its own domain instead.
  const domain = {};
  const runningPr = Object.fromEntries(grips.map(g => [g, 0]));

  const rows = allDates.map(date => {
    const row = { date };
    for (const g of grips) {
      const v = byGrip[g].get(date);
      if (v != null) {
        row[g] = Math.round(v * 10) / 10;
        if (v > runningPr[g]) runningPr[g] = v;
        latest[g] = { kg: row[g], date };
        if (!best[g] || v > best[g].kg) best[g] = { kg: row[g], date };
        const d = domain[g] || { min: v, max: v };
        domain[g] = { min: Math.min(d.min, v), max: Math.max(d.max, v) };
      } else {
        row[g] = null;  // no near-max sample that day → gap (recharts skips)
      }
      row[`${g}_pr`] = runningPr[g] > 0 ? Math.round(runningPr[g] * 10) / 10 : null;
    }
    return row;
  });

  // % climb in your max (best-ever vs first session) per grip.
  const changePct = {};
  for (const g of grips) {
    changePct[g] = firstBest[g] > 0
      ? Math.round((best[g].kg / firstBest[g] - 1) * 100)
      : null;
  }

  return { grips, rows, best, latest, firstBest, changePct, domain };
}

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
// Caveat baked into the design: a peak is only a MAX measurement when you
// were actually trying to hit a high. Peak force is instantaneous and
// neuromuscular — a hard 2-second pull registers your true max just as
// well as a 7-second one — so the REP's duration is NOT the right filter.
// What matters is INTENT, and the protocol encodes it: a short-target
// max/power block (5–10s) is a max effort; a long endurance hold is a
// sub-max load held to failure, where the peak is low because you weren't
// reaching for a high (and late reps in such a session fail early from
// fatigue at low force). So the single filter is:
//   target_duration ≤ PEAK_MAX_PROTOCOL_T  → max/power session only.
// We take the best peak from ANY rep in those sessions, regardless of how
// long the rep lasted or its position in the set (ramp-up reps can
// out-pull rep 1). Per grip, best peak per session date, plus a running
// best-to-date PR.
//
// Pure functions; no React. Tested in isolation.

export const PEAK_MAX_PROTOCOL_T = 12;    // s — target_duration at/under this = max/power block
const PEAK_MAX_KG = 500;                  // sanity ceiling (matches load.js)

// Build the per-grip peak-force time series.
// Returns:
//   {
//     grips: string[],                         // grips with peak data (incl. provisional)
//     provisional: { [grip]: true },           // grips with NO max/power session yet —
//                                              //   series built from sub-max-session peaks,
//                                              //   which UNDERSTATE true max (see below)
//     rows:  [{ date, [grip]: kg, [grip]_pr: kg }],  // per-session best + running PR
//     best:  { [grip]: { kg, date } },         // all-time best peak (per its series)
//     latest:{ [grip]: { kg, date } },         // most recent session best
//   }
// or null when no grip has usable peak data.
//
// PROVISIONAL GRIPS (June 2026): a new grip's first sessions are
// mid-duration (cold-start seeding), so it can train for weeks before
// its first max/power day — and was invisible here the whole time.
// Rather than hide it or silently mix sub-max peaks into the real
// series, grips without any qualifying max-protocol peak get included
// under a `provisional` flag: the card renders them visually distinct
// and withholds the % badge (a % over sub-max pulls is noise). The
// moment a real max/power session lands, the grip flips to the
// qualified series automatically and the provisional history is
// dropped (it would understate the baseline).
export function buildPeakForceTrend(history, {
  maxProtocolT = PEAK_MAX_PROTOCOL_T,
} = {}) {
  if (!Array.isArray(history) || history.length === 0) return null;

  // grip -> Map<date, bestPeakKg>, split into qualified (max/power-
  // protocol reps) and unqualified (any protocol — provisional source).
  const byGrip = {};
  const anyByGrip = {};
  for (const r of history) {
    if (!r || !r.grip || !r.date) continue;
    const peak = Number(r.peak_force_kg);
    if (!(peak > 0 && peak < PEAK_MAX_KG)) continue;
    const put = (map) => {
      if (!map[r.grip]) map[r.grip] = new Map();
      const cur = map[r.grip].get(r.date) || 0;
      if (peak > cur) map[r.grip].set(r.date, peak);
    };
    put(anyByGrip);
    // Max/power protocol only — exclude endurance sessions (sub-max load,
    // peak not a max attempt). Rep duration is intentionally NOT filtered:
    // peak force is instantaneous, so a hard short pull is a valid max
    // sample. Missing target_duration (legacy/manual rows) is kept: we
    // can't prove it was endurance.
    const tgt = Number(r.target_duration);
    if (Number.isFinite(tgt) && tgt > maxProtocolT) continue;
    put(byGrip);
  }

  // Provisional: peaks exist, but none from a max/power session.
  const provisional = {};
  for (const g of Object.keys(anyByGrip)) {
    if (!byGrip[g] || byGrip[g].size === 0) {
      byGrip[g] = anyByGrip[g];
      provisional[g] = true;
    }
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
  // Provisional grips get null — a % computed over sub-max pulls
  // measures protocol variation, not strength change.
  const changePct = {};
  for (const g of grips) {
    changePct[g] = (!provisional[g] && firstBest[g] > 0)
      ? Math.round((best[g].kg / firstBest[g] - 1) * 100)
      : null;
  }

  return { grips, provisional, rows, best, latest, firstBest, changePct, domain };
}

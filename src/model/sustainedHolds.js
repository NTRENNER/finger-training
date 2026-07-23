// ─────────────────────────────────────────────────────────────
// SUSTAINED HOLDS — measured long-hold capacity, per grip
// ─────────────────────────────────────────────────────────────
// Backs the Analysis tab's "Sustained vs max" card (July 2026, per
// Nathan). The card previously plotted the three-exp curve's modeled
// F(240s) against the measured max — but the modeled tail inherits
// the curve's overall amplitude (a max gain lifts the extrapolated
// 240s value through the fit's prior/shrinkage even with zero
// endurance change), which made the ratio partially self-referential.
// Same structural critique that retired the original F(180)/F(5)
// Endurance Ceiling card in May 2026. This helper replaces the
// modeled numerator with DEMONSTRATED capacity: loads actually held
// for a long time, no model in the loop.
//
// A "sustained hold" is a rep that makes a measured claim:
//   • actual_time_s ≥ minHoldS (default SUSTAINED_MIN_S = 120 — the
//     endurance-zone boundary; below that a hold is strength work,
//     not sustained capacity)
//   • isMeasuredLoadRep (Tindeq avg_force_kg present). Manual/spring
//     entries are NOMINAL loads the user pulls against — and with a
//     spring, deliberately over-pulls — so they can't back a
//     "you actually sustained F for T" claim. Same measured-only rule
//     as the demonstrated-capacity floor (see load.js).
//   • not a seed artifact (avg == peak signature, load.js)
//   • ANY rep number qualifies — a 120s hold on rep 2 demonstrates
//     capacity just as hard (harder, if anything). These are lower
//     bounds, and a lower bound is valid however it was produced.
//
// Output keeps one point per (grip, date): the heaviest qualifying
// hold that day (ties → longer hold). A cooked-evening success still
// counts — a lower bound demonstrated while cooked is still a lower
// bound on fresh capacity.
//
// Pure function of history; no store access, no Date.now().

import { sane, isMeasuredLoadRep, isSeedArtifactRep } from "./load.js";

export const SUSTAINED_MIN_S  = 120;  // s — endurance-zone boundary
export const SUSTAINED_RECENT_D = 90; // d — ratio reads the best hold this recent

// buildSustainedHolds(history, { minHoldS, hand }) → {
//   grips: {
//     Crusher: {
//       holds: [{ date, loadKg, holdS }, …]   // best-per-date, ascending
//       longestHoldS: 222,                    // longest measured hold ANY duration/load
//     }, …                                    // only grips with ≥1 qualifying hold
//   },
//   quiet: ["Prime"],                         // grips with measured reps but no qualifying hold
// }
export function buildSustainedHolds(history = [], opts = {}) {
  const { minHoldS = SUSTAINED_MIN_S, hand = null } = opts;
  const measured = (history || []).filter(r =>
    r && r.date && r.grip &&
    (!hand || r.hand === hand) &&
    Number(r.actual_time_s) > 0 &&
    isMeasuredLoadRep(r) &&
    !isSeedArtifactRep(r)
  );

  const grips = {};
  const longest = {};   // grip → longest measured hold of any duration
  for (const r of measured) {
    const t = Number(r.actual_time_s);
    longest[r.grip] = Math.max(longest[r.grip] || 0, t);
    if (t < minHoldS) continue;
    const loadKg = sane(r.avg_force_kg);
    if (loadKg == null) continue;
    const g = (grips[r.grip] = grips[r.grip] || new Map());  // date → {loadKg, holdS}
    const prev = g.get(r.date);
    if (!prev || loadKg > prev.loadKg || (loadKg === prev.loadKg && t > prev.holdS)) {
      g.set(r.date, { loadKg, holdS: Math.round(t) });
    }
  }

  const out = { grips: {}, quiet: [] };
  for (const grip of Object.keys(longest).sort()) {
    const g = grips[grip];
    if (!g || g.size === 0) {
      out.quiet.push(grip);
      continue;
    }
    out.grips[grip] = {
      holds: [...g.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, v]) => ({ date, ...v })),
      longestHoldS: Math.round(longest[grip]),
    };
  }
  return out;
}

// Best (heaviest) hold on/after fromDate. holds = ascending array from
// buildSustainedHolds. Returns { date, loadKg, holdS } or null.
export function bestHoldSince(holds, fromDate) {
  let best = null;
  for (const h of holds || []) {
    if (fromDate && h.date < fromDate) continue;
    if (!best || h.loadKg > best.loadKg) best = h;
  }
  return best;
}

// Last (most recent) hold regardless of window — the fallback the card
// annotates with staleness when nothing lands inside SUSTAINED_RECENT_D.
export function lastHold(holds) {
  return holds && holds.length ? holds[holds.length - 1] : null;
}

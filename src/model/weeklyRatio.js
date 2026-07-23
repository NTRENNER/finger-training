// ─────────────────────────────────────────────────────────────
// WEEKLY MEAN ACTUAL/TARGET RATIO  (per grip, per hand)
// ─────────────────────────────────────────────────────────────
// Feeds the Analysis tab's "Weekly hold ratio" chart (July 2026, per
// Nathan). Motivated by the scheduled coach's month-over-month line
// ("mean actual/target ratio climbed 0.85 → 1.04 (L)…") — this makes
// the SAME metric visible continuously, week by week, instead of only
// as a two-point comparison in prose.
//
// Metric: for every timed finger rep with a real target and a real
// load, ratio = actual_time_s / target_duration. 1.0 = held exactly
// to target; above = outlasting targets (curve amplitude lifting);
// below = targets winning. Bucketed by Monday-start weekKey; the
// "all" mode is exactly the check-in perf signal's estimator
// (weeklyReview.gatherCheckInSignals), just weekly instead of a
// 28-day window.
//
// Rep filter mirrors weeklyReview's ratioReps:
//   • actual_time_s > 0        (a timed rep actually happened)
//   • target_duration > 0      (there was a prescription to compare to)
//   • effectiveLoad(r) > 0     (loaded work, not a free hang / warmup)
//
// TWO MODES (repsMode option), because the two answer different
// questions — validated on Nathan's real export before shipping:
//   • "openers" (DEFAULT): rep 1 of set 1 only — the fresh rep, the
//     same cleanest-signal rep the β learner and the ladder's re-pin
//     guard read. Weekly means sit meaningfully around 1.0 and move
//     with capacity (mid-June Crusher surge 1.5-1.9×, the late-June
//     over-pull crash to 0.79, the 7/20 endurance miss at 0.45).
//   • "all": every qualifying rep — same estimator as the check-in's
//     perf signal. But density-ladder reps 2+ fall short of target BY
//     DESIGN (short rests), so this mean is dragged toward 0.3-0.6 in
//     high-rep weeks and mostly measures protocol mix, not capacity.
//     Kept as a toggle so the chart can reproduce the check-in's
//     number, not as the default read.
//
// "openers" requires rep_num === 1 AND set_num === 1; rows without
// set/rep numbering are excluded from openers mode (they still count
// in "all"). Every row in the real dataset carries both fields.
//
// Output covers EVERY calendar week from the first training week to
// the last — quiet weeks appear as gaps (null means), so the x-axis
// is honest about time and a 3-week break doesn't get compressed into
// one tick. Consumers connect across nulls if they want an unbroken
// trend line.
//
// Pure function of history; no store access, no Date.now().

import { weekKey } from "../lib/climbing-grades.js";
import { effectiveLoad } from "./load.js";

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// buildWeeklyRatio(history, { repsMode: "openers" | "all" }) → {
//   grips: ["Crusher", "Micro", ...]          // sorted, only grips with ≥1 qualifying rep
//   weeks: [{
//     week: "2026-07-13",                     // Monday of the week
//     byGrip: {
//       Crusher: {
//         mean: 0.97, n: 12,                  // all qualifying reps that week
//         hands: { L: { mean: 1.04, n: 6 }, R: { mean: 0.91, n: 6 } },
//       },
//       …                                     // only grips with reps THAT week
//     },
//   }, …]                                     // every week first→last, ascending
// }
export function buildWeeklyRatio(history = [], opts = {}) {
  const { repsMode = "openers" } = opts;
  const reps = (history || []).filter(
    (r) =>
      r &&
      r.date &&
      r.grip &&
      Number(r.actual_time_s) > 0 &&
      Number(r.target_duration) > 0 &&
      effectiveLoad(r) > 0 &&
      (repsMode !== "openers" || (Number(r.rep_num) === 1 && Number(r.set_num) === 1))
  );
  if (!reps.length) return { grips: [], weeks: [] };

  // Bucket ratios by (week, grip, hand).
  const buckets = new Map(); // week → grip → { all: [], L: [], R: [] }
  for (const r of reps) {
    const wk = weekKey(r.date);
    if (!buckets.has(wk)) buckets.set(wk, new Map());
    const byGrip = buckets.get(wk);
    if (!byGrip.has(r.grip)) byGrip.set(r.grip, { all: [], L: [], R: [] });
    const b = byGrip.get(r.grip);
    const ratio = Number(r.actual_time_s) / Number(r.target_duration);
    b.all.push(ratio);
    if (r.hand === "L" || r.hand === "R") b[r.hand].push(ratio);
  }

  const grips = [...new Set(reps.map((r) => r.grip))].sort();

  // Walk every calendar week from first to last so gaps stay visible.
  const weekKeys = [...buckets.keys()].sort();
  const first = weekKeys[0];
  const last = weekKeys[weekKeys.length - 1];
  const weeks = [];
  for (let wk = first; wk <= last; wk = addDays(wk, 7)) {
    const byGripRaw = buckets.get(wk);
    const byGrip = {};
    if (byGripRaw) {
      for (const [g, b] of byGripRaw) {
        byGrip[g] = {
          mean: round2(mean(b.all)),
          n: b.all.length,
          hands: {
            L: { mean: round2(mean(b.L)), n: b.L.length },
            R: { mean: round2(mean(b.R)), n: b.R.length },
          },
        };
      }
    }
    weeks.push({ week: wk, byGrip });
  }
  return { grips, weeks };
}

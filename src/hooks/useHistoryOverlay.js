// ─────────────────────────────────────────────────────────────
// useHistoryOverlay — Force Curves overlay + Strength Balance history
// ─────────────────────────────────────────────────────────────
// Extracted from AnalysisView.js (late May 2026 BACKLOG #156, third
// pass). Bundles the two memos that back the "Force Curves — vs
// baseline" overlay card and the Strength Balance card's personal-
// baseline history.
//
// Why one hook for both: `balanceHistory` derives entirely from
// `historyOverlay` (specifically the Crusher and Micro per-hand
// cumulative fits). Keeping them in one hook means the consumer
// doesn't have to pass historyOverlay around as an intermediate
// prop, and the memoization boundary stays where it was — each
// useMemo only re-runs when its own deps change.
//
// Output shape:
//   {
//     historyOverlay: {
//       [grip]: {
//         baselineAmps,         // pooled grip baseline (from gripBaselines)
//         baselineDate,
//         dates: string[],      // post-baseline session dates with a fit
//         ampsByDate: Map<date, amps>,  // pooled cumulative fits
//         perHand: {
//           [hand]: { baselineAmps, baselineDate, ampsByDate: Map<date, amps> },
//         },
//       },
//     },
//     balanceHistory: {
//       [hand]: { current, median, count, delta },  // Crusher/Micro ratio @ 10s
//     } | null,
//   }

import { useMemo } from "react";
import { fitAmpsForPts } from "../model/baselines.js";
import { predForceThreeExp } from "../model/threeExp.js";

export function useHistoryOverlay({
  history,
  grips,
  gripBaselines,
  perHandGripBaselines,
  threeExpPriors,
}) {
  // ── Force Curves History overlay data ──
  // For each grip with a baseline AND ≥1 post-baseline fitable date,
  // expose: the baseline amps (anchored, same as gripBaselines so
  // this card agrees with Capacity % and Curve Improvement) plus
  // a sorted post-baseline date list with cumulative amps per date.
  //
  // Cumulative fits use the same `up-to-date` logic as the AUC
  // history chart so the "Now" curve moves forward in time
  // monotonically as more reps come in.
  //
  // Why anchor on gripBaselines instead of "first fitable date":
  // gripBaselines requires ≥5 reps spanning ≥3 distinct target
  // durations, which avoids the degenerate single-duration window
  // fit. Using "first fitable date" (≥3 cumulative reps) often gave
  // a baseline fit on 3–4 long-hold-only reps, which extrapolates
  // wildly at short T and made the deltas disagree with Curve
  // Improvement by 10%+ in either direction.
  const historyOverlay = useMemo(() => {
    const byGrip = {};   // grip -> { baselineAmps, baselineDate, dates: [], ampsByDate: Map<date, [a,b,c]> }
    for (const g of grips) {
      const baseline = gripBaselines[g];
      if (!baseline?.amps) continue;     // no baseline → can't anchor
      const gripReps = (history || []).filter(r =>
        r.grip === g &&
        r.avg_force_kg > 0 && r.avg_force_kg < 500 && r.actual_time_s > 0
      );
      if (gripReps.length < 3) continue;
      // Restrict the Now slider to dates AT or AFTER the baseline
      // date. Earlier dates produce a partial cumulative fit that
      // would compare a single-duration window against the well-
      // constrained baseline — apples-to-oranges deltas.
      const datesSet = new Set();
      for (const r of gripReps) {
        if (r.date && r.date >= baseline.date) datesSet.add(r.date);
      }
      const allDates = [...datesSet].sort();
      const ampsByDate = new Map();
      const validDates = [];
      for (const date of allDates) {
        const upTo = gripReps.filter(r => (r.date || "") <= date);
        if (upTo.length < 3) continue;
        const amps = fitAmpsForPts(
          upTo.map(r => ({ T: r.actual_time_s, F: r.avg_force_kg })),
          g,
          threeExpPriors,
        );
        if (!amps) continue;
        ampsByDate.set(date, amps);
        validDates.push(date);
      }
      if (validDates.length === 0) continue;

      // Per-hand fits. For each hand with its own qualifying baseline
      // (≥5 reps × ≥3 distinct durations from perHandGripBaselines),
      // compute the cumulative hand-only fit at each pooled-valid
      // date. Date entries where the hand doesn't have enough
      // samples-up-to-that-date are skipped (handByDate just lacks
      // that key); the render gracefully drops the line in that
      // case.
      const perHand = {};
      for (const hand of ["L", "R"]) {
        const handBaseline = perHandGripBaselines[`${g}|${hand}`];
        if (!handBaseline?.amps) continue;
        const handReps = gripReps.filter(r => r.hand === hand);
        const handByDate = new Map();
        for (const date of validDates) {
          const upToHand = handReps.filter(r => (r.date || "") <= date);
          // 2 is enough for a per-hand fit because the grip prior
          // shrinks small-N runs (same gate as gripHandFits).
          if (upToHand.length < 2) continue;
          const amps = fitAmpsForPts(
            upToHand.map(r => ({ T: r.actual_time_s, F: r.avg_force_kg })),
            g,
            threeExpPriors,
          );
          if (amps) handByDate.set(date, amps);
        }
        perHand[hand] = {
          baselineAmps: handBaseline.amps,
          baselineDate: handBaseline.date,
          ampsByDate: handByDate,
        };
      }

      byGrip[g] = {
        baselineAmps: baseline.amps,
        baselineDate: baseline.date,
        dates: validDates,
        ampsByDate,
        perHand,    // { L?: {...}, R?: {...} } — empty when no per-hand baselines
      };
    }
    return byGrip;
  // fitAmpsForPts closes over threeExpPriors; explicit dep here keeps
  // memo honest. eslint can't see through the closure.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, grips, gripBaselines, perHandGripBaselines, threeExpPriors]);

  // ── Open-hand vs Crimp dominance — personal-baseline calibration ──
  // Per-hand Crusher:Micro ratio time series, plus the user's own
  // median ratio (the "personal baseline"). The Strength Balance
  // card classifies the CURRENT ratio by its deviation from the
  // user's median, NOT against literature-anchored absolute bands.
  // Anchoring on the user's own ratio sidesteps the edge-geometry
  // problem: a very small Tindeq Micro implement pushes everyone's
  // natural ratio higher than typical-edge literature suggests, so
  // a 3.0× baseline is "your normal" for that gear — and the
  // actionable signal is whether you're drifting down (FDS catching
  // up) or up (gap widening) from YOUR normal, not from some
  // external benchmark.
  //
  // Requires per-hand cumulative fits for BOTH Crusher and Micro on
  // each date (intersection of the two grips' historyOverlay dates).
  // Returns null when fewer than 1 shared date exists; the card
  // gracefully falls back to a no-badge raw-ratio display below.
  const balanceHistory = useMemo(() => {
    const cOverlay = historyOverlay.Crusher;
    const mOverlay = historyOverlay.Micro;
    if (!cOverlay || !mOverlay) return null;
    const BAL_T = 10;
    const out = {};
    for (const hand of ["L", "R"]) {
      const cHand = cOverlay.perHand?.[hand];
      const mHand = mOverlay.perHand?.[hand];
      if (!cHand || !mHand) continue;
      const sharedDates = [...cHand.ampsByDate.keys()]
        .filter(d => mHand.ampsByDate.has(d))
        .sort();
      if (sharedDates.length === 0) continue;
      const ratios = sharedDates.map(date => {
        const cF = predForceThreeExp(cHand.ampsByDate.get(date), BAL_T);
        const mF = predForceThreeExp(mHand.ampsByDate.get(date), BAL_T);
        return cF > 0 && mF > 0 ? cF / mF : null;
      }).filter(r => r != null);
      if (ratios.length === 0) continue;
      // Personal baseline = median (robust to outlier sessions —
      // a bad-form Micro day shouldn't move your "normal" much).
      const sorted = [...ratios].sort((a, b) => a - b);
      const mid = sorted.length / 2;
      const median = sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[Math.floor(mid)];
      out[hand] = {
        current: ratios[ratios.length - 1],
        median,
        count: ratios.length,
        delta: median > 0 ? (ratios[ratios.length - 1] - median) / median : null,
      };
    }
    return Object.keys(out).length > 0 ? out : null;
  }, [historyOverlay]);

  return { historyOverlay, balanceHistory };
}

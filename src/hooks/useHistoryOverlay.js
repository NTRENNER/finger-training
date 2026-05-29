// ─────────────────────────────────────────────────────────────
// useHistoryOverlay — Force Curves "vs baseline" overlay history
// ─────────────────────────────────────────────────────────────
// Extracted from AnalysisView.js (late May 2026 BACKLOG #156, third
// pass). Builds the cumulative per-grip / per-hand three-exp fits by
// date that back the "Force Curves — vs baseline" overlay card.
//
// (Previously also produced `balanceHistory` for the Strength Balance
// card; both were removed May 2026 — the Crusher:Micro ratio was
// edge-geometry-dominated, not a trainable balance.)
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
//   }

import { useMemo } from "react";
import { fitAmpsForPts } from "../model/baselines.js";
import { effectiveLoad } from "../model/load.js";

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
        effectiveLoad(r) > 0 && r.actual_time_s > 0
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
          upTo.map(r => ({ T: r.actual_time_s, F: effectiveLoad(r) })),
          g,
          threeExpPriors,
        );
        if (!amps) continue;
        ampsByDate.set(date, amps);
        validDates.push(date);
      }
      if (validDates.length === 0) continue;
      // The cumulative fit AT the baseline date can drift from the
      // baseline fit itself because gripBaselines' seed window may
      // extend past baseline.date (the window closes when ≥5 reps ×
      // ≥3 durations is hit, which can land on a later date), while
      // this loop only sees reps with date <= baseline.date. Different
      // fit on a subset of points → small non-zero deltas at the
      // slider's leftmost position even though Now and Baseline are
      // by definition the same point. Override to baseline.amps so
      // the leftmost slider position renders an honest 0% across
      // every reference time. Sign of the drift wasn't systematic —
      // Crusher leaked +5%, Micro leaked −5% — so the fix needs to
      // be a hard clamp, not a heuristic.
      if (ampsByDate.has(baseline.date)) {
        ampsByDate.set(baseline.date, baseline.amps);
      }

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
            upToHand.map(r => ({ T: r.actual_time_s, F: effectiveLoad(r) })),
            g,
            threeExpPriors,
          );
          if (amps) handByDate.set(date, amps);
        }
        // Same Now=Baseline clamp as the pooled path above —
        // perHandGripBaselines' seed window can extend past
        // handBaseline.date, so the cumulative subset fit drifts
        // unless we override at the slider's leftmost position.
        if (handByDate.has(handBaseline.date)) {
          handByDate.set(handBaseline.date, handBaseline.amps);
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

  // (Open-hand vs Crimp dominance / balanceHistory — the per-hand
  // Crusher:Micro ratio time series — removed May 2026 along with the
  // Strength Balance card it fed. The ratio was dominated by the Micro
  // probe's much smaller edge geometry rather than trainable strength
  // balance, so it sat ~constant against the user's own median and
  // carried no actionable signal. Per-grip progress is visible on the
  // Curve-Improvement trajectory.)

  return { historyOverlay };
}

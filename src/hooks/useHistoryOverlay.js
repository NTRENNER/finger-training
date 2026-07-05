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
//         baselineMaxHoldS,     // longest real hold in the baseline window
//         dates: string[],      // post-baseline session dates with a fit
//         ampsByDate: Map<date, amps>,  // pooled cumulative fits
//         perHand: {
//           [hand]: { baselineAmps, baselineDate, baselineMaxHoldS, ampsByDate: Map<date, amps> },
//         },
//       },
//     },
//   }

import { useMemo } from "react";
import { fitAmpsForPts } from "../model/baselines.js";
import { buildThreeExpPriors } from "../model/threeExp.js";
import { effectiveLoad, freshFitReps } from "../model/load.js";

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
    // Leak-free prior cache: prior built from data on/before a given date.
    // Reused across the pooled + per-hand loops so we fit it once per date.
    // The whole-history prior pulls early cumulative fits up toward current
    // strength, so the "Now" curve sat ~+22% above baseline even at the
    // leftmost slider position; a per-date prior keeps each slider position
    // an honest "where I was then". Same fix as the baseline + Capacity %.
    const priorCache = new Map();
    const priorsAt = (date) => {
      if (!priorCache.has(date)) priorCache.set(date, buildThreeExpPriors(history, { upTo: date }));
      return priorCache.get(date);
    };
    for (const g of grips) {
      const baseline = gripBaselines[g];
      if (!baseline?.amps) continue;     // no baseline → can't anchor
      // Fresh + de-duped so the overlay's "now" curve is fit the same
      // way as the baseline / Curve-Improvement / Capacity cards — without
      // this the overlay used raw all-reps and disagreed (e.g. -1% vs +26%).
      const gripReps = freshFitReps(history).filter(r =>
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
      // Cumulative longest hold in the data up to each date. Used by
      // the per-zone baseline: a zone the pooled baseline never reached
      // gets anchored to the earliest date whose data first reached that
      // duration (see perZoneBaselineAmps), so long-hold zones show a
      // real Δ% instead of "new" once you've trained them.
      const maxHoldByDate = new Map();
      const validDates = [];
      for (const date of allDates) {
        const upTo = gripReps.filter(r => (r.date || "") <= date);
        if (upTo.length < 3) continue;
        const leakPrior = priorsAt(date);
        const amps = fitAmpsForPts(
          upTo.map(r => ({ T: r.actual_time_s, F: effectiveLoad(r) })),
          g,
          leakPrior.has(g) ? leakPrior : threeExpPriors,
        );
        if (!amps) continue;
        ampsByDate.set(date, amps);
        maxHoldByDate.set(date, upTo.reduce((m, r) => Math.max(m, r.actual_time_s || 0), 0));
        validDates.push(date);
      }
      if (validDates.length === 0) continue;
      // Anchor the LEFTMOST slider position to the baseline curve so the
      // "Now" line overlaps the dashed baseline at ~0% when slid fully
      // left. We clamp validDates[0] (the first post-baseline date that's
      // actually a slider stop) rather than baseline.date — the baseline
      // date is often NOT a slider stop (its session may have a single
      // fresh rep that can't meet the ≥3-rep fit gate alone), so the old
      // date===baseline.date clamp silently never fired and the leftmost
      // position read +22% instead of 0%.
      ampsByDate.set(validDates[0], baseline.amps);

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
        let firstHandDate = null;
        for (const date of validDates) {
          const upToHand = handReps.filter(r => (r.date || "") <= date);
          // 2 is enough for a per-hand fit because the grip prior
          // shrinks small-N runs (same gate as gripHandFits).
          if (upToHand.length < 2) continue;
          const leakPrior = priorsAt(date);
          const amps = fitAmpsForPts(
            upToHand.map(r => ({ T: r.actual_time_s, F: effectiveLoad(r) })),
            g,
            leakPrior.has(g) ? leakPrior : threeExpPriors,
          );
          if (amps) {
            handByDate.set(date, amps);
            if (!firstHandDate) firstHandDate = date;
          }
        }
        // Anchor the leftmost per-hand slider position to the hand
        // baseline (same reasoning as the pooled path). The hand's first
        // fittable date is often later than handBaseline.date and isn't
        // handBaseline.date itself, so a date===handBaseline.date clamp
        // wouldn't fire — clamp the first actual hand date instead.
        if (firstHandDate) handByDate.set(firstHandDate, handBaseline.amps);
        perHand[hand] = {
          baselineAmps: handBaseline.amps,
          baselineDate: handBaseline.date,
          baselineMaxHoldS: handBaseline.maxHoldS ?? null,
          ampsByDate: handByDate,
        };
      }

      byGrip[g] = {
        baselineAmps: baseline.amps,
        baselineDate: baseline.date,
        baselineMaxHoldS: baseline.maxHoldS ?? null,
        dates: validDates,
        ampsByDate,
        maxHoldByDate,
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

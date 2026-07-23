// ─────────────────────────────────────────────────────────────
// useCapacityHistoryByGrip — per-grip whole-curve capacity trajectory
// ─────────────────────────────────────────────────────────────
// Extracted from AnalysisView.js (late May 2026 BACKLOG #156, partial
// pass). Builds the per-grip "Curve Improvement %" trajectory that
// the CapacityTrajectoryCard renders.
//
// Why a hook (vs. a model helper): the computation memoizes against
// React state (history, threeExpPriors, gripBaselines, bwLog) and
// returns a shape tightly coupled to chart-row rendering. Keeping the
// memoization at the hook boundary lets AnalysisView's JSX read a
// single dependency-free value instead of inlining the useMemo with
// its 5-arg dep array.
//
// Output shape:
//   {
//     grips: string[],         // ordered grip ids present in the data
//     pctRows: { date, [grip]_pct, [grip]_pct_sm }[],  // raw % vs baseline + smoothed
//     pctRowsBW: { date, [grip]_pct, [grip]_pct_sm }[],  // BW-normalized
//     hasPct: boolean,         // any grip has a baseline?
//   }
//   or null when not enough data to render anything.

import { useMemo } from "react";
import { bwOnDate } from "../ui/format.js";
import { computeBalancedCurveScore, buildThreeExpPriors } from "../model/threeExp.js";
import { fitAmpsForPts } from "../model/baselines.js";
import { effectiveLoad, freshFitReps } from "../model/load.js";

export function useCapacityHistoryByGrip({
  history,
  grips,
  gripBaselines,
  threeExpPriors,
  bwLog,
  // Hand scoping (June 2026, analysis hand selector): when `hand` is
  // "L"/"R", the trajectory runs on that hand's fresh reps and the
  // baseline comes from perHandBaselines (`${grip}|${hand}` keys —
  // the FROZEN per-hand pins from useGripFits). Null = pooled, the
  // original behavior, byte for byte.
  hand = null,
  perHandBaselines = null,
}) {
  return useMemo(() => {
    // Per-grip date-keyed map of balanced capacity scores.
    // We compute BOTH the raw % and the BW-normalized % in one pass
    // and let the render pick which to show based on normalizeOn —
    // toggling the pill should not retrigger the expensive curve fits.
    //
    // BW-normalized math: dividing both numerator and denominator by
    // their respective BWs gives
    //   pct_bw = (score/sessionBW) / (baseScore/baseBW) − 1
    //          = (score/baseScore) × (baseBW/sessionBW) − 1
    // which collapses to pct_raw whenever sessionBW == baseBW.
    const perGrip = {};            // grip -> Map<date, { pct, pctBW }>
    const baselineByGrip = {};     // grip -> { score, bw }
    const datesUnion = new Set();
    // Leak-free per-date prior cache — same priorsAt pattern as
    // useHistoryOverlay. buildThreeExpPriors returns EVERY grip's
    // prior in one Map, so one date-keyed cache is shared across the
    // whole grip loop. Before July 2026 the prior was rebuilt inside
    // the per-date loop inside the per-grip loop — O(grips × dates ×
    // history) NNLS work on every memo invalidation, all of it
    // recomputing identical results.
    const priorCache = new Map();
    const priorsAt = (date) => {
      if (!priorCache.has(date)) priorCache.set(date, buildThreeExpPriors(history, { upTo: date }));
      return priorCache.get(date);
    };
    for (const g of grips) {
      // Fresh + de-duped — same fit basis as the baseline / overlay /
      // Curve-Improvement cards so the Capacity % agrees with them.
      const gripFails = freshFitReps(history).filter(r =>
        r.grip === g &&
        (!hand || r.hand === hand) &&
        effectiveLoad(r) > 0 && r.actual_time_s > 0
      );
      if (gripFails.length < 3) continue;
      const datesSet = new Set();
      for (const r of gripFails) if (r.date) datesSet.add(r.date);
      const dates = [...datesSet].sort();
      if (dates.length < 2) continue;
      // Baseline score + the BW that prevailed at the baseline date.
      // bwOnDate returns the most-recent-on-or-before entry, so a
      // baseline dated before the first BW log just yields null and
      // pctBW falls back to the raw pct in the render.
      const base = hand
        ? perHandBaselines?.[`${g}|${hand}`]
        : gripBaselines[g];
      if (base?.amps) {
        const baseScore = computeBalancedCurveScore(base.amps);
        const baseBwEntry = base.date ? bwOnDate(bwLog, base.date) : null;
        baselineByGrip[g] = { score: baseScore, bw: baseBwEntry?.kg ?? null };
      }
      const seriesMap = new Map();
      let anchored = false;   // first plotted point is clamped to baseline (0%)
      for (const date of dates) {
        const upToFails = gripFails.filter(r => (r.date || "") <= date);
        if (upToFails.length < 3) continue;
        // LEAK-FREE per-date prior — same principle as the baseline fix.
        // The whole-history prior pulls EARLY cumulative fits up toward
        // current strength, so the trajectory opened well above 0% (e.g.
        // +21% / +30%) instead of starting at the baseline. A prior
        // restricted to data on/before this date keeps each point an
        // honest "where I was then", so the line starts ~0% and climbs to
        // the same endpoint (the last date's prior == whole history).
        const leakPrior = priorsAt(date);
        const priorsForFit = leakPrior.has(g) ? leakPrior : threeExpPriors;
        const amps = fitAmpsForPts(
          upToFails.map(r => ({ T: r.actual_time_s, F: effectiveLoad(r) })),
          g,
          priorsForFit,
        );
        if (!amps) continue;
        // Anchor the FIRST plotted point of each grip to the baseline so
        // the chart opens at exactly 0%. The baseline's own date often
        // isn't a plotted date (e.g. a session whose only fresh rep can't
        // meet the ≥3 gate alone), so the previous date===base.date clamp
        // silently never fired and the line started mid-climb. Clamping
        // the leftmost plotted point is robust to that and to pinned
        // baselines (which don't carry a window-close date).
        const hasBase = baselineByGrip[g]?.score > 0;
        const score = (!anchored && hasBase)
          ? baselineByGrip[g].score
          : computeBalancedCurveScore(amps);
        if (hasBase) anchored = true;
        if (!(score > 0)) continue;
        const baseScore = baselineByGrip[g]?.score;
        const baseBW  = baselineByGrip[g]?.bw;
        const sessionBW = bwOnDate(bwLog, date)?.kg ?? null;
        const pct = baseScore && baseScore > 0
          ? Math.round((score / baseScore - 1) * 100)
          : null;
        const pctBW = (baseScore && baseScore > 0 && baseBW > 0 && sessionBW > 0)
          ? Math.round((score / baseScore * baseBW / sessionBW - 1) * 100)
          : pct;  // fall back to raw pct if any BW is missing
        seriesMap.set(date, { pct, pctBW });
        datesUnion.add(date);
      }
      // Baseline required: this hook feeds the "% vs baseline" card,
      // and a grip with no baseline yet has only null pct values — it
      // would render as a ghost legend entry with no line during the
      // window between its 3rd fresh rep and its baseline seeding
      // (June 2026, observed while waiting for Prime to qualify).
      if (seriesMap.size >= 2 && baselineByGrip[g]?.score > 0) perGrip[g] = seriesMap;
    }
    if (Object.keys(perGrip).length === 0) return null;
    // Per-grip 3-point centered rolling mean over each grip's own
    // ordered session-date series (NOT over the union — gaps between
    // grips' training days should not smear one grip into another's
    // schedule). Endpoints fall back to 2-point means. Grips with <3
    // sessions skip smoothing entirely; their smoothed series stays
    // null so the line simply doesn't render.
    const smoothedByGrip = {};  // grip -> Map<date, { pctSm, pctBWSm }>
    for (const g of Object.keys(perGrip)) {
      const entries = [...perGrip[g].entries()].sort(
        (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
      );
      const sm = new Map();
      const n = entries.length;
      if (n >= 3) {
        for (let i = 0; i < n; i++) {
          const lo = Math.max(0, i - 1);
          const hi = Math.min(n - 1, i + 1);
          let pSum = 0, pCnt = 0, bSum = 0, bCnt = 0;
          for (let j = lo; j <= hi; j++) {
            const v = entries[j][1];
            if (v.pct   != null) { pSum += v.pct;   pCnt++; }
            if (v.pctBW != null) { bSum += v.pctBW; bCnt++; }
          }
          sm.set(entries[i][0], {
            pctSm:   pCnt > 0 ? Math.round(pSum / pCnt) : null,
            pctBWSm: bCnt > 0 ? Math.round(bSum / bCnt) : null,
          });
        }
      }
      smoothedByGrip[g] = sm;
    }
    const dates = [...datesUnion].sort();
    const pctRows = [];
    const pctRowsBW = [];
    for (const date of dates) {
      const pRow = { date };
      const pBwRow = { date };
      for (const g of Object.keys(perGrip)) {
        const v = perGrip[g].get(date);
        const sv = smoothedByGrip[g]?.get(date);
        pRow[`${g}_pct`]      = v ? v.pct   : null;
        pRow[`${g}_pct_sm`]   = sv ? sv.pctSm   : null;
        pBwRow[`${g}_pct`]    = v ? v.pctBW : null;
        pBwRow[`${g}_pct_sm`] = sv ? sv.pctBWSm : null;
      }
      pctRows.push(pRow);
      pctRowsBW.push(pBwRow);
    }
    return {
      grips: Object.keys(perGrip),
      pctRows,
      pctRowsBW,
      hasPct: Object.values(baselineByGrip).some(v => v.score > 0),
    };
  }, [history, grips, gripBaselines, threeExpPriors, bwLog, hand, perHandBaselines]);
}

// ─────────────────────────────────────────────────────────────
// useAucHistoryByGrip — per-grip AUC trajectory builder
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
//     absRows: { date, [grip]_abs }[],         // absolute AUC per date
//     pctRows: { date, [grip]_pct, [grip]_pct_sm }[],  // raw % vs baseline + smoothed
//     pctRowsBW: { date, [grip]_pct, [grip]_pct_sm }[],  // BW-normalized
//     hasPct: boolean,         // any grip has a baseline?
//   }
//   or null when not enough data to render anything.

import { useMemo } from "react";
import { bwOnDate } from "../ui/format.js";
import { computeBalancedCurveScore } from "../model/threeExp.js";
import { fitAmpsForPts } from "../model/baselines.js";
import { effectiveLoad, freshFitReps } from "../model/load.js";

export function useAucHistoryByGrip({
  history,
  grips,
  gripBaselines,
  threeExpPriors,
  bwLog,
}) {
  return useMemo(() => {
    // Per-grip date-keyed map of AUC values (and % vs baseline).
    // We compute BOTH the raw % and the BW-normalized % in one pass
    // and let the render pick which to show based on normalizeOn —
    // toggling the pill should not retrigger the expensive curve fits.
    //
    // BW-normalized math: dividing both numerator and denominator by
    // their respective BWs gives
    //   pct_bw = (abs/sessionBW) / (baseAUC/baseBW) − 1
    //          = (abs/baseAUC) × (baseBW/sessionBW) − 1
    // which collapses to pct_raw whenever sessionBW == baseBW.
    const perGrip = {};            // grip -> Map<date, { abs, pct, pctBW }>
    const baselineByGrip = {};     // grip -> { auc, bw }
    const datesUnion = new Set();
    for (const g of grips) {
      // Fresh + de-duped — same fit basis as the baseline / overlay /
      // Curve-Improvement cards so the Capacity % agrees with them.
      const gripFails = freshFitReps(history).filter(r =>
        r.grip === g &&
        effectiveLoad(r) > 0 && r.actual_time_s > 0
      );
      if (gripFails.length < 3) continue;
      const datesSet = new Set();
      for (const r of gripFails) if (r.date) datesSet.add(r.date);
      const dates = [...datesSet].sort();
      if (dates.length < 2) continue;
      // Baseline AUC + the BW that prevailed at the baseline date.
      // bwOnDate returns the most-recent-on-or-before entry, so a
      // baseline dated before the first BW log just yields null and
      // pctBW falls back to the raw pct in the render.
      const base = gripBaselines[g];
      if (base?.amps) {
        const baseAUC = computeBalancedCurveScore(base.amps);
        const baseBwEntry = base.date ? bwOnDate(bwLog, base.date) : null;
        baselineByGrip[g] = { auc: baseAUC, bw: baseBwEntry?.kg ?? null };
      }
      const seriesMap = new Map();
      for (const date of dates) {
        const upToFails = gripFails.filter(r => (r.date || "") <= date);
        if (upToFails.length < 3) continue;
        const amps = fitAmpsForPts(
          upToFails.map(r => ({ T: r.actual_time_s, F: effectiveLoad(r) })),
          g,
          threeExpPriors,
        );
        if (!amps) continue;
        // At the baseline date itself the cumulative-subset fit drifts
        // from the baseline fit (which uses the full seed window that
        // can extend past base.date). Clamp to baseline AUC so the
        // first plotted point reads exactly 0% — matches the
        // equivalent clamp in useHistoryOverlay. Same issue: sign of
        // the drift wasn't systematic (Crusher leaks +, Micro leaks −),
        // so a hard override is the right fix.
        const isBaselineDate = base?.date && date === base.date;
        const abs = isBaselineDate
          ? baselineByGrip[g]?.auc
          : computeBalancedCurveScore(amps);
        if (!(abs > 0)) continue;
        const baseAUC = baselineByGrip[g]?.auc;
        const baseBW  = baselineByGrip[g]?.bw;
        const sessionBW = bwOnDate(bwLog, date)?.kg ?? null;
        const pct = baseAUC && baseAUC > 0
          ? Math.round((abs / baseAUC - 1) * 100)
          : null;
        const pctBW = (baseAUC && baseAUC > 0 && baseBW > 0 && sessionBW > 0)
          ? Math.round((abs / baseAUC * baseBW / sessionBW - 1) * 100)
          : pct;  // fall back to raw pct if any BW is missing
        seriesMap.set(date, { abs: Math.round(abs), pct, pctBW });
        datesUnion.add(date);
      }
      if (seriesMap.size >= 2) perGrip[g] = seriesMap;
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
    const absRows = [];
    const pctRows = [];
    const pctRowsBW = [];
    for (const date of dates) {
      const aRow = { date };
      const pRow = { date };
      const pBwRow = { date };
      for (const g of Object.keys(perGrip)) {
        const v = perGrip[g].get(date);
        const sv = smoothedByGrip[g]?.get(date);
        aRow[`${g}_abs`]      = v ? v.abs   : null;
        pRow[`${g}_pct`]      = v ? v.pct   : null;
        pRow[`${g}_pct_sm`]   = sv ? sv.pctSm   : null;
        pBwRow[`${g}_pct`]    = v ? v.pctBW : null;
        pBwRow[`${g}_pct_sm`] = sv ? sv.pctBWSm : null;
      }
      absRows.push(aRow);
      pctRows.push(pRow);
      pctRowsBW.push(pBwRow);
    }
    return {
      grips: Object.keys(perGrip),
      absRows,
      pctRows,
      pctRowsBW,
      hasPct: Object.values(baselineByGrip).some(v => v.auc > 0),
    };
  }, [history, grips, gripBaselines, threeExpPriors, bwLog]);
}

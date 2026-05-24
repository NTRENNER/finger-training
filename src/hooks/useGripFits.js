// ─────────────────────────────────────────────────────────────
// useGripFits — per-grip + per-(grip, hand) three-exp derivations
// ─────────────────────────────────────────────────────────────
// Extracted from AnalysisView.js (late May 2026 BACKLOG #156,
// second pass). Bundles the six pure-derivation memos that feed
// the Curve Improvement card, Hand Asymmetry rows, Strength
// Balance card, Force Curves history overlay, and (indirectly via
// gripBaselines) the per-grip AUC trajectory.
//
// Why one hook for six memos: they form a single derivation chain
// over the same inputs (history + threeExpPriors + grips). Each
// useMemo dep array was already deps-on-the-others; bundling them
// into one hook collapses six dependency declarations into one,
// removes the AnalysisView noise, and keeps the memoization
// boundary at the same shape (the hook re-runs only when history
// / threeExpPriors / grips change — same as the inline memos).
//
// What's NOT in here on purpose: `current3xAmps`, `global3xBaseline`,
// `improvement`. Those depend on `failures` which depends on the
// `selGrip` view state, so they live in AnalysisView next to the
// state they read.
//
// Output:
//   {
//     gripBaselines:        { [grip]: { date, amps } },
//     grip3xEstimates:      { [grip]: amps },
//     gripHandFits:         { [grip]: { L?, R?, pooled? } },
//     perHandGripBaselines: { [`${grip}|${hand}`]: { date, amps } },
//     gripImprovement:      { [grip]: { ...zoneDeltas, total, baselineDate } },
//     handAsymmetry:        [{ grip, L, R, stronger, weaker, asymPct }],
//   }

import { useMemo } from "react";
import {
  fitAmpsForPts,
  buildGripBaselines, buildPerHandGripBaselines,
  buildGripEstimates, buildGripImprovement, computeHandAsymmetry,
} from "../model/baselines.js";

export function useGripFits({ history, threeExpPriors, grips }) {
  // Per-grip baselines — earliest 5-rep/3-dur window per grip. The
  // shared anchor for Curve Improvement deltas, the Capacity AUC
  // trajectory % (via useAucHistoryByGrip), and the Force Curves
  // overlay baseline curve. One source of "where each grip started"
  // for the whole page.
  const gripBaselines = useMemo(
    () => buildGripBaselines(history, threeExpPriors),
    [history, threeExpPriors]
  );

  // Per-grip CURRENT amps — the "now" side of the per-grip improvement
  // comparison. Both halves of the Δ% live in the same model so the
  // numbers tie out across surfaces.
  const grip3xEstimates = useMemo(
    () => buildGripEstimates(history, threeExpPriors),
    [history, threeExpPriors]
  );

  // Per-grip × per-hand three-exp fits. Used by the Strength Balance
  // card. Falls back to a pooled fit on the grip when a hand doesn't
  // have enough samples. Doubles as a grip-level "is this grip
  // fitable at all?" gate (≥3 total reps).
  //
  // Not in baselines.js (yet) — the pooled fallback is unique to this
  // consumer. Could be lifted once another card needs it.
  const gripHandFits = useMemo(() => {
    const out = {};
    for (const grip of grips) {
      const gripReps = (history || []).filter(r =>
        r.grip === grip &&
        r.avg_force_kg > 0 && r.avg_force_kg < 500 &&
        r.actual_time_s > 0
      );
      if (gripReps.length < 3) continue;
      const entry = {};
      for (const hand of ["L", "R"]) {
        const pts = gripReps.filter(r => r.hand === hand)
          .map(r => ({ T: r.actual_time_s, F: r.avg_force_kg }));
        if (pts.length >= 2) {
          const amps = fitAmpsForPts(pts, grip, threeExpPriors);
          if (amps) entry[hand] = amps;
        }
      }
      const pooledAmps = fitAmpsForPts(
        gripReps.map(r => ({ T: r.actual_time_s, F: r.avg_force_kg })),
        grip,
        threeExpPriors,
      );
      if (pooledAmps) entry.pooled = pooledAmps;
      if (entry.pooled || entry.L || entry.R) out[grip] = entry;
    }
    return out;
  // fitAmpsForPts closes over threeExpPriors; explicit dep here keeps
  // memo honest. eslint can't see through the closure.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, grips, threeExpPriors]);

  // Per-(grip, hand) baselines — same seed gate as gripBaselines but
  // scoped to a single hand on a single grip. Used by the per-hand
  // baseline scoping logic in the Curve Improvement card and the
  // per-hand mode of the Force Curves overlay.
  const perHandGripBaselines = useMemo(
    () => buildPerHandGripBaselines(history, threeExpPriors),
    [history, threeExpPriors]
  );

  // Per-grip improvement — pooled current vs pooled baseline, same
  // calc as the Capacity (AUC) chart so headline numbers tie out
  // across surfaces. Previously this averaged per-hand improvements,
  // which produced a different number from the chart for grips with
  // L/R asymmetry.
  const gripImprovement = useMemo(
    () => buildGripImprovement(gripBaselines, grip3xEstimates),
    [gripBaselines, grip3xEstimates]
  );

  // Per-grip hand asymmetry diagnostic — for each grip with fittable
  // L and R reps, the % gap between hands at 30s (middle of the
  // curve). Surfaces the limiter the user doesn't normally see.
  const handAsymmetry = useMemo(
    () => computeHandAsymmetry(history, grip3xEstimates, threeExpPriors, 30),
    [history, grip3xEstimates, threeExpPriors]
  );

  return {
    gripBaselines,
    grip3xEstimates,
    gripHandFits,
    perHandGripBaselines,
    gripImprovement,
    handAsymmetry,
  };
}

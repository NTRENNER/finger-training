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
//     perHandGripBaselines: { [`${grip}|${hand}`]: { date, amps } },
//     gripImprovement:      { [grip]: { ...zoneDeltas, total, baselineDate } },
//     handAsymmetry:        [{ grip, L, R, stronger, weaker, asymPct }],
//   }

import { useEffect, useMemo } from "react";
import {
  buildGripBaselines, buildPerHandGripBaselines,
  buildGripEstimates, buildGripImprovement, computeHandAsymmetry,
} from "../model/baselines.js";

export function useGripFits({
  history, threeExpPriors, grips,
  // Optional: { [grip]: { date, amps } } from useUserSettings. When
  // present, takes precedence over the freshly-computed baseline so
  // the comparison frame doesn't slide backward if older reps land
  // in history later (stale-device sync, accidental import, etc.).
  // See LS_PINNED_GRIP_BASELINES_KEY for the why.
  pinnedGripBaselines = null,
  // Optional: callback to persist a newly-seeded baseline. Called
  // from the auto-pin effect below the first time each grip's seed
  // window is satisfied. No-op if the caller doesn't pass it (the
  // hook still works, just without persistence — useful for tests).
  onSavePinnedGripBaselines = null,
}) {
  // Freshly-computed candidate baseline from the current rep history.
  // The earliest 5-rep / 3-distinct-duration window per grip. This is
  // the "computed from raw data" version that the older single-source-
  // of-truth model returned directly; with the freeze, it's now just
  // a candidate that gets pinned on first seed.
  const candidateGripBaselines = useMemo(
    () => buildGripBaselines(history, threeExpPriors),
    [history, threeExpPriors]
  );

  // Effective baseline used downstream — pinned wins, candidate fills
  // gaps for grips that haven't been seeded yet. This is what every
  // existing consumer (Curve Improvement card, AUC trajectory, Force
  // Curves overlay) reads.
  const gripBaselines = useMemo(() => {
    const out = { ...candidateGripBaselines };
    if (pinnedGripBaselines && typeof pinnedGripBaselines === "object") {
      for (const [grip, pinned] of Object.entries(pinnedGripBaselines)) {
        if (pinned && Array.isArray(pinned.amps) && pinned.amps.length === 3 && pinned.date) {
          out[grip] = pinned;
        }
      }
    }
    return out;
  }, [candidateGripBaselines, pinnedGripBaselines]);

  // Auto-pin on first seed. Each render after a grip's seed window
  // gets satisfied, the candidate appears for that grip; if there's
  // no pin yet, we persist it. From then on the pin is the source of
  // truth and changes to history (backdated reps, edits) don't
  // re-derive the baseline.
  useEffect(() => {
    if (!onSavePinnedGripBaselines) return;
    if (!candidateGripBaselines || typeof candidateGripBaselines !== "object") return;
    let changed = false;
    const next = { ...(pinnedGripBaselines || {}) };
    for (const [grip, baseline] of Object.entries(candidateGripBaselines)) {
      if (next[grip]) continue;       // already pinned, never overwrite
      if (!baseline || !Array.isArray(baseline.amps) || !baseline.date) continue;
      next[grip] = { date: baseline.date, amps: baseline.amps };
      changed = true;
    }
    if (changed) onSavePinnedGripBaselines(next);
  }, [candidateGripBaselines, pinnedGripBaselines, onSavePinnedGripBaselines]);

  // Per-grip CURRENT amps — the "now" side of the per-grip improvement
  // comparison. Both halves of the Δ% live in the same model so the
  // numbers tie out across surfaces.
  const grip3xEstimates = useMemo(
    () => buildGripEstimates(history, threeExpPriors),
    [history, threeExpPriors]
  );

  // (gripHandFits — per-grip × per-hand three-exp fits — removed May
  // 2026 with its only consumer, the Strength Balance card.)

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
    perHandGripBaselines,
    gripImprovement,
    handAsymmetry,
  };
}

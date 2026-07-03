// ─────────────────────────────────────────────────────────────
// refitPinnedBaseline — re-derive a pinned baseline under the CURRENT model
// ─────────────────────────────────────────────────────────────
// A PINNED baseline (useGripFits / user_settings) locks WHICH window is the
// baseline via its start date, but the fitted amps must NEVER be trusted
// from storage — a fit is only meaningful under the model version that
// produced it. When the model changes, a frozen fit gets compared against a
// "now" curve built under different assumptions, manufacturing phantom
// per-zone regressions. Concretely: the F-D slow time-constant changed
// 180s -> 480s, so a baseline fit at tau=180 read ~50% too strong at 115s
// once evaluated at tau=480 — genuine gains showed as -19%. (The earlier
// cookedness-rescale removal would have orphaned frozen amps the same way.)
//
// This re-fits the pin's frozen window from CURRENT history under CURRENT
// code, so the baseline and the now-curve always share fitting assumptions.
// It reconstructs the same earliest >=5-rep / >=3-distinct-duration window
// buildGripBaselines/buildPerHandGripBaselines seed, but pinned to
// `startDate` so it can't slide if earlier reps land later. `hand` scopes
// it to one hand for per-hand pins. Returns { date, amps, maxHoldS }, or
// null when the window can't be rebuilt from the current history (e.g. a
// partial local cache) — the caller then falls back to the stored pin.

import { buildThreeExpPriors } from "./threeExp.js";
import { fitAmpsForPts } from "./baselines.js";
import { effectiveLoad, freshFitReps } from "./load.js";

export function refitPinnedBaseline(history, grip, startDate, threeExpPriors, { hand = null } = {}) {
  if (!grip || !startDate) return null;
  const reps = freshFitReps(history).filter(r =>
    r.grip === grip &&
    (hand == null || r.hand === hand) &&
    effectiveLoad(r) > 0 && r.actual_time_s > 0 &&
    (r.date || "") >= startDate
  );
  if (reps.length < 5) return null;
  reps.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const acc = [];
  const durs = new Set();
  for (const r of reps) {
    acc.push(r);
    durs.add(r.target_duration);
    if (acc.length >= 5 && durs.size >= 3) {
      // Leak-free prior anchored at the window's close — same contract as
      // buildGripBaselines, so a re-fit is identical to the original seed
      // fit under the current model.
      const closeDate = acc.reduce((m, x) => (x.date > m ? x.date : m), acc[0].date);
      const leakFree = buildThreeExpPriors(history, { upTo: closeDate });
      const priorsForFit = leakFree.has(grip) ? leakFree : threeExpPriors;
      const amps = fitAmpsForPts(
        acc.map(x => ({ T: x.actual_time_s, F: effectiveLoad(x) })),
        grip,
        priorsForFit,
      );
      const maxHoldS = acc.reduce((m, x) => Math.max(m, x.actual_time_s || 0), 0);
      return amps ? { date: acc[0].date, amps, maxHoldS } : null;
    }
  }
  return null;
}

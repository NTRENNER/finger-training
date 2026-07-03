// Tests for src/hooks/useAucHistoryByGrip.js — the per-grip AUC
// trajectory builder. Pins the July 2026 perf fix: the leak-free
// per-date prior used to be rebuilt inside the per-date loop inside
// the per-grip loop — O(grips × dates × history) NNLS work on every
// memo invalidation — even though buildThreeExpPriors returns EVERY
// grip's prior at once. The date-keyed cache (same priorsAt pattern
// as useHistoryOverlay) must build each date's prior exactly once,
// and the numbers must be byte-identical to the uncached computation.

import { renderHook } from "@testing-library/react";
import { useAucHistoryByGrip } from "../useAucHistoryByGrip.js";
import * as threeExpMod from "../../model/threeExp.js";
import { buildThreeExpPriors, computeBalancedCurveScore } from "../../model/threeExp.js";
import { fitAmpsForPts } from "../../model/baselines.js";
import { effectiveLoad, freshFitReps } from "../../model/load.js";

const D1 = "2026-06-01", D2 = "2026-06-08", D3 = "2026-06-15";
const rep = (grip, date, T, t, F) => ({
  grip, hand: "L", date, rep_num: 1, set_num: 1,
  target_duration: T, actual_time_s: t, avg_force_kg: F,
});
// Two grips sharing three session dates. D1 carries three reps per
// grip so the very first date clears the ≥3-cumulative-reps gate and
// every date plots (3 plotted dates × 2 grips).
const history = [
  rep("Crusher", D1, 10, 12, 40), rep("Crusher", D1, 40, 45, 28), rep("Crusher", D1, 120, 110, 20),
  rep("Crusher", D2, 40, 50, 29),
  rep("Crusher", D3, 40, 55, 30),
  rep("Micro", D1, 10, 11, 18), rep("Micro", D1, 40, 42, 12), rep("Micro", D1, 120, 100, 8),
  rep("Micro", D2, 40, 47, 13),
  rep("Micro", D3, 40, 52, 14),
];
const grips = ["Crusher", "Micro"];
const gripBaselines = {
  Crusher: { amps: [30, 12, 6], date: D1 },
  Micro:   { amps: [12, 5, 3], date: D1 },
};

describe("useAucHistoryByGrip", () => {
  // CRA sets resetMocks: true, which strips a still-installed spy's
  // call-through implementation between tests (it would then return
  // undefined into the next test's hook render). Restore explicitly
  // so a mid-test assertion failure can't cascade.
  afterEach(() => jest.restoreAllMocks());

  test("builds each date's leak-free prior once, shared across grips", () => {
    const threeExpPriors = buildThreeExpPriors(history);
    const spy = jest.spyOn(threeExpMod, "buildThreeExpPriors");
    const { result } = renderHook(() => useAucHistoryByGrip({
      history, grips, gripBaselines, threeExpPriors, bwLog: [],
    }));
    expect(result.current).not.toBeNull();
    expect(result.current.grips.sort()).toEqual(["Crusher", "Micro"]);
    // 3 distinct plotted dates → 3 prior builds. The uncached code
    // rebuilt per (grip × date) = 6.
    expect(spy.mock.calls.length).toBe(3);
    // Every call went through the { upTo } leak-free form.
    for (const call of spy.mock.calls) {
      expect(call[1]?.upTo).toBeDefined();
    }
  });

  test("cached output matches a direct uncached computation", () => {
    const threeExpPriors = buildThreeExpPriors(history);
    const { result } = renderHook(() => useAucHistoryByGrip({
      history, grips, gripBaselines, threeExpPriors, bwLog: [],
    }));
    const out = result.current;
    expect(out).not.toBeNull();
    // Recompute D3's Crusher point the way the hook does, but with a
    // fresh (uncached) per-date prior — the cache must be pure reuse.
    const gripFails = freshFitReps(history).filter(r =>
      r.grip === "Crusher" && effectiveLoad(r) > 0 && r.actual_time_s > 0
    );
    const upTo = gripFails.filter(r => (r.date || "") <= D3);
    const leak = buildThreeExpPriors(history, { upTo: D3 });
    const amps = fitAmpsForPts(
      upTo.map(r => ({ T: r.actual_time_s, F: effectiveLoad(r) })),
      "Crusher",
      leak.has("Crusher") ? leak : threeExpPriors,
    );
    expect(amps).not.toBeNull();
    const expectedAbs = Math.round(computeBalancedCurveScore(amps));
    const d3Row = out.absRows.find(r => r.date === D3);
    expect(d3Row).toBeDefined();
    expect(d3Row.Crusher_abs).toBe(expectedAbs);
    // First plotted date stays clamped to the baseline (0% anchor).
    const d1Row = out.absRows.find(r => r.date === D1);
    expect(d1Row.Crusher_abs).toBe(
      Math.round(computeBalancedCurveScore(gripBaselines.Crusher.amps))
    );
  });
});

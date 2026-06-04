// Tests for src/model/baselines.js — focused on freshFitReps, the
// fresh + de-duplicated rep filter that all baseline/estimate/improvement
// fits now run through (fixes the per-hand asymmetry + pooled-vs-per-hand
// divergence that came from fatigue/duplicate-contaminated baselines).

import { buildGripBaselines, buildGripEstimates, buildGripImprovement } from "../baselines.js";
import { buildThreeExpPriors, predForceThreeExp } from "../threeExp.js";
import { freshFitReps } from "../load.js";

const r = (over) => ({
  grip: "Crusher", hand: "L", date: "2026-04-20",
  rep_num: 1, target_duration: 45, actual_time_s: 40, avg_force_kg: 30,
  ...over,
});

describe("freshFitReps", () => {
  test("keeps only fresh first reps (rep_num === 1) or legacy null", () => {
    const out = freshFitReps([
      r({ rep_num: 1, actual_time_s: 40 }),
      r({ rep_num: 2, actual_time_s: 20 }),   // fatigued within-set → drop
      r({ rep_num: 3, actual_time_s: 10 }),   // fatigued → drop
      r({ rep_num: null, actual_time_s: 33 }),// legacy/manual → keep
    ]);
    expect(out.length).toBe(2);
    expect(out.every(x => x.rep_num == null || x.rep_num === 1)).toBe(true);
  });

  test("collapses exact-duplicate rows (double-logged sessions)", () => {
    const dup = { rep_num: 1, actual_time_s: 85, avg_force_kg: 8.21, target_duration: 120 };
    const out = freshFitReps([r(dup), r(dup), r({ ...dup, actual_time_s: 60 })]);
    expect(out.length).toBe(2);   // two identical collapse to one; the 60s stays
  });

  test("does not dedup by id — distinct content with same id-less shape stays", () => {
    const out = freshFitReps([
      r({ actual_time_s: 40, avg_force_kg: 30 }),
      r({ actual_time_s: 41, avg_force_kg: 30 }),  // different time → distinct
    ]);
    expect(out.length).toBe(2);
  });

  test("handles empty / null", () => {
    expect(freshFitReps([])).toEqual([]);
    expect(freshFitReps(null)).toEqual([]);
  });
});

describe("buildGripBaselines uses fresh reps", () => {
  test("a duplicated, fatigue-laden session doesn't seed a weaker baseline than its fresh reps", () => {
    // 5 fresh reps across 3 durations, each duplicated + with fatigued
    // followers. The baseline should fit only the 5 fresh, de-duped points.
    const base = [];
    const add = (t, F, dur) => {
      base.push(r({ rep_num: 1, actual_time_s: t, avg_force_kg: F, target_duration: dur }));
      base.push(r({ rep_num: 1, actual_time_s: t, avg_force_kg: F, target_duration: dur })); // dup
      base.push(r({ rep_num: 3, actual_time_s: t / 3, avg_force_kg: F, target_duration: dur })); // fatigued
    };
    add(8, 55, 7); add(8.2, 56, 7); add(45, 30, 45); add(46, 31, 45); add(120, 22, 120);
    const out = buildGripBaselines(base, null);
    expect(out.Crusher).toBeDefined();
    expect(out.Crusher.amps.length).toBe(3);
  });
});

describe("baseline prior is LEAK-FREE (does not pull baseline toward future strength)", () => {
  // Regression for the v3→v4 fix. The baseline window is small and
  // heavily shrunk toward a prior. If that prior pools the WHOLE history
  // (including later, stronger reps) it drags the baseline UP and erases
  // real improvement. The baseline must reflect only the early data.
  const session = (date, F, scale = 1) => [
    { grip: "Crusher", hand: "L", date, rep_num: 1, target_duration: 7,   actual_time_s: 7 * scale,  avg_force_kg: F * 1.6 },
    { grip: "Crusher", hand: "L", date, rep_num: 1, target_duration: 45,  actual_time_s: 45 * scale, avg_force_kg: F },
    { grip: "Crusher", hand: "L", date, rep_num: 1, target_duration: 120, actual_time_s: 120 * scale, avg_force_kg: F * 0.8 },
  ];

  // Weak at the start (~10kg @45s), strong now (~16kg @45s).
  const history = [
    ...session("2026-01-01", 10), ...session("2026-01-03", 10.2),
    ...session("2026-03-01", 14), ...session("2026-03-03", 15),
    ...session("2026-03-05", 16), ...session("2026-03-07", 16),
  ];

  test("baseline stays near early (weak) data, not the later strong data", () => {
    const priors = buildThreeExpPriors(history);          // whole-history
    const baselines = buildGripBaselines(history, priors); // leak-free inside
    const baseF45 = predForceThreeExp(baselines.Crusher.amps, 45);
    // Early data was ~10kg @45s. A leaked (whole-history) prior would pull
    // this toward the ~15kg current level. Leak-free keeps it near 10.
    expect(baseF45).toBeLessThan(12);
    expect(baseF45).toBeGreaterThan(8);
  });

  test("improvement reflects the real gain, not ~0", () => {
    const priors = buildThreeExpPriors(history);
    const baselines = buildGripBaselines(history, priors);
    const estimates = buildGripEstimates(history, priors);
    const imp = buildGripImprovement(baselines, estimates);
    // ~10 → ~15kg is a large, real gain; must not be crushed to single digits.
    expect(imp.Crusher.total).toBeGreaterThan(25);
  });
});

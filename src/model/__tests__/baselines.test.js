// Tests for src/model/baselines.js — focused on freshFitReps, the
// fresh + de-duplicated rep filter that all baseline/estimate/improvement
// fits now run through (fixes the per-hand asymmetry + pooled-vs-per-hand
// divergence that came from fatigue/duplicate-contaminated baselines).

import {
  buildGripBaselines, buildGripEstimates, buildGripImprovement,
  buildPerHandGripEstimates,
  improvementForAmps, SUPPORT_MIN_HOLD_FRAC,
} from "../baselines.js";
import { buildThreeExpPriors, predForceThreeExp } from "../threeExp.js";
import { freshFitReps } from "../load.js";

const r = (over) => ({
  grip: "Crusher", hand: "L", date: "2026-04-20",
  rep_num: 1, target_duration: 45, actual_time_s: 40, avg_force_kg: 30,
  ...over,
});

describe("buildPerHandGripEstimates", () => {
  test("splits fits by hand under grip|hand keys; ignores Both/missing hand", () => {
    const history = [
      r({ hand: "L", target_duration: 10, actual_time_s: 10, avg_force_kg: 50 }),
      r({ hand: "L", target_duration: 60, actual_time_s: 60, avg_force_kg: 22 }),
      r({ hand: "R", target_duration: 10, actual_time_s: 10, avg_force_kg: 44 }),
      r({ hand: "R", target_duration: 60, actual_time_s: 60, avg_force_kg: 19 }),
      r({ hand: "Both", target_duration: 30, actual_time_s: 30, avg_force_kg: 70 }),  // ignored
    ];
    const priors = buildThreeExpPriors(history);
    const out = buildPerHandGripEstimates(history, priors);
    expect(out["Crusher|L"]).toBeDefined();
    expect(out["Crusher|R"]).toBeDefined();
    expect(Object.keys(out).every(k => k.endsWith("|L") || k.endsWith("|R"))).toBe(true);
    // The stronger hand's fit predicts more force at a shared duration.
    const fL = predForceThreeExp(out["Crusher|L"], 30);
    const fR = predForceThreeExp(out["Crusher|R"], 30);
    expect(fL).toBeGreaterThan(fR);
  });

  test("empty / handless history yields an empty map", () => {
    expect(buildPerHandGripEstimates([], buildThreeExpPriors([]))).toEqual({});
  });
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

describe("fresh-equivalent basis (freshEq opt on the estimate builders)", () => {
  // July 2026: cookedness is disabled as a load rescaler
  // (capacityMultiplier returns 1.0), so the freshEq path is now a
  // no-op -- it produces the same fit as raw. These tests pin that
  // equivalence; flip COOKEDNESS_LOAD_SCALING back on to restore the
  // old de-cook behavior.
  const cookedHistory = (cooked) => [
    r({ target_duration: 10,  actual_time_s: 10,  avg_force_kg: 50, session_cooked: cooked }),
    r({ target_duration: 45,  actual_time_s: 45,  avg_force_kg: 30, session_cooked: cooked }),
    r({ target_duration: 120, actual_time_s: 120, avg_force_kg: 22, session_cooked: cooked }),
  ];

  test("no opts / explicit raw opts → byte-identical to today's behavior", () => {
    const history = cookedHistory(5);
    const raw = buildGripEstimates(history, null);
    expect(buildGripEstimates(history, null, {})).toEqual(raw);
    expect(buildGripEstimates(history, null, { freshEq: false, fatigueModel: null })).toEqual(raw);
  });

  test("all-cooked history: fresh-eq curve equals the raw curve (cookedness disabled)", () => {
    const history = cookedHistory(5);
    const raw   = buildGripEstimates(history, null);
    const fresh = buildGripEstimates(history, null, { freshEq: true, fatigueModel: null });
    expect(raw.Crusher).toBeDefined();
    expect(fresh.Crusher).toBeDefined();
    expect(fresh).toEqual(raw); // July 2026: cookedness disabled as a load rescaler -> freshEq == raw
  });

  test("session_cooked null/0 → freshEq fit identical to raw", () => {
    for (const cooked of [null, 0]) {
      const history = cookedHistory(cooked);
      const raw   = buildGripEstimates(history, null);
      const fresh = buildGripEstimates(history, null, { freshEq: true, fatigueModel: null });
      expect(fresh).toEqual(raw);
    }
  });

  test("per-hand variant: freshEq equals raw too (cookedness disabled)", () => {
    const history = cookedHistory(5);
    const raw   = buildPerHandGripEstimates(history, null);
    const fresh = buildPerHandGripEstimates(history, null, { freshEq: true, fatigueModel: null });
    expect(fresh).toEqual(raw); // July 2026: freshEq == raw for the per-hand builder too
  });
});

// ─────────────────────────────────────────────────────────────
// improvementForAmps — unbaselined-zone gating (July 2026)
// ─────────────────────────────────────────────────────────────
// A zone whose reference duration is past what the baseline actually
// measured is pure extrapolation — comparing a real current curve to a
// GUESSED baseline. Those zones report null ("new") and drop from total.
describe("improvementForAmps unbaselined-zone gating", () => {
  // Non-uniform gains so excluding a zone actually moves the total: the
  // slow amp is DOUBLED (8 vs 4 → big endurance gain) while the fast amp
  // is up 1.5x (30 vs 20). So the long zones improve more than the short.
  const cur = [30, 12, 8];
  const ref = [20, 8, 4];

  test("no baselineMaxHoldS → every zone reported (prior behavior)", () => {
    const imp = improvementForAmps(cur, ref);        // null gate
    for (const k of ["max_strength","power","power_strength","strength","strength_endurance","endurance"]) {
      expect(typeof imp[k]).toBe("number");
    }
    expect(typeof imp.total).toBe("number");
  });

  test("a short baseline nulls the zones past its reach and drops them from total", () => {
    // Longest baseline hold 85s. Zone is baselined iff maxHold >= refT*0.6:
    //   strength refT=115 -> 69 <= 85 kept; strength_endurance 160 -> 96 > 85 null;
    //   endurance 220 -> 132 > 85 null.
    const imp = improvementForAmps(cur, ref, 85);
    expect(imp.strength).not.toBeNull();             // 115*0.6 = 69 <= 85
    expect(imp.strength_endurance).toBeNull();       // 160*0.6 = 96 > 85
    expect(imp.endurance).toBeNull();                // 220*0.6 = 132 > 85
    expect(imp.max_strength).not.toBeNull();
    const allSix = improvementForAmps(cur, ref);
    // The excluded endurance zones had the biggest gains, so dropping them
    // lowers the gated total below the all-six total.
    expect(imp.total).toBeLessThan(allSix.total);
    expect(typeof imp.total).toBe("number");
  });

  test("SUPPORT_MIN_HOLD_FRAC boundary: refT*frac is the cutoff", () => {
    expect(improvementForAmps(cur, ref, 132).endurance).not.toBeNull(); // 220*0.6 exactly
    expect(improvementForAmps(cur, ref, 131).endurance).toBeNull();     // just under
    expect(SUPPORT_MIN_HOLD_FRAC).toBe(0.6);
  });
});

// buildGripBaselines now records the baseline window's longest real hold,
// so improvement can tell measured zones from extrapolated ones.
describe("buildGripBaselines maxHoldS + gated improvement integration", () => {
  const rep = (T, F, date, sid) => ({
    grip: "Crusher", hand: "L", rep_num: 1, set_num: 1,
    target_duration: T, actual_time_s: T, avg_force_kg: F, date, session_id: sid,
  });
  const baseHist = [
    rep(7,  55, "2026-01-01", "b1"),
    rep(30, 34, "2026-01-01", "b1"),
    rep(45, 30, "2026-01-02", "b2"),
    rep(60, 27, "2026-01-02", "b2"),
    rep(90, 22, "2026-01-03", "b3"),
  ];

  test("baseline records maxHoldS = longest actual hold in the window", () => {
    const priors = buildThreeExpPriors(baseHist);
    const base = buildGripBaselines(baseHist, priors);
    expect(base.Crusher).toBeDefined();
    expect(base.Crusher.maxHoldS).toBeCloseTo(90, 5);
  });

  test("improvement hides zones past the baseline's longest hold", () => {
    const now = [
      rep(7,  62, "2026-03-01", "n1"),
      rep(30, 40, "2026-03-01", "n1"),
      rep(90, 26, "2026-03-02", "n2"),
      rep(160, 20, "2026-03-03", "n3"),
      rep(220, 16, "2026-03-04", "n4"),
    ];
    const history = [...baseHist, ...now];
    const priors = buildThreeExpPriors(history);
    const base = buildGripBaselines(history, priors);
    const est = buildGripEstimates(history, priors);
    const imp = buildGripImprovement(base, est);
    expect(imp.Crusher).toBeDefined();
    // 90s baseline: endurance (220*0.6=132 > 90) and strength_endurance
    // (160*0.6=96 > 90) are unbaselined -> null ("new").
    expect(imp.Crusher.endurance).toBeNull();
    expect(imp.Crusher.strength_endurance).toBeNull();
    expect(typeof imp.Crusher.power).toBe("number");
    expect(typeof imp.Crusher.total).toBe("number");
  });
});

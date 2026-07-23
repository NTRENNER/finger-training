// Tests for src/model/weeklyRatio.js — weekly mean actual/target
// ratio per grip/hand for the Analysis chart.
import { buildWeeklyRatio } from "../weeklyRatio.js";

const rep = (date, grip, hand, actual, target, load = 20, extra = {}) => ({
  date, grip, hand,
  actual_time_s: actual,
  target_duration: target,
  avg_force_kg: load,
  set_num: 1, rep_num: 1,
  ...extra,
});

describe("buildWeeklyRatio", () => {
  test("empty / no qualifying reps → empty result", () => {
    expect(buildWeeklyRatio([])).toEqual({ grips: [], weeks: [] });
    expect(buildWeeklyRatio(null)).toEqual({ grips: [], weeks: [] });
    // Reps missing target, load, or time never qualify.
    expect(buildWeeklyRatio([
      { date: "2026-07-14", grip: "Micro", hand: "L", actual_time_s: 40, avg_force_kg: 20 },            // no target
      { date: "2026-07-14", grip: "Micro", hand: "L", actual_time_s: 40, target_duration: 45 },          // no load
      { date: "2026-07-14", grip: "Micro", hand: "L", target_duration: 45, avg_force_kg: 20 },           // no time
    ])).toEqual({ grips: [], weeks: [] });
  });

  test("buckets by Monday-start weekKey and averages actual/target", () => {
    const out = buildWeeklyRatio([
      // Week of Mon 2026-07-13: Tue + Sun land in the same bucket.
      rep("2026-07-14", "Crusher", "L", 45, 50),   // 0.9
      rep("2026-07-19", "Crusher", "L", 55, 50),   // 1.1
    ]);
    expect(out.grips).toEqual(["Crusher"]);
    expect(out.weeks).toHaveLength(1);
    expect(out.weeks[0].week).toBe("2026-07-13");
    expect(out.weeks[0].byGrip.Crusher.mean).toBe(1.0);
    expect(out.weeks[0].byGrip.Crusher.n).toBe(2);
  });

  test("splits per hand; hand means only cover that hand's reps", () => {
    const out = buildWeeklyRatio([
      rep("2026-07-14", "Micro", "L", 60, 50),   // 1.2
      rep("2026-07-14", "Micro", "R", 40, 50),   // 0.8
    ]);
    const g = out.weeks[0].byGrip.Micro;
    expect(g.mean).toBe(1.0);
    expect(g.hands.L).toEqual({ mean: 1.2, n: 1 });
    expect(g.hands.R).toEqual({ mean: 0.8, n: 1 });
  });

  test("covers every calendar week first→last; quiet weeks are empty, not skipped", () => {
    const out = buildWeeklyRatio([
      rep("2026-06-30", "Micro", "L", 45, 45),   // week 2026-06-29
      rep("2026-07-21", "Micro", "L", 45, 45),   // week 2026-07-20 (3 weeks later)
    ]);
    expect(out.weeks.map((w) => w.week)).toEqual([
      "2026-06-29", "2026-07-06", "2026-07-13", "2026-07-20",
    ]);
    expect(out.weeks[1].byGrip).toEqual({});
    expect(out.weeks[2].byGrip).toEqual({});
  });

  test("keeps grips separate within a week and sorts the grip list", () => {
    const out = buildWeeklyRatio([
      rep("2026-07-14", "Prime",   "L", 55, 50),  // 1.1
      rep("2026-07-14", "Crusher", "L", 40, 50),  // 0.8
      rep("2026-07-15", "Micro",   "R", 50, 50),  // 1.0
    ]);
    expect(out.grips).toEqual(["Crusher", "Micro", "Prime"]);
    const wk = out.weeks[0].byGrip;
    expect(wk.Prime.mean).toBe(1.1);
    expect(wk.Crusher.mean).toBe(0.8);
    expect(wk.Micro.mean).toBe(1.0);
  });

  test("uses the same rep filter as the check-in's perf signal (load fallback chain)", () => {
    // No avg_force but a manual load → still qualifies (effectiveLoad chain).
    const out = buildWeeklyRatio([{
      date: "2026-07-14", grip: "Crusher", hand: "L",
      actual_time_s: 100, target_duration: 200, manual_load_kg: 22,
      set_num: 1, rep_num: 1,
    }]);
    expect(out.weeks[0].byGrip.Crusher).toMatchObject({ mean: 0.5, n: 1 });
  });

  test("default openers mode reads only rep 1 of set 1 — density reps 2+ don't drag the mean", () => {
    const hist = [
      rep("2026-07-14", "Crusher", "L", 50, 50),                                  // opener: 1.0
      rep("2026-07-14", "Crusher", "L", 30, 50, 20, { rep_num: 2 }),              // ladder rep, short by design
      rep("2026-07-14", "Crusher", "L", 25, 50, 20, { set_num: 2, rep_num: 1 }),  // set-2 opener ≠ fresh
      rep("2026-07-14", "Crusher", "L", 40, 50, 20, { set_num: null, rep_num: null }), // unnumbered → excluded
    ];
    const openers = buildWeeklyRatio(hist);
    expect(openers.weeks[0].byGrip.Crusher).toMatchObject({ mean: 1.0, n: 1 });
    // "all" mode keeps every qualifying rep — the check-in's estimator.
    const all = buildWeeklyRatio(hist, { repsMode: "all" });
    expect(all.weeks[0].byGrip.Crusher.n).toBe(4);
    expect(all.weeks[0].byGrip.Crusher.mean).toBe(0.73); // (1.0+0.6+0.5+0.8)/4 = 0.725 → 0.73
  });

  test("means round to 2 decimals", () => {
    const out = buildWeeklyRatio([
      rep("2026-07-14", "Micro", "L", 100, 300), // 0.3333…
    ]);
    expect(out.weeks[0].byGrip.Micro.mean).toBe(0.33);
  });
});

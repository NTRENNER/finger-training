// Tests for src/model/sustainedHolds.js — measured long-hold capacity
// backing the Sustained-vs-max card.
import {
  buildSustainedHolds, bestHoldSince, lastHold, SUSTAINED_MIN_S,
} from "../sustainedHolds.js";

const rep = (date, grip, hand, holdS, avgKg, extra = {}) => ({
  date, grip, hand,
  actual_time_s: holdS,
  avg_force_kg: avgKg,
  peak_force_kg: avgKg != null ? avgKg + 2 : null,   // peak > avg = real measurement
  ...extra,
});

describe("buildSustainedHolds", () => {
  test("only measured holds at/above the threshold qualify", () => {
    const out = buildSustainedHolds([
      rep("2026-05-11", "Crusher", "L", 222, 16.1),                       // qualifies
      rep("2026-05-12", "Crusher", "L", 100, 30.0),                      // too short
      { date: "2026-05-13", grip: "Crusher", hand: "L",                  // manual load — nominal, excluded
        actual_time_s: 258, manual_load_kg: 9.1 },
      { date: "2026-05-14", grip: "Crusher", hand: "L",                  // seed artifact (avg == peak)
        actual_time_s: 200, avg_force_kg: 20, peak_force_kg: 20 },
    ]);
    expect(out.grips.Crusher.holds).toEqual([{ date: "2026-05-11", loadKg: 16.1, holdS: 222 }]);
    expect(out.grips.Crusher.longestHoldS).toBe(222);
  });

  test("threshold boundary: exactly SUSTAINED_MIN_S qualifies", () => {
    const out = buildSustainedHolds([rep("2026-06-01", "Micro", "R", SUSTAINED_MIN_S, 10)]);
    expect(out.grips.Micro.holds).toHaveLength(1);
  });

  test("one point per date — heaviest load wins, ties go to the longer hold", () => {
    const out = buildSustainedHolds([
      rep("2026-06-01", "Crusher", "L", 150, 20),
      rep("2026-06-01", "Crusher", "R", 130, 24),   // heavier → wins the date
      rep("2026-06-01", "Crusher", "L", 180, 24),   // same load, longer → wins the tie
    ]);
    expect(out.grips.Crusher.holds).toEqual([{ date: "2026-06-01", loadKg: 24, holdS: 180 }]);
  });

  test("hand scoping filters reps before everything else", () => {
    const out = buildSustainedHolds([
      rep("2026-06-01", "Crusher", "L", 150, 20),
      rep("2026-06-02", "Crusher", "R", 150, 25),
    ], { hand: "L" });
    expect(out.grips.Crusher.holds).toEqual([{ date: "2026-06-01", loadKg: 20, holdS: 150 }]);
  });

  test("grips with measured reps but no qualifying hold land in `quiet`", () => {
    const out = buildSustainedHolds([
      rep("2026-07-12", "Prime", "L", 27, 8),        // Prime's longest is 27s
      rep("2026-06-01", "Crusher", "L", 150, 20),
    ]);
    expect(out.quiet).toEqual(["Prime"]);
    expect(out.grips.Prime).toBeUndefined();
    expect(out.grips.Crusher).toBeDefined();
  });

  test("holds sort ascending by date; longestHoldS covers sub-threshold reps", () => {
    const out = buildSustainedHolds([
      rep("2026-07-04", "Crusher", "L", 172, 22.1),
      rep("2026-05-20", "Crusher", "L", 163, 24.3),
      rep("2026-07-20", "Crusher", "L", 190, 10),    // long but light — still a point (its date's only hold)
    ]);
    expect(out.grips.Crusher.holds.map(h => h.date)).toEqual([
      "2026-05-20", "2026-07-04", "2026-07-20",
    ]);
    expect(out.grips.Crusher.longestHoldS).toBe(190);
  });

  test("empty history → no grips, no quiet", () => {
    expect(buildSustainedHolds([])).toEqual({ grips: {}, quiet: [] });
    expect(buildSustainedHolds(null)).toEqual({ grips: {}, quiet: [] });
  });
});

describe("bestHoldSince / lastHold", () => {
  const holds = [
    { date: "2026-05-20", loadKg: 24.3, holdS: 163 },
    { date: "2026-07-04", loadKg: 22.1, holdS: 172 },
  ];
  test("bestHoldSince returns the heaviest on/after the cutoff", () => {
    expect(bestHoldSince(holds, "2026-05-01")).toMatchObject({ loadKg: 24.3 });
    expect(bestHoldSince(holds, "2026-06-01")).toMatchObject({ loadKg: 22.1 });
    expect(bestHoldSince(holds, "2026-08-01")).toBeNull();
    expect(bestHoldSince([], "2026-01-01")).toBeNull();
  });
  test("lastHold returns the most recent regardless of load", () => {
    expect(lastHold(holds)).toMatchObject({ date: "2026-07-04" });
    expect(lastHold([])).toBeNull();
  });
});

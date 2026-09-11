import { forceComparison, zoneReference, holdTimeAtForce, defaultComparisonLoad, comparisonReps, holdTimeSeries } from "../curveComparison.js";
import { predForceThreeExp, THREE_EXP_TAUS } from "../threeExp.js";

const before = [0, 0, 50];
const after = [0, 0, 60];
const overlay = {
  baselineDate: "2026-01-01", baselineAmps: before, baselineMaxHoldS: 240,
  dates: ["2026-01-01", "2026-02-01", "2026-03-01"],
  ampsByDate: new Map([["2026-01-01", before], ["2026-02-01", after], ["2026-03-01", [0, 0, 40]]]),
  maxHoldByDate: new Map([["2026-01-01", 240], ["2026-02-01", 240], ["2026-03-01", 240]]),
};

test("weight is the unrounded force difference at the existing zone duration", () => {
  const comparison = forceComparison(overlay, "power", "2026-02-01");
  expect(comparison.duration).toBe(30);
  expect(comparison.percent).toBeCloseTo(20, 9);
  expect(comparison.delta).toBeCloseTo(10 * Math.exp(-30 / THREE_EXP_TAUS[2]), 9);
});

test("fixed-load time gain follows the inverse curve, not the force percentage", () => {
  const load = predForceThreeExp(before, 30);
  const timeBefore = holdTimeAtForce(before, load, 240);
  const timeAfter = holdTimeAtForce(after, load, 240);
  expect(timeBefore).toBeCloseTo(30, 8);
  expect(timeAfter - timeBefore).toBeCloseTo(THREE_EXP_TAUS[2] * Math.log(1.2), 8);
  expect(timeAfter).not.toBeCloseTo(36, 1);
  expect(holdTimeAtForce(before, load, 240)).toBe(timeBefore);
});

test("declining capacity produces a shorter supported hold", () => {
  expect(holdTimeAtForce([0, 0, 40], 35, 240)).toBeLessThan(holdTimeAtForce(before, 35, 240));
});

test("unsupported or invalid loads are unknown rather than zero or a capped estimate", () => {
  for (const load of [0, -1, NaN, Infinity, 51, 1]) expect(holdTimeAtForce(before, load, 240)).toBeNull();
  expect(holdTimeAtForce(before, 40, null)).toBeNull();
  expect(holdTimeAtForce([0, 0, 0], 40, 240)).toBeNull();
  expect(holdTimeAtForce([0, -1, 50], 40, 240)).toBeNull();
  expect(holdTimeAtForce(before, predForceThreeExp(before, 240), 240)).toBeCloseTo(240, 8);
});

test("late-supported zones use their own dated baseline without future leakage", () => {
  const sparse = { ...overlay, baselineMaxHoldS: 30,
    maxHoldByDate: new Map([["2026-01-01", 30], ["2026-02-01", 80], ["2026-03-01", 240]]) };
  expect(zoneReference(sparse, "endurance", "2026-02-01")).toBeNull();
  expect(forceComparison(sparse, "endurance", "2026-02-01")).toBeNull();
  expect(forceComparison(sparse, "endurance", "2026-03-01")).toMatchObject({ baselineDate: "2026-03-01", delta: 0 });
});

const rep = (overrides = {}) => ({ grip: "Crusher", hand: "L", date: "2026-01-01", rep_num: 1, actual_time_s: 50, avg_force_kg: 45, peak_force_kg: 46, ...overrides });

test("measurement selection retains overpulls and excludes interruptions, other hands, and prescriptions", () => {
  const rows = comparisonReps([
    rep({ prescribed_load_kg: 30 }),
    rep({ hand: "R", avg_force_kg: 35 }),
    rep({ date: "2026-01-02", interrupted: true, failure_valid: false, completion_status: "interrupted" }),
    rep({ date: "2026-01-03", avg_force_kg: null, prescribed_load_kg: 45 }),
  ], "Crusher", "L");
  expect(rows).toHaveLength(1);
  expect(rows[0].avg_force_kg).toBe(45);
});

test("new workouts cannot move the default historical weight", () => {
  const reference = zoneReference(overlay, "power", "2026-02-01");
  const initial = [rep()];
  const extended = [...initial, rep({ date: "2026-02-01", avg_force_kg: 49, actual_time_s: 30 })];
  expect(defaultComparisonLoad(overlay, "power", reference, initial)).toBe(45);
  expect(defaultComparisonLoad(overlay, "power", reference, extended)).toBe(45);
});

test("history stops at the selected date and leaves unsupported gaps", () => {
  const reference = zoneReference(overlay, "power", "2026-03-01");
  const rows = holdTimeSeries(overlay, reference, 45, "2026-03-01");
  expect(rows.map(r => r.date)).toEqual(overlay.dates);
  expect(rows[2].seconds).toBeNull();
  expect(holdTimeSeries(overlay, reference, 45, "2026-02-01")).toHaveLength(2);
});


test("a long-domain default does not reuse an unrelated short hold", () => {
  const reference = zoneReference(overlay, "endurance", "2026-02-01");
  expect(defaultComparisonLoad(overlay, "endurance", reference, [rep()]))
    .toBeCloseTo(predForceThreeExp(before, 220), 8);
});

test("a baseline after the selected date is unavailable", () => {
  expect(zoneReference(overlay, "power", "2025-12-01")).toBeNull();
});


test.each([5, 30, 70, 115, 160, 220])("inverts a mixed curve at %s seconds", seconds => {
  const amps = [12, 20, 30];
  expect(holdTimeAtForce(amps, predForceThreeExp(amps, seconds), 240)).toBeCloseTo(seconds, 8);
});

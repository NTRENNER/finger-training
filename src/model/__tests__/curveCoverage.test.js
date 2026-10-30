import { curveCoverageByGrip } from "../curveCoverage.js";

const rep = (date, actual_time_s, over = {}) => ({
  grip: "Crusher",
  hand: "L",
  date,
  session_id: `${date}-${actual_time_s}-${over.grip || "Crusher"}-${over.hand || "L"}`,
  set_num: 1,
  rep_num: 1,
  target_duration: actual_time_s,
  actual_time_s,
  avg_force_kg: 20,
  peak_force_kg: 24,
  failure_valid: true,
  ...over,
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(2026, 6, 23, 12));
});

afterEach(() => {
  jest.useRealTimers();
});

test("uses observed peak plus five trained domains for the denominator", () => {
  const history = [30, 70, 115, 160, 220].map(duration =>
    rep("2026-07-20", duration)
  );

  expect(curveCoverageByGrip(history).Crusher).toMatchObject({
    current: 6,
    total: 6,
    missing: [],
    aging: [],
    stale: [],
  });
});

test("successful overshoot refreshes the prescribed coverage domain", () => {
  const coverage = curveCoverageByGrip([
    rep("2026-07-20", 140.3, { target_duration: 120 }),
  ]).Crusher;

  expect(coverage.current).toBe(2); // peak + prescribed Strength
  expect(coverage.missing).not.toContain("Strength");
  expect(coverage.missing).toContain("Strength-Endurance");
});

test("names missing, aging, and stale domains", () => {
  const history = [
    rep("2026-07-05", 30),
    rep("2026-06-01", 70, { peak_force_kg: null }),
  ];

  expect(curveCoverageByGrip(history).Crusher).toEqual({
    current: 1,
    total: 6,
    aging: ["Power"],
    stale: ["Power-Strength"],
    missing: ["Strength", "Strength-Endurance", "Endurance"],
  });
});

test("requested grips remain visible before they have any data", () => {
  const coverage = curveCoverageByGrip(
    [rep("2026-07-20", 30)],
    { grips: ["Crusher", "Micro", "Prime"] },
  );

  expect(Object.keys(coverage)).toEqual(["Crusher", "Micro", "Prime"]);
  expect(coverage.Micro).toMatchObject({ current: 0, total: 6 });
  expect(coverage.Prime.missing).toHaveLength(6);
});

test("hand scope excludes evidence recorded by the other hand", () => {
  const coverage = curveCoverageByGrip([
    rep("2026-07-20", 30),
    rep("2026-07-20", 115, { hand: "R" }),
  ], { handView: "L" });

  expect(coverage.Crusher.current).toBe(2);
  expect(coverage.Crusher.missing).toContain("Strength");
});

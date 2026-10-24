import { curveEvidence, curveEvidenceDots } from "../curveComparison.js";
import { buildGripBaselines, buildPerHandGripBaselines } from "../baselines.js";
import { curveFitReps } from "../load.js";

// Opening holds (set 1, rep 1) across dates, durations and both hands.
const rep = (date, hand, target, time, kg) => ({
  id: `${date}-${hand}`, session_id: `s-${date}`, grip: "Crusher", hand, date, set_num: 1, rep_num: 1,
  target_duration: target, actual_time_s: time, avg_force_kg: kg, peak_force_kg: kg + 2,
  failure_valid: true, load_provenance: "measured_force",
});
const history = [
  rep("2026-09-01", "L", 45, 40, 40), rep("2026-09-01", "R", 45, 38, 41),
  rep("2026-09-03", "L", 115, 120, 18), rep("2026-09-03", "R", 115, 110, 19),
  rep("2026-09-05", "L", 220, 230, 12), rep("2026-09-05", "R", 220, 210, 13),
  rep("2026-09-08", "L", 45, 48, 42), rep("2026-09-08", "R", 45, 46, 43),
  rep("2026-09-10", "L", 70, 80, 30),
];
const fitReps = curveFitReps(history);

test("the baseline's points are exactly the reps its window was fitted to", () => {
  const baseline = buildGripBaselines(history, new Map()).Crusher;
  const points = curveEvidence(fitReps, { grip: "Crusher", baselineDate: baseline.date });
  expect(points).toHaveLength(9);
  // First five reps by date span three target durations, which closes the window.
  expect(points.filter(p => p.baseline).map(p => p.date))
    .toEqual(["2026-09-01", "2026-09-01", "2026-09-03", "2026-09-03", "2026-09-05"]);
  expect(points.filter(p => !p.baseline)).toHaveLength(4);
});

test("a per-hand view uses that hand's reps and its own baseline window", () => {
  const baseline = buildPerHandGripBaselines(history, new Map())["Crusher|L"];
  const points = curveEvidence(fitReps, { grip: "Crusher", hand: "L", baselineDate: baseline.date });
  expect(points.map(p => p.date)).toEqual(["2026-09-01", "2026-09-03", "2026-09-05", "2026-09-08", "2026-09-10"]);
  expect(points.every(p => p.baseline)).toBe(true);
});

test("a pinned baseline that starts later leaves earlier reps on the Now side", () => {
  const points = curveEvidence(fitReps, { grip: "Crusher", baselineDate: "2026-09-03" });
  expect(points.filter(p => p.date === "2026-09-01").every(p => !p.baseline)).toBe(true);
  expect(points.filter(p => p.baseline)).toHaveLength(5);
});

test("× BW divides each rep by its own bodyweight", () => {
  const points = curveEvidence(fitReps, { grip: "Crusher", hand: "L", forceFor: r => r.avg_force_kg / 80 });
  expect(points[0].f).toBeCloseTo(0.5);
  expect(curveEvidence(fitReps, { grip: "Crusher", forceFor: () => NaN })).toEqual([]);
});

test("baseline dots always show, later dots follow the Now date, and the axis peak never moves", () => {
  const points = curveEvidence(fitReps, { grip: "Crusher", baselineDate: "2026-09-01" });
  const early = curveEvidenceDots(points, { nowDate: "2026-09-05", tMin: 5, tMax: 240 });
  const late = curveEvidenceDots(points, { nowDate: "2026-09-10", tMin: 5, tMax: 240 });
  expect(early.baseline).toHaveLength(5);
  // The window closed on 09-05's first rep, so that day's other rep is "since".
  expect(early.since.map(d => d.date)).toEqual(["2026-09-05"]);
  expect(late.since.map(d => d.date)).toEqual(["2026-09-05", "2026-09-08", "2026-09-08", "2026-09-10"]);
  expect(early.peak).toBe(late.peak);
  expect(late.since[1]).toMatchObject({ x: 48, y: 42 });
  // Holds outside the drawn duration range are left out.
  expect(curveEvidenceDots(points, { nowDate: "2026-09-10", tMin: 5, tMax: 200 }).baseline).toHaveLength(4);
});

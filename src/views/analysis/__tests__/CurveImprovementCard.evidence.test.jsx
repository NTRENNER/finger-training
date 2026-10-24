import React from "react";
import { render } from "@testing-library/react";
import { CurveImprovementCard } from "../CurveImprovementCard.jsx";

const dots = [];
jest.mock("recharts", () => ({
  ResponsiveContainer: ({ children }) => <div>{children}</div>,
  LineChart: ({ children }) => <div>{children}</div>,
  Line: () => null,
  ReferenceDot: props => { dots.push(props); return null; },
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  CartesianGrid: () => null,
}));
const drawn = kind => dots.filter(d => d.className === `curve-dot-${kind}`).map(d => ({ x: d.x, y: d.y }));

const rep = (date, target, time, kg) => ({
  id: date, session_id: date, grip: "Crusher", hand: "L", date, set_num: 1, rep_num: 1,
  target_duration: target, actual_time_s: time, avg_force_kg: kg, peak_force_kg: kg + 2,
  failure_valid: true, load_provenance: "measured_force",
});
// Five reps over three durations form the baseline window; one rep falls
// inside the slider range and one after its last date.
const history = [
  rep("2026-06-01", 45, 40, 40), rep("2026-06-02", 115, 120, 18), rep("2026-06-03", 220, 230, 12),
  rep("2026-06-04", 45, 42, 41), rep("2026-06-05", 70, 75, 30),
  rep("2026-06-20", 45, 47, 43), rep("2026-08-01", 45, 50, 45),
];
const amps = [0, 0, 50];
const overlay = {
  baselineAmps: amps, baselineDate: "2026-06-01", baselineMaxHoldS: 240,
  dates: ["2026-06-01", "2026-07-01"],
  ampsByDate: new Map([["2026-06-01", amps], ["2026-07-01", [0, 0, 60]]]),
  maxHoldByDate: new Map([["2026-06-01", 240], ["2026-07-01", 240]]),
};
const props = {
  improvement: {}, gripImprovement: { Crusher: {} }, grip3xEstimates: { Crusher: [0, 0, 60] },
  gripBaselines: { Crusher: { amps, date: "2026-06-01", maxHoldS: 240 } }, selGrip: "Crusher",
  history, historyOverlay: { Crusher: overlay }, unit: "kg", maxDur: 260,
};

beforeEach(() => { dots.length = 0; });

test("the curve chart draws the baseline window's reps and the reps since, up to the Now date", () => {
  render(<CurveImprovementCard {...props} />);
  expect(drawn("baseline").map(d => d.x)).toEqual([40, 120, 230, 42, 75]);
  // The 06-20 rep is before the last slider date; the 08-01 rep is after it.
  expect(drawn("since")).toEqual([{ x: 47, y: 43 }]);
});

test("pounds convert the dots like the curves", () => {
  render(<CurveImprovementCard {...props} unit="lbs" />);
  expect(drawn("since")[0].y).toBeCloseTo(43 * 2.20462, 1);
});

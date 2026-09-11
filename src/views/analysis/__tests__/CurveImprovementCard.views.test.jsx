import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { CurveImprovementCard } from "../CurveImprovementCard.jsx";

beforeAll(() => { global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; });
afterAll(() => { delete global.ResizeObserver; });
const baseline = { amps: [0, 0, 50], date: "2026-06-01", maxHoldS: 240 };
const branch = {
  baselineAmps: baseline.amps, baselineDate: baseline.date, baselineMaxHoldS: 240,
  dates: ["2026-06-01", "2026-07-01"],
  ampsByDate: new Map([["2026-06-01", baseline.amps], ["2026-07-01", [0, 0, 60]]]),
  maxHoldByDate: new Map([["2026-06-01", 240], ["2026-07-01", 240]]),
};
const history = [{ id: "baseline-pull", grip: "Crusher", hand: "L", date: baseline.date, rep_num: 1, set_num: 1, avg_force_kg: 45, peak_force_kg: 50, actual_time_s: 50, target_duration: 30 }];
const props = {
  improvement: {}, gripImprovement: { Crusher: {} }, grip3xEstimates: { Crusher: [0, 0, 60] },
  gripBaselines: { Crusher: baseline }, selGrip: "Crusher", history,
  historyOverlay: { Crusher: { ...branch, perHand: { L: branch } } }, unit: "kg",
  perHandGripImprovement: { "Crusher|L": {} }, perHandGripBaselines: { "Crusher|L": baseline },
  perHandGripEstimates: { "Crusher|L": [0, 0, 60] },
};
const choose = name => fireEvent.click(screen.getByRole("button", { name, exact: true }));

test("percentage stays default; weight shows pounds or kilograms at the same domain duration", () => {
  const view = render(<CurveImprovementCard {...props} />);
  expect(screen.getByRole("button", { name: "%", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getAllByText("+20%")).toHaveLength(7);
  choose("Weight");
  const tile = screen.getByRole("button", { name: "Power session history" });
  expect(tile).toHaveTextContent("+9.4 kg");
  expect(tile).toHaveTextContent("47.0 → 56.4 kg");
  expect(tile).toHaveTextContent("at 30s");
  expect(screen.queryByText("total")).not.toBeInTheDocument();
  view.rerender(<CurveImprovementCard {...props} unit="lbs" />);
  expect(tile).toHaveTextContent("+20.7 lbs");
  fireEvent.click(tile);
  expect(screen.getByRole("dialog")).toHaveTextContent("Power history");
});

test("fixed weight survives scrubbing, view changes, and added workouts", () => {
  const view = render(<CurveImprovementCard {...props} />);
  choose("Hold time");
  const input = screen.getByRole("spinbutton", { name: "Fixed weight (kg)" });
  expect(input).toHaveValue(45);
  expect(screen.getByLabelText("Hold time comparison")).toHaveTextContent("50.6 → 138.1 seconds at 45.0 kg");
  fireEvent.change(input, { target: { value: "42" } });
  fireEvent.change(screen.getByRole("slider"), { target: { value: "0" } });
  expect(input).toHaveValue(42);
  expect(screen.getByLabelText("Hold time comparison")).toHaveTextContent("+0.0s");
  choose("Weight"); choose("Hold time");
  expect(screen.getByRole("spinbutton")).toHaveValue(42);
  view.rerender(<CurveImprovementCard {...props} history={[...history, { ...history[0], id: "later", date: "2026-08-01", avg_force_kg: 48 }]} />);
  expect(screen.getByRole("spinbutton")).toHaveValue(42);
});

test("bodyweight scaling never changes the fixed physical load", () => {
  const view = render(<CurveImprovementCard {...props} normalizeOn bodyWeight={60}
    bwLog={[{ date: baseline.date, kg: 50 }, { date: "2026-07-01", kg: 60 }]} />);
  expect(screen.getAllByText("+0%")).toHaveLength(7);
  choose("Weight");
  expect(screen.getByRole("button", { name: "Power session history" })).toHaveTextContent("+9.4 kg");
  choose("Hold time");
  expect(screen.getByRole("spinbutton")).toHaveValue(45);
  expect(screen.getByLabelText("Hold time comparison")).toHaveTextContent("50.6 → 138.1");
  view.rerender(<CurveImprovementCard {...props} unit="lbs" normalizeOn bodyWeight={70} />);
  expect(screen.getByRole("spinbutton")).toHaveValue(99.2);
  expect(screen.getByLabelText("Hold time comparison")).toHaveTextContent("50.6 → 138.1");
});

test("unreachable weight and unsupported duration show a reason instead of a fabricated gain", () => {
  render(<CurveImprovementCard {...props} />);
  choose("Hold time");
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "100" } });
  expect(screen.queryByLabelText("Hold time comparison")).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Not enough supported hold-time data");
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "1" } });
  expect(screen.queryByLabelText("Hold time comparison")).not.toBeInTheDocument();
});

test("hold-time evidence respects hand and selected date, excluding interruptions", () => {
  render(<CurveImprovementCard {...props} handView="L" history={[
    ...history,
    { ...history[0], id: "right", hand: "R", actual_time_s: 90 },
    { ...history[0], id: "interrupted", date: "2026-06-02", failure_valid: false, actual_time_s: 5 },
    { ...history[0], id: "future", date: "2026-08-01", actual_time_s: 100 },
  ]} />);
  choose("Hold time");
  const summary = screen.getByText("Recorded pulls at this weight (1)");
  expect(within(summary.parentElement).getByRole("list", { hidden: true })).toHaveTextContent("2026-06-01 · L · 50.0s");
});

test("hold-time weights are independent for each domain", () => {
  render(<CurveImprovementCard {...props} />); choose("Hold time");
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "42" } });
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "strength" } });
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "36" } });
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "power" } });
  expect(screen.getByRole("spinbutton")).toHaveValue(42);
});

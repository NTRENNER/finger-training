import React from "react";
import { render, screen } from "@testing-library/react";
import {
  PeakForceCard,
  formatPeakForceTooltip,
  peakForceTooltipRows,
} from "../PeakForceCard.jsx";

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterAll(() => {
  delete global.ResizeObserver;
});

test("new-PR tooltip names the workout that produced the peak", () => {
  const item = {
    dataKey: "Crusher_newPr",
    payload: {
      Crusher_newPr_context: { label: "Strength" },
    },
  };

  expect(formatPeakForceTooltip(176.4, "Crusher: New PR", item, "lbs")).toEqual([
    "176.4 lbs",
    "Crusher: New PR during Strength workout",
  ]);
});

test("ordinary series keep their original tooltip name", () => {
  const item = { dataKey: "Crusher_pr", payload: {} };

  expect(formatPeakForceTooltip(176.4, "Crusher PR", item, "lbs")).toEqual([
    "176.4 lbs",
    "Crusher PR",
  ]);
});

test("tooltip rows drop scatter internals and replace the matching PR line", () => {
  const source = { Crusher_newPr_context: { label: "Strength" } };
  const rows = peakForceTooltipRows([
    { dataKey: "Crusher_pr", name: "Crusher PR", value: 78, color: "orange", payload: source },
    { dataKey: "Crusher_newPr", name: "Crusher: New PR", value: 78, color: "orange", payload: source },
    { dataKey: "date", name: "date", value: "2026-07-06", payload: source },
    { dataKey: "Micro_pr", name: "Micro PR", value: 25, color: "red", payload: source },
  ], "kg");

  expect(rows).toEqual([
    {
      key: "Crusher_newPr",
      value: "78.0 kg",
      name: "Crusher: New PR during Strength workout",
      color: "orange",
    },
    {
      key: "Micro_pr",
      value: "25.0 kg",
      name: "Micro PR",
      color: "red",
    },
  ]);
});

const rep = (grip, hand, peak) => ({
  grip,
  hand,
  date: hand === "L" ? "2026-07-01" : "2026-07-02",
  rep_num: 1,
  target_duration: 7,
  actual_time_s: 8,
  peak_force_kg: peak,
  avg_force_kg: peak * 0.9,
});

test("focused grip removes every other grip from the card", () => {
  render(
    <PeakForceCard
      history={[
        rep("Crusher", "L", 60),
        rep("Micro", "L", 24),
      ]}
      grip="Crusher"
      unit="kg"
    />
  );

  expect(screen.getByText("Crusher")).toBeInTheDocument();
  expect(screen.queryByText("Micro")).not.toBeInTheDocument();
});

test("page hand scope replaces the card's compare-hands control", () => {
  render(
    <PeakForceCard
      history={[
        rep("Crusher", "L", 60),
        rep("Crusher", "R", 70),
      ]}
      grip="Crusher"
      handView="L"
      unit="kg"
    />
  );

  expect(screen.getByText(/60.0 kg/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Compare hands" })).not.toBeInTheDocument();
  expect(screen.getByText(/left hand/i)).toBeInTheDocument();
});

test("bodyweight scale uses the weight on each measurement date", () => {
  render(
    <PeakForceCard
      history={[
        { ...rep("Crusher", "L", 60), date: "2026-07-01" },
        { ...rep("Crusher", "L", 66), date: "2026-07-08" },
      ]}
      grip="Crusher"
      normalizeOn
      bodyWeight={80}
      bwLog={[
        { date: "2026-07-01", kg: 75 },
        { date: "2026-07-08", kg: 80 },
      ]}
      unit="kg"
    />
  );

  expect(screen.getByText(/0.82 × BW/)).toBeInTheDocument();
  expect(screen.getByText(/\+3%/)).toBeInTheDocument();
});

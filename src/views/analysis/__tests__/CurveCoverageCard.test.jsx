import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CurveCoverageCard, curveCoverageByGrip } from "../CurveCoverageCard.jsx";

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
  cleanup();
  jest.useRealTimers();
});

test("uses a real six-domain denominator for current evidence", () => {
  const history = [30, 70, 115, 160, 220].map(duration =>
    rep("2026-07-20", duration)
  );

  render(<CurveCoverageCard history={history} />);

  expect(screen.getByText("Curve coverage")).toBeInTheDocument();
  expect(screen.getByLabelText("6 of 6 domains current")).toBeInTheDocument();
  expect(screen.getByText("All domains have current evidence.")).toBeInTheDocument();
  expect(screen.queryByText(/annual/i)).not.toBeInTheDocument();
});

test("names missing, aging, and stale domains instead of hiding them in a score", () => {
  const history = [
    rep("2026-07-05", 30),
    rep("2026-06-01", 70, { peak_force_kg: null }),
  ];
  const coverage = curveCoverageByGrip(history).Crusher;

  expect(coverage.current).toBe(1);
  expect(coverage.aging).toEqual(["Power"]);
  expect(coverage.stale).toEqual(["Power-Strength"]);
  expect(coverage.missing).toEqual([
    "Strength",
    "Strength-Endurance",
    "Endurance",
  ]);

  render(<CurveCoverageCard history={history} />);
  expect(screen.getByLabelText("Aging: Power")).toBeInTheDocument();
  expect(screen.getByLabelText("Stale: Power-Strength")).toBeInTheDocument();
  expect(screen.getByLabelText(/Missing:.*Endurance/)).toBeInTheDocument();
});

test("all-grips mode renders every recorded grip", () => {
  render(
    <CurveCoverageCard
      history={[
        rep("2026-07-20", 30),
        rep("2026-07-20", 70, { grip: "Micro" }),
      ]}
    />
  );

  expect(screen.getByText("Crusher")).toBeInTheDocument();
  expect(screen.getByText("Micro")).toBeInTheDocument();
});

test("focused grip and hand remove unrelated evidence", () => {
  render(
    <CurveCoverageCard
      grip="Crusher"
      handView="L"
      history={[
        rep("2026-07-20", 30),
        rep("2026-07-20", 70, { grip: "Micro" }),
        rep("2026-07-20", 115, { hand: "R" }),
      ]}
    />
  );

  expect(screen.getByText("Crusher")).toBeInTheDocument();
  expect(screen.queryByText("Micro")).not.toBeInTheDocument();
  expect(screen.getByLabelText("2 of 6 domains current")).toBeInTheDocument();
});

test("a grip row opens finger history with its active hand scope", () => {
  const onOpenHistory = jest.fn();
  render(
    <CurveCoverageCard
      history={[rep("2026-07-20", 30, { hand: "R" })]}
      handView="R"
      onOpenHistory={onOpenHistory}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "Open Crusher finger history" }));
  expect(onOpenHistory).toHaveBeenCalledWith({ grip: "Crusher", handView: "R" });
});

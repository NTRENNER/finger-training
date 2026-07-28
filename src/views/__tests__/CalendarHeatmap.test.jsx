import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { CalendarHeatmap } from "../CalendarHeatmap.jsx";

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(2026, 6, 28, 12));
});

afterEach(() => {
  jest.useRealTimers();
});

test("renders a fixed rolling year and distinguishes pre-tracking days", () => {
  render(
    <CalendarHeatmap
      history={[{
        date: "2026-04-20",
        session_id: "s1",
        grip: "Crusher",
        hand: "L",
      }]}
    />
  );

  expect(screen.getByText("Last 12 months")).toBeInTheDocument();
  expect(screen.getByText("Tracking since April 2026")).toBeInTheDocument();
  expect(screen.getByText(/1 active day · 1 finger/)).toBeInTheDocument();
  expect(screen.getAllByText("Jul")).toHaveLength(1);
  expect(screen.getAllByRole("button")).toHaveLength(365);

  const beforeTracking = screen.getByTitle("2026-04-19 · Before tracking began");
  expect(beforeTracking).toBeDisabled();
  expect(beforeTracking).toHaveStyle({ width: "10px", height: "10px" });

  const firstTrackedDay = screen.getByTitle("2026-04-20 · 1 activity");
  expect(firstTrackedDay).not.toBeDisabled();
  fireEvent.click(firstTrackedDay);
  expect(screen.getByText(/Mon, Apr 20, 2026/)).toBeInTheDocument();
});

test("limits headline totals to the visible rolling year", () => {
  render(
    <CalendarHeatmap
      history={[
        { date: "2025-07-20", session_id: "old", grip: "Crusher", hand: "L" },
        { date: "2026-07-20", session_id: "current", grip: "Micro", hand: "R" },
      ]}
    />
  );

  expect(screen.getByText(/1 active day · 1 finger/)).toBeInTheDocument();
});

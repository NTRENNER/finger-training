import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { CurveCoverageCard } from "../CurveCoverageCard.js";

const rep = (date, actual_time_s) => ({
  grip: "Crusher",
  hand: "L",
  date,
  rep_num: 1,
  actual_time_s,
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(2026, 6, 23, 12));
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

test("stays hidden when every sampled zone is fresh", () => {
  const history = [5, 30, 70, 115, 160, 220].map(duration =>
    rep("2026-07-20", duration)
  );

  const { container } = render(<CurveCoverageCard history={history} />);
  expect(container.firstChild).toBeNull();
});

test("renders only when a sampled zone needs attention", () => {
  render(<CurveCoverageCard history={[rep("2026-05-01", 30)]} />);

  expect(screen.getByText("Curve Coverage")).toBeInTheDocument();
  expect(screen.getByText(/data that needs attention/i)).toBeInTheDocument();
  expect(screen.getByText(/1 stale/i)).toBeInTheDocument();
  expect(screen.queryByText(/modeled/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/last 12 months/i)).not.toBeInTheDocument();
});

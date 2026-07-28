import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { CurveCoverageCard } from "../CurveCoverageCard.js";

const rep = (date, actual_time_s, over = {}) => ({
  grip: "Crusher",
  hand: "L",
  date,
  rep_num: 1,
  actual_time_s,
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

test("all-grips mode shows every grip needing attention without local selectors", () => {
  render(
    <CurveCoverageCard
      history={[
        rep("2026-05-01", 30),
        rep("2026-05-01", 70, { grip: "Micro" }),
      ]}
    />
  );

  expect(screen.getByText("Crusher")).toBeInTheDocument();
  expect(screen.getByText("Micro")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Crusher" })).not.toBeInTheDocument();
});

test("focused grip and hand remove unrelated coverage", () => {
  render(
    <CurveCoverageCard
      grip="Crusher"
      handView="L"
      history={[
        rep("2026-05-01", 30),
        rep("2026-05-01", 70, { grip: "Micro" }),
        rep("2026-05-01", 115, { hand: "R" }),
      ]}
    />
  );

  expect(screen.getByText(/left hand/i)).toBeInTheDocument();
  expect(screen.getByText(/Power/i)).toBeInTheDocument();
  expect(screen.queryByText("Micro")).not.toBeInTheDocument();
  expect(screen.queryByText(/Strength$/i)).not.toBeInTheDocument();
});

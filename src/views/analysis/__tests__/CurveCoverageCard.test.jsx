import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CurveCoverageCard } from "../CurveCoverageCard.jsx";

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

test("shows exposure separately even when opening measurements are current", () => {
  const history = [5, 30, 70, 115, 160, 220].map(duration =>
    rep("2026-07-20", duration)
  );

  render(<CurveCoverageCard history={history} />);
  expect(screen.getByText("Training & measurements")).toBeInTheDocument();
  expect(screen.getByText("Opening measurement")).not.toBeVisible();
  userEvent.click(screen.getByText("Training & measurements"));
  expect(screen.getByText("Opening measurement")).toBeVisible();
  userEvent.click(screen.getByText("Training & measurements"));
  expect(screen.getByText("Opening measurement")).not.toBeVisible();
  expect(screen.queryByText(/1 stale/)).not.toBeInTheDocument();
});

test("renders only when a sampled zone needs attention", () => {
  render(<CurveCoverageCard history={[rep("2026-05-01", 30)]} />);

  expect(screen.getByText("Training & measurements")).toBeInTheDocument();
  expect(screen.getByText(/Training exposure and fresh-curve evidence/i)).toBeInTheDocument();
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
  expect(screen.getAllByText(/Power/i).length).toBeGreaterThan(0);
  expect(screen.queryByText("Micro")).not.toBeInTheDocument();
  expect(screen.queryByText("2026-05-01 · R")).not.toBeInTheDocument();
});

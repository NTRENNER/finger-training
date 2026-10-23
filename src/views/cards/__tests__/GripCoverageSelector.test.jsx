import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GripCoverageSelector } from "../GripCoverageSelector.jsx";

const GRIPS = ["Crusher", "Micro", "Prime"];
const rep = (duration, over = {}) => ({
  grip: "Crusher",
  hand: "L",
  date: "2026-07-20",
  session_id: `session-${duration}`,
  set_num: 1,
  rep_num: 1,
  target_duration: duration,
  actual_time_s: duration,
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

test("renders all three coverage rings in one selector", () => {
  render(<GripCoverageSelector history={[]} grips={GRIPS} value="Crusher" />);

  expect(screen.getByRole("group", { name: "Training device" })).toHaveStyle({
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  });
  for (const grip of GRIPS) {
    expect(screen.getByRole("button", { name: `${grip}, 0 of 6 domains current` })).toBeInTheDocument();
  }
  expect(screen.getByRole("button", { name: /Crusher, 0 of 6/ })).toHaveAttribute("aria-pressed", "true");
});

test("selecting a ring changes the device and its evidence summary", () => {
  const onChange = jest.fn();
  const { rerender } = render(
    <GripCoverageSelector history={[rep(30)]} grips={GRIPS} value="Crusher" onChange={onChange} />
  );

  expect(screen.getByLabelText(/Missing:.*Endurance/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Micro, 0 of 6/ }));
  expect(onChange).toHaveBeenCalledWith("Micro");

  rerender(<GripCoverageSelector history={[rep(30)]} grips={GRIPS} value="Micro" onChange={onChange} />);
  expect(screen.getByText("Micro", { selector: "strong" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Micro, 0 of 6/ })).toHaveAttribute("aria-pressed", "true");
});

test("reports complete current evidence without an issue list", () => {
  render(
    <GripCoverageSelector
      history={[30, 70, 115, 160, 220].map(duration => rep(duration))}
      grips={GRIPS}
      value="Crusher"
    />
  );

  expect(screen.getByRole("button", { name: "Crusher, 6 of 6 domains current" })).toBeInTheDocument();
  expect(screen.getByText(/all six domains have current evidence/i)).toBeInTheDocument();
});

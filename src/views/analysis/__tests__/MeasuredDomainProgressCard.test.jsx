import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MeasuredDomainProgressCard } from "../MeasuredDomainProgressCard.jsx";

const rep = (id, date, target, actual, force, extra = {}) => ({
  id,
  session_id: id,
  date,
  grip: "Micro",
  hand: "L",
  set_num: 1,
  rep_num: 1,
  target_duration: target,
  actual_time_s: actual,
  avg_force_kg: force,
  peak_force_kg: force + 5,
  failure_valid: true,
  load_provenance: "measured_force",
  force_recording: { capacity_eligible: true },
  ...extra,
});

test("shows first-to-latest actual force and time for all trained domains plus peak", () => {
  render(<MeasuredDomainProgressCard history={[
    rep("old", "2026-06-01", 30, 5, 30),
    rep("new", "2026-07-01", 30, 30, 30),
  ]} grips={["Micro"]} handView="L" unit="kg" asOf="2026-07-02" />);

  expect(screen.getByRole("heading", { name: "Actual Progress by Domain" })).toBeInTheDocument();
  const group = screen.getByRole("region", { name: "Micro actual domain progress" });
  expect(within(group).getByText("Peak Force")).toBeInTheDocument();
  expect(within(group).getByText("Power")).toBeInTheDocument();
  expect(within(group).getByText("30.0 kg for 5 s")).toBeInTheDocument();
  expect(within(group).getByText("30.0 kg for 30 s")).toBeInTheDocument();
  expect(within(group).getByText("same force · +25.0 s time")).toBeInTheDocument();
  expect(within(group).getByText("Power-Strength")).toBeInTheDocument();
  expect(within(group).getByText("Strength")).toBeInTheDocument();
  expect(within(group).getByText("Strength-Endurance")).toBeInTheDocument();
  expect(within(group).getByText("Endurance")).toBeInTheDocument();
});

test("domain history remains available workout by workout", () => {
  render(<MeasuredDomainProgressCard history={[
    rep("old", "2026-06-01", 30, 28, 12),
    rep("new", "2026-07-01", 30, 35, 15),
  ]} grips={["Micro"]} handView="L" unit="kg" asOf="2026-07-02" />);
  fireEvent.click(screen.getByRole("button", { name: "View Power workout history" }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.getByText("Power history")).toBeInTheDocument();
  expect(screen.getByText("2 sessions", { exact: false })).toBeInTheDocument();
});

test("empty selections explain that no actual comparison exists", () => {
  render(<MeasuredDomainProgressCard history={[]} grips={["Prime"]} asOf="2026-07-02" />);
  expect(screen.getByText(/No qualifying measured opening holds/)).toBeInTheDocument();
  expect(screen.queryByText("Estimated Capacity Over Time")).not.toBeInTheDocument();
});

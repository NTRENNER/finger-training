import React from "react";
import { render, screen } from "@testing-library/react";
import { RepResultDetails } from "../RepResultDetails.jsx";

// 2026-10-19 Crusher Peak Test: five complete pulls and one aborted pull
// (0.4 s, 4.5 kg). History labeled all six "Interrupted" because a peak
// pull is stored with failure_valid false by design.
const protocol = { id: "peak_test", source: "warmup", version: 2, position: 1, duration_reference: "brief_maximum_not_failure" };
const pull = over => ({ failure_valid: false, peak_force_kg: 69.9, actual_time_s: 3.0, end_reason: "peak_test_complete",
  force_recording: { session_protocol: protocol, peak_valid: true, capacity_eligible: false }, ...over });

test("a complete Peak Test pull carries no interruption label", () => {
  render(<RepResultDetails rep={pull()} />);
  expect(screen.queryByText("Interrupted")).not.toBeInTheDocument();
  expect(screen.getByText("Peak measurement — not a failure hold")).toBeInTheDocument();
});

test("an aborted Peak Test pull still reads as interrupted", () => {
  render(<RepResultDetails rep={pull({ peak_force_kg: 4.5, actual_time_s: 0.4, end_reason: "interrupted",
    force_recording: { session_protocol: protocol, peak_valid: false, capacity_eligible: false } })} />);
  expect(screen.getByText("Interrupted")).toBeInTheDocument();
});

test("an invalid training hold still reads as interrupted", () => {
  render(<RepResultDetails rep={{ failure_valid: false, end_reason: "equipment_interruption", actual_time_s: 38.8 }} />);
  expect(screen.getByText("Interrupted")).toBeInTheDocument();
});

// Finding 6: the anti-collapse floor (extrapFloored) is computed by the
// prescription engine but was never shown. This asserts the flag now
// surfaces as a visible caption on the per-zone load card so the user
// knows a long-hold number is a sane floor, not a literal curve read.
import React from "react";
import { render, screen } from "@testing-library/react";
import { PrescribedLoadCard } from "../PrescribedLoadCard.js";

// Force a floored, extrapolating prescription for every zone/hand.
jest.mock("../../../model/prescription.js", () => ({
  prescription: () => ({
    value: 5, reliability: "extrapolation", extrapFloored: true,
    extrapolationBoundaryS: 180,
  }),
}));
// Keep the rest of the card inert.
jest.mock("../../../model/coaching.js", () => ({
  coachingRecommendationContinuous: () => ({ zone: "endurance" }),
}));
jest.mock("../../../model/fatigueBeta.js", () => ({
  capacityMultiplier: () => 1,
}));

const GOAL_CONFIG = {
  max_strength:       { label: "Max Strength",       emoji: "💥", color: "#c83838", refTime: 5 },
  power:              { label: "Power",              emoji: "⚡", color: "#e05560", refTime: 30 },
  power_strength:     { label: "Power/Strength",     emoji: "🔶", color: "#e68a48", refTime: 70 },
  strength:           { label: "Strength",           emoji: "💪", color: "#e07a30", refTime: 115 },
  strength_endurance: { label: "Strength/Endurance", emoji: "🟶", color: "#7aa0d8", refTime: 160 },
  endurance:          { label: "Endurance",          emoji: "🏔️", color: "#3b82f6", refTime: 220 },
};

test("surfaces the anti-collapse floor caption when a zone is floored", () => {
  render(
    <PrescribedLoadCard
      history={[{ grip: "Micro", hand: "L", actual_time_s: 30 }]}
      grip="Micro"
      unit="lbs"
      GOAL_CONFIG={GOAL_CONFIG}
    />
  );
  // One caption per zone tile (6 zones), all floored in this mock.
  expect(screen.getAllByText(/unsupported beyond 180s/).length).toBeGreaterThan(0);
});

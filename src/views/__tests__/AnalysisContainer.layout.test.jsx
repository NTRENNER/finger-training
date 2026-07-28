import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { AnalysisContainer } from "../AnalysisContainer.js";

jest.mock("../../lib/storage.js", () => ({
  loadLS: jest.fn(() => null),
  saveLS: jest.fn(),
  LS_ANALYSIS_SUBTAB_KEY: "ft_analysis_subtab",
}));

jest.mock("../cards/WeeklyReviewCard.jsx", () => ({
  WeeklyReviewCard: () => <div>Weekly review</div>,
}));
jest.mock("../AnalysisView.js", () => ({
  AnalysisView: () => <div>Finger analysis</div>,
}));
jest.mock("../WorkoutAnalysisView.js", () => ({
  WorkoutAnalysisView: () => <div>Lift analysis</div>,
}));
jest.mock("../ClimbingAnalysisView.js", () => ({
  ClimbingAnalysisView: () => <div>Climb analysis</div>,
}));
jest.mock("../BodyWeightAnalysisView.js", () => ({
  BodyWeightAnalysisView: () => <div>Weight analysis</div>,
}));

test("all analysis tabs render in the same responsive content column", () => {
  render(<AnalysisContainer />);

  const content = screen.getByTestId("analysis-content");
  expect(content).toHaveStyle({
    width: "100%",
    maxWidth: "720px",
    margin: "0 auto",
  });
  expect(within(content).getByText("Finger analysis")).toBeInTheDocument();

  for (const [tab, view] of [
    ["Lifts", "Lift analysis"],
    ["Climbs", "Climb analysis"],
    ["Weight", "Weight analysis"],
    ["Fingers", "Finger analysis"],
  ]) {
    fireEvent.click(screen.getByRole("button", { name: tab }));
    expect(within(content).getByText(view)).toBeInTheDocument();
    expect(screen.getByTestId("analysis-content")).toBe(content);
  }
});

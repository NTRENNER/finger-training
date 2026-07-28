import React from "react";
import { render, screen } from "@testing-library/react";
import { CapacityTrajectoryCard } from "../CapacityChartCards.js";

test("shows baseline progress when a grip is not ready for a capacity line", () => {
  render(
    <CapacityTrajectoryCard
      capacityHistoryByGrip={{
        grips: [],
        pctRows: [],
        pctRowsBW: [],
        hasPct: false,
        readinessByGrip: {
          Prime: {
            qualifyingReps: 2,
            distinctDurations: 2,
            distinctDates: 2,
            baselineReady: false,
            plottedSessions: 0,
            trajectoryReady: false,
          },
        },
      }}
      normalizeOn={false}
      activities={[]}
    />
  );

  expect(screen.getByText("Prime")).toBeInTheDocument();
  expect(screen.getByText(/2 of 5 fresh reps/)).toBeInTheDocument();
  expect(screen.getByText(/2 of 3 target durations/)).toBeInTheDocument();
  expect(screen.getByText(/will appear automatically/)).toBeInTheDocument();
});

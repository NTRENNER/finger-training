import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { FingerTrainingLoadCard } from "../FingerTrainingLoadCard.jsx";

jest.mock("../../../util.js", () => ({ today: () => "2026-10-27" }));
jest.mock("recharts", () => ({
  ResponsiveContainer: ({ children }) => <div>{children}</div>,
  ComposedChart: ({ children }) => <div>{children}</div>,
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  ReferenceLine: () => null,
  Bar: ({ dataKey }) => <div data-testid="load-bars">{dataKey}</div>,
}));

const history = [
  {
    id: "training",
    date: "2026-10-27",
    session_id: "session",
    grip: "Crusher",
    hand: "L",
    actual_time_s: 60,
    avg_force_kg: 10,
  },
  {
    id: "peak",
    date: "2026-10-27",
    session_id: "peak-session",
    grip: "Crusher",
    hand: "L",
    actual_time_s: 3,
    avg_force_kg: 50,
    force_recording: { session_protocol: { id: "peak_test" } },
  },
];

const DAY_MS = 86400000;
const responseDate = days => new Date(Date.parse("2026-04-06T00:00:00Z") + days * DAY_MS).toISOString().slice(0, 10);

test("switches between scoped time-under-tension and load-volume totals", () => {
  render(<FingerTrainingLoadCard history={history} grips={["Crusher"]} handView="L" unit="kg" />);

  expect(screen.getByRole("heading", { name: "Finger training load" })).toBeInTheDocument();
  expect(screen.getByTestId("load-bars")).toHaveTextContent("time");
  expect(screen.getByText("1.0 min", { exact: false })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Volume" }));
  expect(screen.getByTestId("load-bars")).toHaveTextContent("volume");
  expect(screen.getByText("10.0 kg·min", { exact: false })).toBeInTheDocument();
});

test("shows a compact lagged response once repeated dose and performance evidence is available", () => {
  const responseHistory = [], observations = [];
  for (let week = 0; week < 24; week += 1) {
    if (week % 4 === 0) responseHistory.push({
      id: `rep-${week}`,
      date: responseDate(week * 7),
      session_id: `session-${week}`,
      grip: "Crusher",
      hand: "L",
      actual_time_s: 60,
      avg_force_kg: 10,
    });
    const phase = week % 4;
    observations.push({
      id: `observation-${week}`,
      date: responseDate(week * 7 + 1),
      grip: "Crusher",
      hand: "L",
      deviation: phase === 1 ? -6 : phase >= 2 ? 8 : 0,
      context: "first_recorded",
      extrapolated: false,
    });
  }

  render(<FingerTrainingLoadCard history={responseHistory} performanceObservations={observations}
    grips={["Crusher"]} handView="L" unit="kg" />);

  const response = screen.getByRole("region", { name: "Training load response" });
  expect(response).toHaveTextContent("Short dip, later rebound");
  expect(response).toHaveTextContent("Next 7 days");
  expect(response).toHaveTextContent("Days 8–21");
  expect(response).toHaveTextContent("Association only · prescriptions unchanged");
});

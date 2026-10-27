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

test("switches between scoped time-under-tension and load-volume totals", () => {
  render(<FingerTrainingLoadCard history={history} grips={["Crusher"]} handView="L" unit="kg" />);

  expect(screen.getByRole("heading", { name: "Finger training load" })).toBeInTheDocument();
  expect(screen.getByTestId("load-bars")).toHaveTextContent("time");
  expect(screen.getByText("1.0 min", { exact: false })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Volume" }));
  expect(screen.getByTestId("load-bars")).toHaveTextContent("volume");
  expect(screen.getByText("10.0 kg·min", { exact: false })).toBeInTheDocument();
});

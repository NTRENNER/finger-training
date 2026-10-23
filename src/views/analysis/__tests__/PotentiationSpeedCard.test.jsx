import React from "react";
import { render, screen } from "@testing-library/react";
import { PotentiationSpeedCard } from "../PotentiationSpeedCard.jsx";

jest.mock("recharts", () => ({
  ResponsiveContainer: ({ children }) => <div>{children}</div>,
  ComposedChart: ({ data, children }) => <div data-testid="speed-chart" data-dates={data.map(row => row.date).join(",")}>{children}</div>,
  Line: () => null,
  Scatter: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  CartesianGrid: () => null,
}));

const row = (date, grip, hand, value) => ({
  date, grip, hand, session_id: `${date}-${grip}`,
  force_recording: {
    session_protocol: { id: "warmup_potentiation", version: 1 },
    potentiation_rfd: { valid: true, rfd_200_kg_s: value },
  },
});

test("shows the scoped potentiation speed history without explanatory clutter", () => {
  render(<PotentiationSpeedCard history={[
    row("2026-10-22", "Crusher", "L", 100),
    row("2026-10-23", "Crusher", "L", 110),
    row("2026-10-23", "Micro", "L", 30),
  ]} grips={["Crusher"]} handView="L" unit="kg" />);

  expect(screen.getByRole("heading", { name: "Potentiation speed" })).toBeInTheDocument();
  expect(screen.getByText("Force rise at 200 ms")).toBeInTheDocument();
  expect(screen.getByText("Median per warm-up")).toBeInTheDocument();
  expect(screen.getByTestId("speed-chart")).toHaveAttribute("data-dates", "10-22,10-23");
  expect(screen.queryByText("Micro")).not.toBeInTheDocument();
});

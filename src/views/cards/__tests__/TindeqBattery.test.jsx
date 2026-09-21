import React from "react";
import { render, screen } from "@testing-library/react";
import { TindeqBattery, InterruptedBatteryNote } from "../TindeqBattery.jsx";

test("shows measured voltage without suggesting a charge percentage or a healthy battery", () => {
  render(<TindeqBattery connected battery={{ status: "available", voltage_mv: 3010, voltage_read_at_ms: 1000 }} />);
  expect(screen.getByRole("status")).toHaveTextContent("3.01 V · charge level unavailable");
  expect(screen.getByRole("status")).toHaveTextContent("Last checked");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
test("low battery warning says replace and stays visible after a disconnect", () => {
  render(<TindeqBattery connected={false} warningOnly battery={{ low_battery_warning: true }} />);
  expect(screen.getByRole("alert")).toHaveTextContent("Tindeq battery low—replace the battery.");
});
test("unknown battery is explicit during setup but quiet during a normal rep", () => {
  const { rerender } = render(<TindeqBattery connected battery={{ status: "unavailable" }} />);
  expect(screen.getByText("Battery status unavailable")).toBeInTheDocument();
  rerender(<TindeqBattery connected warningOnly battery={{ status: "unavailable" }} />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
test("interruption context distinguishes observed warning from proven cause", () => {
  render(<InterruptedBatteryNote battery={{ voltage_mv: 2700, low_battery_warning: true }} />);
  expect(screen.getByText(/Last battery reading/)).toHaveTextContent("2.70 V");
  expect(screen.getByText(/Last battery reading/)).toHaveTextContent("does not confirm the cause");
});

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { DeloadGauge } from "../DeloadGauge.jsx";

const greenStatus = {
  level: "green",
  pressure: 0.2,
  label: "Fresh — absorbing your load well",
  haveSignal: true,
  deload: { severity: "none" },
};

test("scrubs recovery checkpoints and labels the live endpoint Now", () => {
  const onChange = jest.fn();
  const timelineDates = ["2026-06-01", "2026-06-15", "2026-07-23"];
  const { rerender } = render(
    <DeloadGauge
      status={greenStatus}
      timelineDates={timelineDates}
      asOfDate="2026-07-23"
      currentDate="2026-07-23"
      onAsOfDateChange={onChange}
    />
  );

  const slider = screen.getByRole("slider", { name: "Recovery status history" });
  expect(slider).toHaveValue("2");
  expect(screen.getByText(/As of:/).textContent).toContain("Now");

  fireEvent.change(slider, { target: { value: "0" } });
  expect(onChange).toHaveBeenCalledWith("2026-06-01");

  rerender(
    <DeloadGauge
      status={greenStatus}
      timelineDates={timelineDates}
      asOfDate="2026-06-01"
      currentDate="2026-07-23"
      onAsOfDateChange={onChange}
    />
  );
  expect(screen.getByText(/As of:/).textContent).toContain("Jun 1, 2026");
  expect(screen.getByText(/How close you were/i)).toBeInTheDocument();
});

test("hides the slider until there is historical range to scrub", () => {
  render(
    <DeloadGauge
      status={greenStatus}
      timelineDates={["2026-07-23"]}
      asOfDate="2026-07-23"
      currentDate="2026-07-23"
      onAsOfDateChange={() => {}}
    />
  );

  expect(screen.queryByRole("slider", { name: "Recovery status history" })).not.toBeInTheDocument();
});

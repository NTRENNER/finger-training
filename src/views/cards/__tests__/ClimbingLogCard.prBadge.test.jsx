import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { ClimbingLogCard } from "../ClimbingLogCard.js";

test("celebrates a context PR and reports the badge upgrade", () => {
  const onLog = jest.fn();
  const activities = [{
    date: "2026-07-01",
    type: "climbing",
    discipline: "boulder",
    venue: "indoor",
    wall: "commercial",
    grade: "V2",
    ascent: "redpoint",
  }];

  render(<ClimbingLogCard activities={activities} onLog={onLog} />);
  fireEvent.click(screen.getByRole("button", { name: /log a climb/i }));

  fireEvent.change(screen.getByRole("combobox"), { target: { value: "V3" } });
  fireEvent.click(screen.getByRole("button", { name: /^log climb$/i }));

  expect(onLog).toHaveBeenCalledWith(expect.objectContaining({
    type: "climbing",
    discipline: "boulder",
    venue: "indoor",
    wall: "commercial",
    grade: "V3",
    ascent: "flash",
  }));
  expect(screen.getByText("V3 Commercial PR!")).toBeInTheDocument();
  expect(screen.getByText(/Badge upgraded · V2 → V3/)).toBeInTheDocument();
});

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
  expect(screen.getByRole("combobox")).toBeVisible();

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
  expect(screen.getByRole("combobox")).toBeVisible();
  expect(screen.getByRole("button", { name: /^log climb$/i })).toBeVisible();
  expect(screen.getByText("V3 Commercial PR!")).toBeInTheDocument();
  expect(screen.getByText(/Badge upgraded · V2 → V3/)).toBeInTheDocument();
});


test("logs consecutive climbs without reopening and clears the prior climb's name", () => {
  const onLog = jest.fn();
  render(<ClimbingLogCard onLog={onLog} />);
  fireEvent.change(screen.getByPlaceholderText(/Name this climb/), { target: { value: "First climb" } });
  fireEvent.click(screen.getByRole("button", { name: /^log climb$/i }));
  expect(onLog.mock.calls[0][0].route_name).toBe("First climb");
  expect(screen.getByPlaceholderText(/Name this climb/)).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: /^log climb$/i }));
  expect(onLog).toHaveBeenCalledTimes(2);
  expect(onLog.mock.calls[1][0]).not.toHaveProperty("route_name");
});


test("multiple attempts switch a first-try send to Send and preserve non-send styles", () => {
 const onLog=jest.fn(); render(<ClimbingLogCard onLog={onLog}/>);
 fireEvent.click(screen.getByRole("button",{name:"10",exact:true}));
 expect(screen.getByText(/Changed to Send/)).toBeVisible();
 expect(screen.getByRole("button",{name:/Flash 1st/})).toBeDisabled();
 expect(screen.getByRole("button",{name:/Onsight 1st/})).toBeDisabled();
 fireEvent.click(screen.getByRole("button",{name:/^log climb$/i}));
 expect(onLog.mock.calls[0][0]).toMatchObject({attempts:10,ascent:"redpoint"});
 fireEvent.click(screen.getByRole("button",{name:/Attempt Worked/}));
 fireEvent.click(screen.getByRole("button",{name:"3",exact:true}));
 fireEvent.click(screen.getByRole("button",{name:/^log climb$/i}));
 expect(onLog.mock.calls[1][0]).toMatchObject({attempts:3,ascent:"attempt"});
});

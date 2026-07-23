import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { ClimbingPrBadgeCollection } from "../ClimbingPrBadgeCollection.jsx";

const climb = (grade, over = {}) => ({
  date: "2026-07-20",
  type: "climbing",
  discipline: "boulder",
  venue: "indoor",
  wall: "commercial",
  grade,
  ascent: "redpoint",
  ...over,
});

test("renders nothing until a clean-send PR exists", () => {
  const { container } = render(
    <ClimbingPrBadgeCollection climbs={[climb("V5", { ascent: "repeat" })]} />
  );
  expect(container).toBeEmptyDOMElement();
});

test("expands context badges with source and date details", () => {
  render(
    <ClimbingPrBadgeCollection climbs={[
      climb("V6", { wall: "moonboard", ascent: "flash" }),
      climb("5.11c", {
        discipline: "lead",
        venue: "outdoor",
        wall: undefined,
        grade: "5.11c",
        ascent: "onsight",
        route_name: "The Journey",
      }),
    ]} />
  );

  expect(screen.getByText("Climbing PRs")).toBeInTheDocument();
  expect(screen.getByText("V6 · 5.11c")).toBeInTheDocument();
  expect(screen.queryByText("Indoor MoonBoard")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /climbing prs/i }));

  expect(screen.getByText("Indoor MoonBoard")).toBeInTheDocument();
  expect(screen.getByText("Outdoor Route")).toBeInTheDocument();
  expect(screen.getByText("The Journey")).toBeInTheDocument();
  expect(screen.getByText(/Lead · Onsight/)).toBeInTheDocument();
  expect(screen.getAllByText(/Jul 20, 2026/)).toHaveLength(2);
});

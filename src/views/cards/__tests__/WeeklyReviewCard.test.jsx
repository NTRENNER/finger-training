import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { C } from "../../../ui/theme.js";
import { buildCheckIn } from "../../../model/weeklyReview.js";
import { WeeklyReviewCard } from "../WeeklyReviewCard.jsx";

jest.mock("../../../model/weeklyReview.js", () => ({
  buildCheckIn: jest.fn(),
}));

beforeEach(() => {
  buildCheckIn.mockReturnValue({
    range: { weekStart: "2026-07-13", weekEnd: "2026-07-19" },
    headline: "Strong week — you've got a win to bank.",
    points: [
      { kind: "win", text: "Colored win summary." },
      { kind: "concern", text: "Colored recovery summary." },
    ],
    sections: {
      did: ["Two climbing sessions."],
      moving: ["Capacity moved up."],
      stuck: [],
      focus: ["The engine will queue Micro."],
      headsUp: ["Data looks clean."],
    },
  });
});

test("keeps the colored digest above the expanded coaching report", () => {
  render(<WeeklyReviewCard />);

  const win = screen.getByText("Colored win summary.");
  const concern = screen.getByText("Colored recovery summary.");
  expect(win).toHaveStyle(`color: ${C.green}`);
  expect(concern).toHaveStyle(`color: ${C.orange}`);
  expect(screen.queryByText("What you did")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /full check-in/i }));

  expect(screen.getByRole("button", { name: /compact/i })).toHaveAttribute("aria-expanded", "true");
  expect(win).toBeInTheDocument();
  expect(concern).toBeInTheDocument();
  expect(win).toHaveStyle(`color: ${C.green}`);
  expect(concern).toHaveStyle(`color: ${C.orange}`);
  expect(screen.getByText("What you did")).toBeInTheDocument();
  expect(screen.getByText("Two climbing sessions.")).toBeInTheDocument();
  expect(screen.getByText("What the engine will recommend — and why")).toBeInTheDocument();
});

test("collapsing hides only the report", () => {
  render(<WeeklyReviewCard />);

  fireEvent.click(screen.getByRole("button", { name: /full check-in/i }));
  fireEvent.click(screen.getByRole("button", { name: /compact/i }));

  expect(screen.getByText("Colored win summary.")).toBeInTheDocument();
  expect(screen.queryByText("What you did")).not.toBeInTheDocument();
});

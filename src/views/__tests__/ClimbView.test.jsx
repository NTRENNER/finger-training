// The Climb tab: warm-up entry, the climb logger and the recent-climbs digest.
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { ClimbView } from "../ClimbView.jsx";

jest.mock("../cards/ClimbingLogCard.jsx", () => ({
  ClimbingLogCard: ({ activities, onLog }) =>
    <button onClick={() => onLog({ type: "climbing", grade: "V5" })}>log card ({activities.length})</button>,
}));
jest.mock("../WarmupView.jsx", () => ({
  WarmupView: ({ onClose, onBwSave, bodyWeightKg, unit }) => <div>
    <p>warm-up screen · {bodyWeightKg ?? "no weight"} · {unit} · {onBwSave ? "can save weight" : "no save"}</p>
    <button onClick={onClose}>Back</button>
  </div>,
}));

const climb = (n, extra = {}) => ({
  id: `c${n}`, type: "climbing", date: `2026-10-${String(n).padStart(2, "0")}`,
  discipline: "boulder", grade: `V${n % 8}`, ascent: "send", ...extra,
});

beforeEach(() => localStorage.clear());

test("with no climbs it shows the empty digest and still offers the logger and warm-up", () => {
  render(<ClimbView activities={[]} />);
  expect(screen.getByRole("heading", { name: "Climbing" })).toBeInTheDocument();
  expect(screen.getByText("0 total")).toBeInTheDocument();
  expect(screen.getByText(/Your climbs will appear here/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Plan warm-up" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /log card/ })).toBeInTheDocument();
});

test("a logged climb goes to onLogActivity", () => {
  const onLogActivity = jest.fn();
  render(<ClimbView activities={[]} onLogActivity={onLogActivity} />);
  fireEvent.click(screen.getByRole("button", { name: /log card/ }));
  expect(onLogActivity).toHaveBeenCalledWith({ type: "climbing", grade: "V5" });
});

test("the digest counts only climbs, newest first, and names the route", () => {
  const activities = [
    climb(3, { grade: "V3" }),
    { id: "lift", type: "lifting", date: "2026-10-20" },
    climb(9, { grade: "V6", route_name: "Slab Master", crag: "The Barn" }),
    climb(5, { grade: "V4" }),
  ];
  render(<ClimbView activities={activities} />);
  expect(screen.getByText("3 total")).toBeInTheDocument();
  expect(screen.getByText("Slab Master")).toBeInTheDocument();
  const grades = screen.getAllByText(/^V[346]$/).map(el => el.textContent);
  expect(grades).toEqual(["V6 Boulder", "V4 Boulder", "V3 Boulder"]);
  expect(screen.queryByRole("button", { name: /View all/ })).not.toBeInTheDocument();
});

test("more than eight climbs shows eight and links to History", () => {
  const onNavigateToHistory = jest.fn();
  const activities = Array.from({ length: 11 }, (_, i) => climb(i + 1, { route_name: `Route ${i + 1}` }));
  render(<ClimbView activities={activities} onNavigateToHistory={onNavigateToHistory} />);
  expect(screen.getByText("11 total")).toBeInTheDocument();
  expect(screen.getAllByText(/^Route \d+$/)).toHaveLength(8);
  expect(screen.getByText("Route 11")).toBeInTheDocument();
  expect(screen.queryByText("Route 3")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "View all 11 climbs in History →" }));
  expect(onNavigateToHistory).toHaveBeenCalledTimes(1);
});

test("Plan warm-up opens the warm-up with weight, unit and save handler, and Back returns", () => {
  render(<ClimbView activities={[]} bodyWeight={70} unit="kg" onBwSave={jest.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Plan warm-up" }));
  expect(screen.getByText("warm-up screen · 70 · kg · can save weight")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Climbing" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByRole("heading", { name: "Climbing" })).toBeInTheDocument();
});

// Tabs load their code on first open. A failed load or a render error must
// stay inside the tab area and clear when the user switches tabs, without
// re-mounting what is above it.
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { ViewBoundary } from "../ErrorBoundary.jsx";

let broken = false;
function Tab({ name }) {
  if (broken) throw new Error("chunk failed to load");
  return <p>{name} tab</p>;
}

beforeEach(() => { broken = false; jest.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => console.error.mockRestore());

test("a tab that fails shows a retry and recovers", () => {
  broken = true;
  render(<ViewBoundary resetKey={3}><Tab name="Analysis" /></ViewBoundary>);
  expect(screen.getByRole("alert")).toHaveTextContent("This tab could not open");
  broken = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(screen.getByText("Analysis tab")).toBeInTheDocument();
});

test("switching tabs clears the error", () => {
  broken = true;
  const { rerender } = render(<ViewBoundary resetKey={3}><Tab name="Analysis" /></ViewBoundary>);
  expect(screen.getByRole("alert")).toBeInTheDocument();
  broken = false;
  rerender(<ViewBoundary resetKey={4}><Tab name="History" /></ViewBoundary>);
  expect(screen.getByText("History tab")).toBeInTheDocument();
});

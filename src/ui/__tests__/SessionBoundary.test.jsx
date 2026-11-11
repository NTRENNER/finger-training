// Regression: a throw in one session screen reached the app-root boundary,
// whose recovery re-mounts the app and so ended the running session.
import React, { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { SessionBoundary } from "../ErrorBoundary.jsx";

let shouldThrow = false;
function Screen({ rep }) {
  if (shouldThrow) throw new Error("bad chart point");
  return <p>Rep {rep} screen</p>;
}
// Stands in for App: the session position lives above the boundary.
function Runner() {
  const [rep, setRep] = useState(3);
  return <>
    <button onClick={() => setRep(r => r + 1)}>next</button>
    <SessionBoundary><Screen rep={rep} /></SessionBoundary>
  </>;
}

beforeEach(() => { shouldThrow = false; jest.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => console.error.mockRestore());

test("a session screen error keeps the session position and recovers on Try again", () => {
  render(<Runner />);
  expect(screen.getByText("Rep 3 screen")).toBeInTheDocument();

  shouldThrow = true;
  fireEvent.click(screen.getByText("next"));
  expect(screen.getByRole("alert")).toHaveTextContent("Your session is still running");

  shouldThrow = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(screen.getByText("Rep 4 screen")).toBeInTheDocument();
});

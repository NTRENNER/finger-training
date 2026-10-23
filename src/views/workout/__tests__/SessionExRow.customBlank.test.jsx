import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { SessionExRow } from "../SessionExRow.jsx";
import { createCustomExercise } from "../../../model/workoutProgram.js";

function StatefulRow({ ex, initialSet }) {
  const [setsData, setSetsData] = React.useState({ sets: [initialSet] });
  return <SessionExRow ex={ex} unit="lbs" setsData={setsData} onSetsChange={setSetsData} last />;
}

test("a blank rep-tracked custom exercise still records reps in its first session", () => {
  const ex = createCustomExercise({ name: "Ring Rows", tracking: "reps" });
  render(<SessionExRow ex={ex} unit="lbs" setsData={{ sets: [{ reps: "", done: false }] }}
    onSetsChange={() => {}} last />);
  expect(screen.getByText("Ring Rows")).toBeInTheDocument();
  expect(screen.getByText("reps")).toBeInTheDocument();
  expect(screen.getByRole("textbox")).toHaveValue("");
});

test("a completion-only custom exercise shows done circles without a reps box", () => {
  const ex = createCustomExercise({ name: "Dead Hang", tracking: "completion" });
  render(<StatefulRow ex={ex} initialSet={{ done: false }} />);
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  fireEvent.click(screen.getByTitle("Set 1: tap to toggle done"));
  expect(screen.getByTitle("Set 1: tap to toggle done")).toHaveTextContent("✓");
});

test("a rep-tracked set cannot be completed until reps are entered", () => {
  const ex = createCustomExercise({ name: "Ring Rows", tracking: "reps" });
  render(<StatefulRow ex={ex} initialSet={{ reps: "", done: false }} />);
  const done = screen.getByTitle("Set 1: tap to toggle done");
  const reps = screen.getByRole("textbox");

  fireEvent.click(done);
  expect(screen.getByRole("alert")).toHaveTextContent("Enter reps");
  expect(reps).toHaveFocus();
  expect(done).not.toHaveTextContent("✓");

  fireEvent.change(reps, { target: { value: "8" } });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  fireEvent.click(done);
  expect(done).toHaveTextContent("✓");
});

test("a weight-tracked set also requires reps before completion", () => {
  const ex = createCustomExercise({ name: "Weighted Row", tracking: "weight" });
  render(<StatefulRow ex={ex} initialSet={{ reps: "", weight: "20", done: false }} />);

  fireEvent.click(screen.getByTitle("Set 1: tap to toggle done"));
  expect(screen.getByRole("alert")).toHaveTextContent("Enter reps");
  expect(screen.getByRole("textbox")).toHaveFocus();
});

test("an attached modifier is selected per set and survives completion", () => {
  const ex = {
    ...createCustomExercise({ name: "Bench Press", tracking: "weight", reps: "5" }),
    setupModifiers: [{
      id: "modifier_slingshot",
      name: "Slingshot",
      kind: "assistance",
      options: [{ id: "red", label: "Red" }, { id: "blue", label: "Blue" }],
    }],
  };
  render(<StatefulRow ex={ex} initialSet={{ reps: "5", weight: "225", done: false }} />);

  const setup = screen.getByLabelText("Slingshot for set 1");
  fireEvent.change(setup, { target: { value: "red" } });
  expect(setup).toHaveValue("red");
  expect(screen.getByRole("spinbutton")).toHaveValue(null);
  fireEvent.click(screen.getByTitle("Set 1: tap to toggle done"));
  expect(screen.getByTitle("Set 1: tap to toggle done")).toHaveTextContent("✓");
  expect(setup).toHaveValue("red");
});

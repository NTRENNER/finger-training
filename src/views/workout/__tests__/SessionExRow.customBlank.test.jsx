import React from "react";
import { render, screen } from "@testing-library/react";
import { SessionExRow } from "../SessionExRow.jsx";
import { createCustomExercise } from "../../../model/workoutProgram.js";

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
  render(<SessionExRow ex={ex} unit="lbs" setsData={{ sets: [{ done: false }] }}
    onSetsChange={() => {}} last />);
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});

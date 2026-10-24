import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { SessionExRow } from "../SessionExRow.jsx";
import { exercises } from "../../../model/supportTraining.js";
import { createCustomExercise } from "../../../model/workoutProgram.js";

function StatefulRow({ ex, initialSets }) {
  const [setsData, setSetsData] = React.useState({ sets: initialSets });
  return (
    <>
      <SessionExRow ex={ex} unit="lbs" setsData={setsData} onSetsChange={setSetsData} last />
      <output data-testid="sets-state">{JSON.stringify(setsData)}</output>
    </>
  );
}
const state = () => JSON.parse(screen.getByTestId("sets-state").textContent).sets;

test("a front lever set takes reps and seconds, and can't be ticked without a time", () => {
  render(<StatefulRow ex={exercises.frontLever}
    initialSets={[{ reps: "3", seconds: "", variant: "Full", weight: "", done: false }]} />);
  const seconds = screen.getByRole("textbox", { name: "Seconds for set 1" });
  const done = screen.getByTitle("Set 1: tap to toggle done");
  // Like reps, a blank box shows the prescribed range until edited.
  expect(seconds).toHaveValue("5–10");

  fireEvent.change(seconds, { target: { value: "0" } });
  fireEvent.click(done);
  expect(screen.getByRole("alert")).toHaveTextContent("Enter reps and seconds");
  expect(state()[0].done).toBe(false);

  fireEvent.change(seconds, { target: { value: "10" } });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  fireEvent.click(done);
  expect(state()[0]).toMatchObject({ reps: "3", seconds: "10", variant: "Full", done: true });
});

test("an added set copies the previous set's hold time", () => {
  render(<StatefulRow ex={exercises.frontLever}
    initialSets={[{ reps: "3", seconds: "10", variant: "Full", weight: "", done: true }]} />);
  fireEvent.click(screen.getByRole("button", { name: "+ Set" }));
  expect(state()[1]).toMatchObject({ seconds: "10", variant: "Full", done: false });
});

test("a one-sided hold has seconds for each side", () => {
  render(<StatefulRow ex={exercises.heelHookPull}
    initialSets={[{ leftReps: "1", leftSeconds: "8", leftWeight: "", rightReps: "1", rightSeconds: "0", rightWeight: "", done: false }]} />);
  fireEvent.click(screen.getByTitle("Set 1: tap to toggle done"));
  expect(screen.getByRole("textbox", { name: "Seconds for set 1 right" })).toHaveFocus();
  fireEvent.change(screen.getByRole("textbox", { name: "Seconds for set 1 right" }), { target: { value: "9" } });
  fireEvent.click(screen.getByTitle("Set 1: tap to toggle done"));
  expect(state()[0]).toMatchObject({ leftSeconds: "8", rightSeconds: "9", done: true });
});

test("a custom Reps × seconds exercise shows the seconds box beside its reps", () => {
  const ex = createCustomExercise({ name: "Plank", tracking: "time" });
  render(<StatefulRow ex={ex} initialSets={[{ reps: "", seconds: "", done: false }]} />);
  fireEvent.change(screen.getByRole("textbox", { name: "" }), { target: { value: "2" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Seconds for set 1" }), { target: { value: "30" } });
  fireEvent.click(screen.getByTitle("Set 1: tap to toggle done"));
  expect(state()[0]).toMatchObject({ reps: "2", seconds: "30", done: true });
});

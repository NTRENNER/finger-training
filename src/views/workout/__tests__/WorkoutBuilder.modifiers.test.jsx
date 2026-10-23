import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import {
  defaultWorkoutProgram,
  workoutProgramCatalog,
  workoutProgramWorkouts,
} from "../../../model/workoutProgram.js";
import { WorkoutBuilder } from "../WorkoutBuilder.jsx";

function Harness() {
  const [program, setProgram] = React.useState(defaultWorkoutProgram());
  return (
    <>
      <WorkoutBuilder
        program={program}
        workouts={workoutProgramWorkouts(program)}
        catalog={workoutProgramCatalog(program)}
        onChange={setProgram}
        onClose={() => {}}
      />
      <output data-testid="program-state">{JSON.stringify(program)}</output>
    </>
  );
}

function setupButtonFor(exerciseName) {
  return within(screen.getByText(exerciseName).closest(".builder-exercise-row"))
    .getByRole("button", { name: "Setup" });
}

test("a modifier is created once and can be attached to other exercises", () => {
  render(<Harness />);

  fireEvent.click(screen.getByRole("tab", { name: "Strength B" }));
  fireEvent.click(setupButtonFor("Bench Press"));
  fireEvent.change(screen.getByPlaceholderText("Slingshot"), { target: { value: "Slingshot" } });
  fireEvent.change(screen.getByPlaceholderText("Red, Blue, Maddog"), { target: { value: "Red, Blue" } });
  fireEvent.click(screen.getByRole("button", { name: "Add and attach" }));
  expect(screen.getByRole("checkbox", { name: /Slingshot/ })).toBeChecked();

  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  fireEvent.click(screen.getByRole("tab", { name: "Strength A" }));
  fireEvent.click(setupButtonFor("Dips"));
  const reusable = screen.getByRole("checkbox", { name: /Slingshot/ });
  expect(reusable).not.toBeChecked();
  fireEvent.click(reusable);

  const program = JSON.parse(screen.getByTestId("program-state").textContent);
  const modifierId = program.modifierDefinitions[0].id;
  expect(program.exerciseModifierIds.benchPress).toEqual([modifierId]);
  expect(program.exerciseModifierIds.dips).toEqual([modifierId]);
});

import { buildExerciseDefIndex } from "../exerciseIds.js";
import { exercises } from "../supportTraining.js";

test("catalog-only substitutions retain their full definition outside default workouts", () => {
  const plan = {
    C: { exercises: [exercises.trxRow] },
  };

  const index = buildExerciseDefIndex(plan, exercises);

  expect(index.lockoffEccentric).toEqual(
    expect.objectContaining({
      name: "90° Lock-Off + Eccentric",
      circlesOnly: true,
      substitutesFor: ["trxRow"],
    })
  );
});

import { buildForceDurationGripScope } from "../analysisScope.js";

const rep = (grip, hand = "L") => ({
  grip,
  hand,
  avg_force_kg: 20,
  actual_time_s: 30,
});

test("all-grips force-duration view never pools sparse grips", () => {
  expect(buildForceDurationGripScope([
    rep("Crusher"),
    rep("Micro"),
  ])).toEqual({
    Crusher: true,
    Micro: true,
  });
});

test("focused grip and selected hand scope before split-mode detection", () => {
  const history = [
    rep("Crusher", "L"),
    rep("Micro", "R"),
  ];

  expect(buildForceDurationGripScope(history, { grip: "Crusher" })).toBeNull();
  expect(buildForceDurationGripScope(history, { hand: "L" })).toBeNull();
});

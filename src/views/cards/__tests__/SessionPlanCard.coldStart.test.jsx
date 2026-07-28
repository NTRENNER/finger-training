import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { SessionPlanCard } from "../SessionPlanCard.js";
import { buildThreeExpPriors } from "../../../model/threeExp.js";

const GOAL_CONFIG = {
  max_strength:       { label: "Max Strength",       emoji: "M", color: "#c83838", refTime: 5 },
  power:              { label: "Power",              emoji: "P", color: "#e05560", refTime: 30 },
  power_strength:     { label: "Power/Strength",     emoji: "PS", color: "#e68a48", refTime: 70 },
  strength:           { label: "Strength",           emoji: "S", color: "#e07a30", refTime: 115 },
  strength_endurance: { label: "Strength/Endurance", emoji: "SE", color: "#7aa0d8", refTime: 160 },
  endurance:          { label: "Endurance",          emoji: "E", color: "#3b82f6", refTime: 220 },
};

const rep = (hand, T, actual, load, index) => ({
  id: `${hand}-${T}-${index}`,
  session_id: `${hand}-session-${index}`,
  date: `2026-07-${String(20 + index).padStart(2, "0")}`,
  grip: "Prime",
  hand,
  set_num: index,
  rep_num: 1,
  target_duration: T,
  actual_time_s: actual,
  avg_force_kg: load,
});

function renderCard(history) {
  const onApplyPlan = jest.fn();
  render(
    <SessionPlanCard
      history={history}
      grip="Prime"
      hand="Both"
      freshMap={null}
      threeExpPriors={buildThreeExpPriors(history)}
      activities={[]}
      GOAL_CONFIG={GOAL_CONFIG}
      unit="kg"
      onApplyPlan={onApplyPlan}
      cooked={0}
      onCookedChange={jest.fn()}
      fatigueModel={null}
    />
  );
  return onApplyPlan;
}

test("upper-bound stage hides unsupported alternatives and sends the exact probe plan", async () => {
  const history = ["L", "R"].flatMap(hand => [
    rep(hand, 30, 31, hand === "L" ? 6.0 : 6.2, 1),
    rep(hand, 30, 33, hand === "L" ? 5.8 : 6.0, 2),
    rep(hand, 30, 35, hand === "L" ? 5.6 : 5.8, 3),
  ]);
  const onApplyPlan = renderCard(history);

  expect(screen.getAllByText("after upper anchor")).toHaveLength(5);
  expect(screen.getAllByRole("button").filter(button => button.disabled)).toHaveLength(5);
  expect(document.body).toHaveTextContent("Hangs4");
  expect(document.body).toHaveTextContent("Rest20s");

  await waitFor(() => expect(onApplyPlan).toHaveBeenCalled());
  expect(onApplyPlan.mock.calls.at(-1)[0]).toMatchObject({
    goal: "max_strength",
    targetTime: 3,
    repsPerSet: 4,
    restTime: 20,
  });
  expect(onApplyPlan.mock.calls.at(-1)[0].plannedLoadByHand.L).toBeGreaterThan(0);
});

test("lower-bound stage uses the four-rep recovery protocol and defers the middle", async () => {
  const history = [
    rep("L", 5, 5, 6, 1),
    rep("R", 5, 5, 8, 1),
  ];
  const onApplyPlan = renderCard(history);

  expect(screen.getAllByText("after lower anchor")).toHaveLength(5);
  expect(document.body).toHaveTextContent("Hangs4");
  expect(document.body).toHaveTextContent("Rest20s");

  await waitFor(() => expect(onApplyPlan).toHaveBeenCalled());
  const plan = onApplyPlan.mock.calls.at(-1)[0];
  expect(plan).toMatchObject({
    goal: "endurance",
    targetTime: 220,
    repsPerSet: 4,
    restTime: 20,
  });
  expect(plan.plannedLoadByHand.L).toBeCloseTo(1.2, 1);
  expect(plan.plannedLoadByHand.R).toBeCloseTo(1.6, 1);
});

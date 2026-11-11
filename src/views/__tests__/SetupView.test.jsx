// The Fingers setup screen: pick a grip, see today's plan, start.
import React, { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { SetupView } from "../SetupView.jsx";

const GOAL_CONFIG = {
  max_strength:       { label: "Max Strength",       emoji: "M", color: "#c83838", refTime: 5 },
  power:              { label: "Power",              emoji: "P", color: "#e05560", refTime: 30 },
  power_strength:     { label: "Power/Strength",     emoji: "PS", color: "#e68a48", refTime: 70 },
  strength:           { label: "Strength",           emoji: "S", color: "#e07a30", refTime: 115 },
  strength_endurance: { label: "Strength/Endurance", emoji: "SE", color: "#7aa0d8", refTime: 160 },
  endurance:          { label: "Endurance",          emoji: "E", color: "#3b82f6", refTime: 220 },
};
const GRIPS = ["Crusher", "Micro", "Prime"];
// Stable references, as App passes them. A fresh array each render makes the
// plan card re-apply its plan to the config without end.
const ACTIVITIES = [];
const baseConfig = { hand: "Both", grip: "", goal: "", repsPerSet: 5, targetTime: 45, restTime: 20,
  cooked: null, adjustLoadForFatigue: false, plannedSets: 1 };

const rep = (hand, T, actual, load, index) => ({
  id: `${hand}-${T}-${index}`, session_id: `${hand}-session-${index}`,
  date: `2026-07-${String(10 + index).padStart(2, "0")}`, grip: "Prime", hand,
  set_num: 1, rep_num: 1, target_duration: T, actual_time_s: actual, avg_force_kg: load,
});
const history = ["L", "R"].flatMap(hand => [
  rep(hand, 10, 11, 30, 1), rep(hand, 45, 44, 22, 2), rep(hand, 120, 118, 17, 3), rep(hand, 220, 210, 14, 4),
]);

// Stands in for App, which owns the session config.
function Screen({ initial = baseConfig, onStart = jest.fn(), onConfig = () => {}, ...props }) {
  const [config, setConfig] = useState(initial);
  onConfig(config);
  return <SetupView config={config} setConfig={setConfig} onStart={onStart} history={history}
    GOAL_CONFIG={GOAL_CONFIG} GRIP_PRESETS={GRIPS} activities={ACTIVITIES} unit="kg"
    connectSlot={<div>connect slot</div>} {...props} />;
}

beforeAll(() => {
  // jsdom has the dialog element, but not its browser focus/top-layer API.
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
beforeEach(() => localStorage.clear());

test("with no grip chosen it offers the three grips and Start is disabled", () => {
  const onStart = jest.fn();
  render(<Screen onStart={onStart} />);
  expect(screen.getByRole("heading", { name: "Select a Grip to Begin" })).toBeInTheDocument();
  const picker = screen.getByRole("group", { name: "Training device" });
  expect(within(picker).getAllByRole("button").map(b => b.getAttribute("aria-label").split(",")[0])).toEqual(GRIPS);
  expect(screen.getByText(/Select a grip above/)).toBeInTheDocument();
  expect(screen.getByText("connect slot")).toBeInTheDocument();
  const start = screen.getByRole("button", { name: /Start Session/ });
  expect(start).toBeDisabled();
  fireEvent.click(start);
  expect(onStart).not.toHaveBeenCalled();
});

test("choosing a grip sets it on the session config, shows the plan and enables Start", () => {
  const onStart = jest.fn();
  let latest;
  render(<Screen onStart={onStart} onConfig={c => { latest = c; }} />);
  fireEvent.click(screen.getByRole("button", { name: /^Prime,/ }));
  expect(latest.grip).toBe("Prime");
  expect(screen.getByRole("button", { name: /^Prime,/ })).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByText(/Select a grip above/)).not.toBeInTheDocument();
  // The plan card applies its recommendation to the config the runner starts from.
  expect(latest.targetTime).toBeGreaterThan(0);
  expect(latest.repsPerSet).toBeGreaterThan(0);

  const start = screen.getByRole("button", { name: /Start Session/ });
  expect(start).toBeEnabled();
  fireEvent.click(start);
  expect(onStart).toHaveBeenCalledTimes(1);
});

test("Start sits above the list of alternative sessions", () => {
  render(<Screen initial={{ ...baseConfig, grip: "Prime" }} />);
  const start = screen.getByRole("button", { name: /Start Session/ });
  const alternatives = screen.getByText("Choose a different session");
  expect(start.compareDocumentPosition(alternatives) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("the body-weight reminder appears when no weight is recorded and saves through onBwSave", async () => {
  const onBwSave = jest.fn(async () => true);
  render(<Screen onBwSave={onBwSave} />);
  const dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByRole("spinbutton"), { target: { value: "70" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await screen.findByRole("heading", { name: "Select a Grip to Begin" });
  expect(onBwSave).toHaveBeenCalledTimes(1);
  expect(onBwSave.mock.calls[0][0]).toBeCloseTo(70, 5);
});

// Regression: the default for a missing `activities` prop was a new empty
// array on every render. The plan card saw a change each time and re-applied
// its plan to the config without end.
test("it settles when optional list props are left out", () => {
  const Bare = () => {
    const [config, setConfig] = useState({ ...baseConfig, grip: "Prime" });
    return <SetupView config={config} setConfig={setConfig} onStart={jest.fn()} history={history}
      GOAL_CONFIG={GOAL_CONFIG} GRIP_PRESETS={GRIPS} unit="kg" />;
  };
  render(<Bare />);
  expect(screen.getByRole("button", { name: /Start Session/ })).toBeEnabled();
});

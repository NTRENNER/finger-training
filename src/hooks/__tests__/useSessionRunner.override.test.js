// Regression: the live weight-override box (non-Tindeq) must persist to the
// saved rep. It fed only the live color/auto-fail threshold and never reached
// handleRepDone, so manual users' reps saved load=0 (the elcerritotom bug).
import { renderHook, act } from "@testing-library/react";
import { useSessionRunner } from "../useSessionRunner.js";
import { effectiveLoad } from "../../model/load.js";

function setup() {
  const addReps = jest.fn();
  const hook = renderHook(() => useSessionRunner({
    history: [], freshMap: null, threeExpPriors: null,
    addReps, fatigueModel: null, tindeqConnected: false,
    onSessionStart: () => {},
  }));
  return { hook, addReps };
}
const cfg = { grip: "Micro", targetTime: 45, repsPerSet: 5, restTime: 20, hand: "L" };

test("override weight persists to manual_load_kg and drives effectiveLoad", () => {
  const { hook, addReps } = setup();
  act(() => hook.result.current.startSession(cfg));
  act(() => hook.result.current.handleRepDone({
    actualTime: 50, avgForce: null, peakForce: null, failed: false, manualLoadKg: 11.34,
  }));
  const rep = addReps.mock.calls[0][0][0];
  expect(rep.avg_force_kg).toBeNull();
  expect(rep.manual_load_kg).toBeCloseTo(11.3, 1);
  expect(effectiveLoad(rep)).toBeCloseTo(11.3, 1);   // was 0 before the fix
});

test("no override → manual_load_kg stays null (Tindeq/legacy path unchanged)", () => {
  const { hook, addReps } = setup();
  act(() => hook.result.current.startSession(cfg));
  act(() => hook.result.current.handleRepDone({
    actualTime: 50, avgForce: null, peakForce: null, failed: false,
  }));
  const rep = addReps.mock.calls[0][0][0];
  expect(rep.manual_load_kg).toBeNull();
});

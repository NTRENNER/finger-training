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

test("manual_load_kg keeps ~0.001kg precision so lb entries stay faithful", () => {
  // 20.0 lb = 9.0718 kg. The old 0.1 kg rounding snapped this to 9.1 kg,
  // which displays as 20.1 lb — a user with lb plates couldn't record a
  // round 20.0 (Tom's bug). Fine precision preserves the exact value.
  const { hook, addReps } = setup();
  act(() => hook.result.current.startSession(cfg));
  act(() => hook.result.current.handleRepDone({
    actualTime: 50, avgForce: null, peakForce: null, failed: false, manualLoadKg: 20 / 2.20462,
  }));
  const rep = addReps.mock.calls[0][0][0];
  // Round-trips back to 20.0 lb (not 20.1) when displayed.
  expect(rep.manual_load_kg * 2.20462).toBeCloseTo(20.0, 1);
  expect(rep.manual_load_kg).not.toBeCloseTo(9.1, 2); // would be 9.1 under old 0.1kg rounding
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

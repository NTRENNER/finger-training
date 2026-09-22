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
    addReps, tindeqConnected: false,
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

test("a boundary probe starts with its exact planned load", () => {
  const { hook } = setup();
  act(() => hook.result.current.startSession({
    ...cfg,
    plannedLoadByHand: { L: 1.4 },
    cooked: 0,
  }));
  expect(hook.result.current.refWeights.L).toBeCloseTo(1.4, 5);
});

test("interrupted measurement and validity survive recording without the failure timing offset", () => {
  const { hook, addReps } = setup();
  act(() => hook.result.current.startSession(cfg));
  act(() => hook.result.current.chooseOffset(true));
  const forceRecording = { version: 1, method: 'time_weighted', duration_s: 12, observed_time_s: 12 };
  act(() => hook.result.current.handleRepDone({ actualTime: 12, avgForce: 17.5,
    failureValid: false, endReason: 'interrupted', forceRecording }));
  const rep = addReps.mock.calls[0][0][0];
  expect(rep).toMatchObject({ actual_time_s: 12, avg_force_kg: 17.5,
    failure_valid: false, end_reason: 'interrupted', force_recording: forceRecording });
  expect(hook.result.current.lastRepResult.failureValid).toBe(false);
  expect(hook.result.current.phase).toBe('resting');
});


test.each([[null,1],[0,1],[10,0.75]])("freezes the applied adjustment for rating %s", (cooked,multiplier) => {
  const {hook,addReps}=setup();
  act(()=>hook.result.current.startSession({...cfg,cooked,adjustLoadForFatigue:true,plannedLoadByHand:{L:20}}));
  expect(hook.result.current.refWeights.L).toBe(20*multiplier);
  act(()=>hook.result.current.setConfig(c=>({...c,cooked:5})));
  act(()=>hook.result.current.handleRepDone({actualTime:30,avgForce:20*multiplier}));
  expect(addReps.mock.calls[0][0][0]).toMatchObject({session_cooked:cooked,
    session_adjustment:{version:1,reported_cooked:cooked,applied_multiplier:multiplier}});
});


test.each([false, true])("fatigue choice %s is frozen with the actual session load", adjust => {
  const {hook,addReps}=setup();
  act(()=>hook.result.current.startSession({...cfg,cooked:8,adjustLoadForFatigue:adjust,plannedLoadByHand:{L:20}}));
  expect(hook.result.current.refWeights.L).toBe(adjust ? 16 : 20);
  act(()=>hook.result.current.setConfig(c=>({...c,cooked:1,adjustLoadForFatigue:!adjust})));
  act(()=>hook.result.current.handleRepDone({actualTime:45,avgForce:20}));
  expect(addReps.mock.calls[0][0][0]).toMatchObject({session_cooked:8,
    prescribed_load_kg:adjust ? 16 : 20,
    session_adjustment:{version:1,reported_cooked:8,load_choice:adjust ? "adjust" : "keep",applied_multiplier:adjust ? 0.8 : 1}});
});

import { recordForce } from '../../model/forceRecording.js';
import { sustainedMaxKg } from '../../model/sustainedMax.js';
// Regression: the live weight-override box (non-Tindeq) must persist to the
// saved rep. It fed only the live color/auto-fail threshold and never reached
// handleRepDone, so manual users' reps saved load=0 (the elcerritotom bug).
import { renderHook, act } from "@testing-library/react";
import { useSessionRunner } from "../useSessionRunner.js";
import { effectiveLoad } from "../../model/load.js";

function setup() {
  const addReps = jest.fn();
  const view = renderHook(() => useSessionRunner({
    history: [], freshMap: null, threeExpPriors: null,
    addReps, tindeqConnected: false,
    onSessionStart: () => {},
  }));
  return { view, addReps };
}
const cfg = { grip: "Micro", targetTime: 45, repsPerSet: 5, restTime: 20, hand: "L" };

test("override weight persists to manual_load_kg and drives effectiveLoad", () => {
  const { view, addReps } = setup();
  act(() => view.result.current.startSession(cfg));
  act(() => view.result.current.handleRepDone({
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
  const { view, addReps } = setup();
  act(() => view.result.current.startSession(cfg));
  act(() => view.result.current.handleRepDone({
    actualTime: 50, avgForce: null, peakForce: null, failed: false, manualLoadKg: 20 / 2.20462,
  }));
  const rep = addReps.mock.calls[0][0][0];
  // Round-trips back to 20.0 lb (not 20.1) when displayed.
  expect(rep.manual_load_kg * 2.20462).toBeCloseTo(20.0, 1);
  expect(rep.manual_load_kg).not.toBeCloseTo(9.1, 2); // would be 9.1 under old 0.1kg rounding
});

test("no override → manual_load_kg stays null (Tindeq/legacy path unchanged)", () => {
  const { view, addReps } = setup();
  act(() => view.result.current.startSession(cfg));
  act(() => view.result.current.handleRepDone({
    actualTime: 50, avgForce: null, peakForce: null, failed: false,
  }));
  const rep = addReps.mock.calls[0][0][0];
  expect(rep.manual_load_kg).toBeNull();
});

test("a boundary probe starts with its exact planned load", () => {
  const { view } = setup();
  act(() => view.result.current.startSession({
    ...cfg,
    plannedLoadByHand: { L: 1.4 },
    cooked: 0,
  }));
  expect(view.result.current.refWeights.L).toBeCloseTo(1.4, 5);
});

test("interrupted measurement and validity survive recording without the failure timing offset", () => {
  const { view, addReps } = setup();
  act(() => view.result.current.startSession(cfg));
  act(() => view.result.current.chooseOffset(true));
  const forceRecording = { version: 1, method: 'time_weighted', duration_s: 12, observed_time_s: 12 };
  act(() => view.result.current.handleRepDone({ actualTime: 12, avgForce: 17.5,
    failureValid: false, endReason: 'interrupted', forceRecording }));
  const rep = addReps.mock.calls[0][0][0];
  expect(rep).toMatchObject({ actual_time_s: 12, avg_force_kg: 17.5,
    failure_valid: false, end_reason: 'interrupted', force_recording: forceRecording });
  expect(view.result.current.lastRepResult.failureValid).toBe(false);
  expect(view.result.current.phase).toBe('resting');
});


test.each([[null,1],[0,1],[10,0.75]])("freezes the applied adjustment for rating %s", (cooked,multiplier) => {
  const {view,addReps}=setup();
  act(()=>view.result.current.startSession({...cfg,cooked,adjustLoadForFatigue:true,plannedLoadByHand:{L:20}}));
  expect(view.result.current.refWeights.L).toBe(20*multiplier);
  act(()=>view.result.current.setConfig(c=>({...c,cooked:5})));
  act(()=>view.result.current.handleRepDone({actualTime:30,avgForce:20*multiplier}));
  expect(addReps.mock.calls[0][0][0]).toMatchObject({session_cooked:cooked,
    session_adjustment:{version:1,reported_cooked:cooked,applied_multiplier:multiplier}});
});


test.each([false, true])("fatigue choice %s is frozen with the actual session load", adjust => {
  const {view,addReps}=setup();
  act(()=>view.result.current.startSession({...cfg,cooked:8,adjustLoadForFatigue:adjust,plannedLoadByHand:{L:20}}));
  expect(view.result.current.refWeights.L).toBe(adjust ? 16 : 20);
  act(()=>view.result.current.setConfig(c=>({...c,cooked:1,adjustLoadForFatigue:!adjust})));
  act(()=>view.result.current.handleRepDone({actualTime:45,avgForce:20}));
  expect(addReps.mock.calls[0][0][0]).toMatchObject({session_cooked:8,
    prescribed_load_kg:adjust ? 16 : 20,
    session_adjustment:{version:1,reported_cooked:8,load_choice:adjust ? "adjust" : "keep",applied_multiplier:adjust ? 0.8 : 1}});
});

test("a completed recommendation can add optional sets up to five", () => {
  const { view, addReps } = setup();
  act(() => view.result.current.startSession({ ...cfg, repsPerSet: 1 }));
  for (let setNum = 1; setNum <= 5; setNum++) {
    act(() => view.result.current.handleRepDone({ actualTime: 45, avgForce: 20, peakForce: 22 }));
    expect(addReps.mock.calls[setNum - 1][0][0].set_num).toBe(setNum);
    expect(view.result.current.phase).toBe("done");
    if (setNum < 5) act(() => view.result.current.handleNextSet());
  }
  act(() => view.result.current.handleNextSet());
  expect(view.result.current.currentSet).toBe(5);
  expect(view.result.current.phase).toBe("done");
});


test("sensor two-second summary survives rep saving independently of the instantaneous peak", () => {
  const { view, addReps } = setup();
  act(() => view.result.current.startSession(cfg));
  const stats = recordForce(Array.from({ length: 301 }, (_, i) => ({ ts: i * 10, kg: i === 100 ? 80 : 20 })));
  act(() => view.result.current.handleRepDone(stats));
  const saved = JSON.parse(JSON.stringify(addReps.mock.calls[0][0][0]));
  expect(saved.peak_force_kg).toBe(80);
  expect(sustainedMaxKg(saved)).toBeCloseTo(20.3);
});

test('ordinary planned dose is immutable across actual overpulls, session edits and optional sets', () => {
  const { view, addReps } = setup();
  act(() => view.result.current.startSession({ ...cfg, repsPerSet: 4,
    targetTime: 160, restTime: 20, plannedLoadByHand: { L: 20 },
    cooked: 8, adjustLoadForFatigue: true }));
  const snapshot = { version: 1, reps_per_set: 4, target_duration_s: 160,
    rest_s: 20, load_kg: 16, base_load_kg: 20, hand_mode: 'L' };
  // Retrospective/config changes and pulling heavier cannot rewrite the intended dose.
  act(() => view.result.current.setConfig(c => ({ ...c, cooked: 0, restTime: 30, targetTime: 220 })));
  for (let rep = 0; rep < 4; rep++) {
    act(() => view.result.current.handleRepDone({ actualTime: 120, avgForce: 25, peakForce: 28 }));
    if (rep < 3) act(() => view.result.current.handleRestDone());
  }
  expect(view.result.current.phase).toBe('done');
  act(() => view.result.current.handleNextSet());
  act(() => view.result.current.handleRepDone({ actualTime: 30, avgForce: 15, failureValid: false, endReason: 'interrupted' }));
  const rows = addReps.mock.calls.flatMap(call => call[0]);
  expect(rows).toHaveLength(5);
  expect(rows[4].set_num).toBe(2);
  for (const rep of rows) expect(rep.force_recording.session_prescription).toEqual(snapshot);
  rows[0].force_recording.session_prescription.reps_per_set = 99;
  expect(rows[1].force_recording.session_prescription).toEqual(snapshot);
});

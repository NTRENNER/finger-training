import { act, renderHook } from '@testing-library/react';
import { useSessionRunner } from '../useSessionRunner.js';
import { freshFitReps } from '../../model/load.js';
import { makeMixedDomainPlan, MIXED_DOMAIN_ZONES } from '../../model/mixedDomain.js';
jest.mock('../../lib/sync.js', () => ({ pushDailyState: jest.fn() }));

const plan = () => ({ id: 'volume_beta', version: 1, experiment_id: 'pilot-1',
  started_on: '2026-10-01', ends_on: '2026-11-11', sets: 2, rest_s: 300, goal_sessions_per_grip: 18 });
const config = () => ({ grip: 'Micro', hand: 'Both', targetTime: 30, repsPerSet: 4, restTime: 20,
  plannedLoadByHand: { L: 20, R: 22 }, volumePlan: plan() });
beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-10-01T12:00:00Z')));
afterEach(() => jest.useRealTimers());
const wait = ms => act(() => jest.advanceTimersByTime(ms));
function setup({ connected = true, cfg = config(), history = [] } = {}) {
  const addReps = jest.fn();
  const hook = renderHook(() => useSessionRunner({ history, addReps, tindeqConnected: connected }));
  act(() => hook.result.current.startSession(cfg));
  if (!connected) act(() => hook.result.current.chooseOffset(false));
  return { ...hook, addReps, connected };
}
function pull(hook, extra = {}) {
  const start = Date.now(), kg = hook.result.current.refWeights[hook.result.current.activeHand];
  wait(10000);
  act(() => hook.result.current.handleRepDone({ actualTime: 10, startedAtMs: start, endedAtMs: Date.now(),
    ...(hook.connected ? { avgForce: kg, forceRecording: { version: 4, signal_quality: 'complete',
      recording_stop_reason: 'release', activity: { started_at_ms: start, ended_at_ms: Date.now() } } }
      : { manualLoadKg: kg }), ...extra }));
}
function handSet(hook, extra = {}) {
  for (let i = 0; i < 4; i++) {
    pull(hook, extra);
    if (i < 3) { wait(20000); act(() => hook.result.current.handleRestDone()); }
  }
}
function firstSet(hook) {
  handSet(hook);
  if (hook.result.current.config.hand === 'Both') {
    act(() => hook.result.current.handleSwitchHandsReady());
    handSet(hook);
  }
}

test.each([true, false])('five-minute same-hand clocks count other-hand work and require ready (device=%s)', connected => {
  const hook = setup({ connected });
  const first = hook.result.current.activeHand, second = first === 'L' ? 'R' : 'L';
  handSet(hook);
  const firstRelease = Date.now();
  act(() => hook.result.current.handleSwitchHandsReady());
  handSet(hook);
  const secondRelease = Date.now();
  expect(hook.result.current.phase).toBe('done');
  act(() => hook.result.current.handleNextSet());
  expect(hook.result.current).toMatchObject({ phase: 'between_sets', currentSet: 2,
    activeHand: first, setRestHand: first, setRestSeconds: 300, setRestStartedAtMs: firstRelease,
    setRestSource: connected ? 'device_release' : 'manual_tap' });
  // Other-hand work already supplied 100 seconds for the first hand.
  wait(200000);
  expect(hook.result.current.phase).toBe('between_sets');
  act(() => hook.result.current.handleSetRestDone());
  expect(hook.result.current.phase).toBe('rep_ready');
  handSet(hook);
  expect(hook.result.current.phase).toBe('switch_hands');
  act(() => hook.result.current.handleSwitchHandsReady());
  expect(hook.result.current).toMatchObject({ phase: 'between_sets', activeHand: second,
    setRestHand: second, setRestStartedAtMs: secondRelease });
  act(() => hook.result.current.handleSetRestDone());
  expect(hook.result.current.phase).toBe('rep_ready');
  handSet(hook);
  const rows = hook.result.current.sessionReps;
  expect(rows).toHaveLength(16);
  for (const hand of [first, second]) {
    const opener = rows.find(r => r.hand === hand && r.set_num === 2 && r.rep_num === 1);
    expect(opener).toMatchObject({ rest_s: 20, rep_timing: { rest_before_s: 300, rest_planned_s: 300 },
      force_recording: { volume_beta: { experiment_id: 'pilot-1', sets: 2,
        between_set_rest: { planned_s: 300, actual_s: 300 } } } });
    expect(rows.filter(r => r.hand === hand).every(r => r.prescribed_load_kg === (hand === 'L' ? 20 : 22))).toBe(true);
  }
  expect(rows.every(r => r.force_recording.volume_beta.experiment_id === 'pilot-1')).toBe(true);
  if (connected) expect(freshFitReps(rows)).toHaveLength(2);
  expect(freshFitReps(rows).every(r => r.set_num === 1)).toBe(true);
  act(() => hook.result.current.handleNextSet());
  expect(hook.result.current).toMatchObject({ phase: 'done', currentSet: 2 });
});

test('right-first day remains right-first for both sets; early start records actual rest without penalty', () => {
  const hook = setup({ history: [{ date: '2026-09-30', hand: 'L', actual_time_s: 30 }] });
  expect(hook.result.current.activeHand).toBe('R');
  firstSet(hook);
  act(() => hook.result.current.handleNextSet());
  expect(hook.result.current.setRestHand).toBe('R');
  wait(22000);
  act(() => hook.result.current.handleSetRestDone());
  pull(hook);
  const r = hook.result.current.sessionReps.at(-1);
  expect(r).toMatchObject({ hand: 'R', set_num: 2, failure_valid: true,
    rep_timing: { rest_before_s: 122 }, force_recording: { volume_beta: { between_set_rest: { actual_s: 122 } } } });
});

test('physical release, not capacity cutoff, anchors set rest', () => {
  const hook = setup({ cfg: { ...config(), hand: 'L', repsPerSet: 1 } });
  const start = Date.now(); wait(20000);
  act(() => hook.result.current.handleRepDone({ actualTime: 10, avgForce: 20,
    startedAtMs: start, endedAtMs: start + 10000, forceRecording: { version: 4,
      recording_stop_reason: 'release', credited_end_at_ms: start + 10000,
      activity: { started_at_ms: start, ended_at_ms: start + 18000 } } }));
  act(() => hook.result.current.handleNextSet());
  expect(hook.result.current.setRestStartedAtMs).toBe(start + 18000);
  wait(298000); act(() => hook.result.current.handleSetRestDone()); pull(hook);
  expect(hook.result.current.sessionReps.at(-1).rep_timing.rest_before_s).toBe(300);
});

test('unknown release uses labelled transition estimate and never invents measured rest', () => {
  const hook = setup({ cfg: { ...config(), hand: 'L', repsPerSet: 1 } });
  pull(hook, { forceRecording: { version: 4, recording_stop_reason: 'release_not_observed',
    activity: { ended_at_ms: null } } });
  const transition = Date.now();
  act(() => hook.result.current.handleNextSet());
  expect(hook.result.current).toMatchObject({ setRestStartedAtMs: transition, setRestSource: 'estimated_transition' });
  wait(300000); act(() => hook.result.current.handleSetRestDone()); pull(hook);
  expect(hook.result.current.sessionReps.at(-1)).toMatchObject({
    rep_timing: { rest_before_s: null, rest_source: 'estimated_transition' },
    force_recording: { volume_beta: { between_set_rest: { actual_s: null, estimated_s: 300 } } } });
});

test.each([{ failureValid: false }, { endReason: 'interrupted' },
  { forceRecording: { signal_quality: 'incomplete' } }])('invalid first-set attempts cannot continue: %j', extra => {
  const hook = setup({ cfg: { ...config(), hand: 'L' } });
  handSet(hook, extra);
  act(() => hook.result.current.handleNextSet());
  expect(hook.result.current).toMatchObject({ phase: 'done', currentSet: 1 });
});

test('incomplete first set can end, and cannot acquire an extra set', () => {
  const hook = setup(); pull(hook); act(() => hook.result.current.handleAbort());
  act(() => hook.result.current.handleNextSet());
  expect(hook.result.current).toMatchObject({ phase: 'done', currentSet: 1 });
});

test('two queued continue events still start only the second set', () => {
  const hook = setup({ cfg: { ...config(), hand: 'L' } });
  firstSet(hook);
  act(() => {
    hook.result.current.handleNextSet();
    hook.result.current.handleNextSet();
  });
  expect(hook.result.current).toMatchObject({ phase: 'between_sets', currentSet: 2, currentRep: 0 });
});

test('plan snapshot ignores later source mutation and expires for a future session', () => {
  const cfg = config(), hook = setup({ cfg });
  cfg.volumePlan.experiment_id = 'changed';
  pull(hook);
  expect(hook.result.current.sessionReps[0].force_recording.volume_beta.experiment_id).toBe('pilot-1');
  jest.setSystemTime(new Date('2026-11-12T12:00:00Z'));
  act(() => hook.result.current.startSession(cfg));
  expect(hook.result.current.config.volumePlan).toBeNull();
  pull(hook);
  expect(hook.result.current.sessionReps[0].force_recording.volume_beta).toBeUndefined();
});

test.each([{ rest_s: 200 }, { sets: 3 }, { started_on: '2026-02-30' }, { experiment_id: '' },
  { started_on: '2026-10-02' }])('invalid plan %j cannot activate volume mode', patch => {
  const hook = setup({ cfg: { ...config(), volumePlan: { ...plan(), ...patch } } });
  expect(hook.result.current.config.volumePlan).toBeNull();
});

test('Chaos and peak cannot be combined with Volume Beta', () => {
  const mixedDomainPlan = makeMixedDomainPlan(MIXED_DOMAIN_ZONES.map(key => ({ key, L: 20, R: 22 })), 'power', ['L', 'R']);
  for (const special of [{ mixedDomainPlan }, { peakTest: true }]) {
    const hook = setup({ cfg: { ...config(), ...special } });
    expect(hook.result.current.config.volumePlan).toBeNull();
    hook.unmount();
  }
});

// Protocol tests assume enrollment eligibility; access is covered separately.
import { act, renderHook } from '@testing-library/react';
import { useSessionRunner } from '../useSessionRunner.js';
import { freshFitReps } from '../../model/load.js';
import { makeMixedDomainPlan, MIXED_DOMAIN_ZONES } from '../../model/mixedDomain.js';
jest.mock('../../model/betaEligibility.js', () => ({ betaEligibility: () => ({ eligible: true }) }));
jest.mock('../../lib/sync.js', () => ({ pushDailyState: jest.fn() }));

const plan = () => ({ id: 'volume_beta', version: 1, experiment_id: 'pilot-1',
  started_on: '2026-10-01', ends_on: '2026-11-11', sets: 2, rest_s: 300, goal_sessions_per_grip: 18 });
const config = () => ({ grip: 'Micro', hand: 'Both', targetTime: 30, repsPerSet: 4, restTime: 20,
  plannedLoadByHand: { L: 20, R: 22 }, volumePlan: plan() });
beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-10-01T12:00:00Z')));
afterEach(() => jest.useRealTimers());
const advanceClock = ms => { act(() => jest.advanceTimersByTime(ms)); };
function setup({ connected = true, cfg = config(), history = [] } = {}) {
  const addReps = jest.fn();
  const view = renderHook(() => useSessionRunner({ history, addReps, tindeqConnected: connected }));
  act(() => view.result.current.startSession(cfg));
  if (!connected) act(() => view.result.current.chooseOffset(false));
  return { ...view, addReps, connected };
}
function pull(view, extra = {}) {
  const start = Date.now(), kg = view.result.current.refWeights[view.result.current.activeHand];
  advanceClock(10000);
  act(() => view.result.current.handleRepDone({ actualTime: 10, startedAtMs: start, endedAtMs: Date.now(),
    ...(view.connected ? { avgForce: kg, forceRecording: { version: 4, signal_quality: 'complete',
      recording_stop_reason: 'release', activity: { started_at_ms: start, ended_at_ms: Date.now() } } }
      : { manualLoadKg: kg }), ...extra }));
}
function handSet(view, extra = {}) {
  for (let i = 0; i < 4; i++) {
    pull(view, extra);
    if (i < 3) { advanceClock(20000); act(() => view.result.current.handleRestDone()); }
  }
}
function firstSet(view) {
  handSet(view);
  if (view.result.current.config.hand === 'Both') {
    act(() => view.result.current.handleSwitchHandsReady());
    handSet(view);
  }
}

test.each([true, false])('a full five-minute break starts automatically after both hands and requires ready (device=%s)', connected => {
  const view = setup({ connected });
  const first = view.result.current.activeHand, second = first === 'L' ? 'R' : 'L';
  handSet(view);
  const firstRelease = Date.now();
  act(() => view.result.current.handleSwitchHandsReady());
  handSet(view);
  const secondRelease = Date.now();
  expect(view.result.current.phase).toBe('between_sets');
  act(() => view.result.current.handleNextSet());
  expect(view.result.current).toMatchObject({ phase: 'between_sets', currentSet: 2,
    activeHand: first, setRestHand: first, setRestSeconds: 300, setRestStartedAtMs: secondRelease,
    setRestSource: connected ? 'device_release' : 'manual_tap' });
  // The full break starts after the second hand, while real per-hand rest
  // still includes the 100 seconds spent training the opposite hand.
  expect(secondRelease - firstRelease).toBe(100000);
  advanceClock(300000);
  expect(view.result.current.phase).toBe('between_sets');
  act(() => view.result.current.handleSetRestDone());
  expect(view.result.current.phase).toBe('rep_ready');
  handSet(view);
  expect(view.result.current.phase).toBe('switch_hands');
  act(() => view.result.current.handleSwitchHandsReady());
  expect(view.result.current).toMatchObject({ phase: 'rep_ready', activeHand: second });
  expect(view.result.current.phase).toBe('rep_ready');
  handSet(view);
  const rows = view.result.current.sessionReps;
  expect(rows).toHaveLength(16);
  for (const hand of [first, second]) {
    const opener = rows.find(r => r.hand === hand && r.set_num === 2 && r.rep_num === 1);
    expect(opener).toMatchObject({ rest_s: 20, rep_timing: { rest_before_s: 400, rest_planned_s: 300 },
      force_recording: { volume_beta: { experiment_id: 'pilot-1', sets: 2,
        between_set_rest: { planned_s: 300, actual_s: 400 } } } });
    expect(rows.filter(r => r.hand === hand).every(r => r.prescribed_load_kg === (hand === 'L' ? 20 : 22))).toBe(true);
  }
  expect(rows.every(r => r.force_recording.volume_beta.experiment_id === 'pilot-1')).toBe(true);
  expect(freshFitReps(rows)).toHaveLength(connected ? 2 : 0);
  expect(freshFitReps(rows).every(r => r.set_num === 1)).toBe(true);
  act(() => view.result.current.handleNextSet());
  expect(view.result.current).toMatchObject({ phase: 'done', currentSet: 2 });
});

test('right-first day remains right-first for both sets; early start records actual rest without penalty', () => {
  const view = setup({ history: [{ date: '2026-09-30', hand: 'L', actual_time_s: 30 }] });
  expect(view.result.current.activeHand).toBe('R');
  firstSet(view);
  act(() => view.result.current.handleNextSet());
  expect(view.result.current.setRestHand).toBe('R');
  advanceClock(22000);
  act(() => view.result.current.handleSetRestDone());
  pull(view);
  const r = view.result.current.sessionReps.at(-1);
  expect(r).toMatchObject({ hand: 'R', set_num: 2, failure_valid: true,
    rep_timing: { rest_before_s: 122 }, force_recording: { volume_beta: { between_set_rest: { actual_s: 122 } } } });
});

test('physical release, not capacity cutoff, anchors set rest', () => {
  const view = setup({ cfg: { ...config(), hand: 'L', repsPerSet: 1 } });
  const start = Date.now(); advanceClock(20000);
  act(() => view.result.current.handleRepDone({ actualTime: 10, avgForce: 20,
    startedAtMs: start, endedAtMs: start + 10000, forceRecording: { version: 4,
      recording_stop_reason: 'release', credited_end_at_ms: start + 10000,
      activity: { started_at_ms: start, ended_at_ms: start + 18000 } } }));
  act(() => view.result.current.handleNextSet());
  expect(view.result.current.setRestStartedAtMs).toBe(start + 18000);
  advanceClock(298000); act(() => view.result.current.handleSetRestDone()); pull(view);
  expect(view.result.current.sessionReps.at(-1).rep_timing.rest_before_s).toBe(300);
});

test('unknown release uses labelled transition estimate and never invents measured rest', () => {
  const view = setup({ cfg: { ...config(), hand: 'L', repsPerSet: 1 } });
  pull(view, { forceRecording: { version: 4, recording_stop_reason: 'release_not_observed',
    activity: { ended_at_ms: null } } });
  const transition = Date.now();
  act(() => view.result.current.handleNextSet());
  expect(view.result.current).toMatchObject({ setRestStartedAtMs: transition, setRestSource: 'estimated_transition' });
  advanceClock(300000); act(() => view.result.current.handleSetRestDone()); pull(view);
  expect(view.result.current.sessionReps.at(-1)).toMatchObject({
    rep_timing: { rest_before_s: null, rest_source: 'estimated_transition' },
    force_recording: { volume_beta: { between_set_rest: { actual_s: null, estimated_s: 300 } } } });
});

test.each([{ failureValid: false }, { endReason: 'interrupted' },
  { forceRecording: { signal_quality: 'incomplete' } }])('invalid first-set attempts cannot continue: %j', extra => {
  const view = setup({ cfg: { ...config(), hand: 'L' } });
  handSet(view, extra);
  act(() => view.result.current.handleNextSet());
  expect(view.result.current).toMatchObject({ phase: 'done', currentSet: 1 });
});

test('incomplete first set can end, and cannot acquire an extra set', () => {
  const view = setup(); pull(view); act(() => view.result.current.handleAbort());
  act(() => view.result.current.handleNextSet());
  expect(view.result.current).toMatchObject({ phase: 'done', currentSet: 1 });
});

test('two queued continue events still start only the second set', () => {
  const view = setup({ cfg: { ...config(), hand: 'L' } });
  firstSet(view);
  act(() => {
    view.result.current.handleNextSet();
    view.result.current.handleNextSet();
  });
  expect(view.result.current).toMatchObject({ phase: 'between_sets', currentSet: 2, currentRep: 0 });
});

test('plan snapshot ignores later source mutation and expires for a future session', () => {
  const cfg = config(), view = setup({ cfg });
  cfg.volumePlan.experiment_id = 'changed';
  pull(view);
  expect(view.result.current.sessionReps[0].force_recording.volume_beta.experiment_id).toBe('pilot-1');
  jest.setSystemTime(new Date('2026-11-12T12:00:00Z'));
  act(() => view.result.current.startSession(cfg));
  expect(view.result.current.config.volumePlan).toBeNull();
  pull(view);
  expect(view.result.current.sessionReps[0].force_recording.volume_beta).toBeUndefined();
});

test.each([{ rest_s: 200 }, { sets: 3 }, { started_on: '2026-02-30' }, { experiment_id: '' },
  { started_on: '2026-10-02' }])('invalid plan %j cannot activate volume mode', patch => {
  const view = setup({ cfg: { ...config(), volumePlan: { ...plan(), ...patch } } });
  expect(view.result.current.config.volumePlan).toBeNull();
});

test('Chaos and peak cannot be combined with Volume Beta', () => {
  const mixedDomainPlan = makeMixedDomainPlan(MIXED_DOMAIN_ZONES.map(key => ({ key, L: 20, R: 22 })), 'power', ['L', 'R']);
  for (const special of [{ mixedDomainPlan }, { peakTest: true }]) {
    const view = setup({ cfg: { ...config(), ...special } });
    expect(view.result.current.config.volumePlan).toBeNull();
    view.unmount();
  }
});

import { act, renderHook } from '@testing-library/react';
import { useSessionRunner } from '../useSessionRunner.js';
import { makeMixedDomainPlan, MIXED_DOMAIN_ZONES, nextMixedDomainZone } from '../../model/mixedDomain.js';
import { freshFitReps } from '../../model/load.js';
import { recoveryEvidence } from '../../model/recoveryEvidence.js';
import { computeDensityLadder } from '../../model/densityLadder.js';
import { findPrevSessionReps } from '../../model/repCurveData.js';
jest.mock('../../lib/sync.js', () => ({ pushDailyState: jest.fn() }));

const rows = MIXED_DOMAIN_ZONES.map((key, i) => ({ key, L: 30 - i * 4, R: 35 - i * 4 }));
const makePlan = () => makeMixedDomainPlan(rows, 'strength', ['L', 'R']);
function setup({ connected = true, hand = 'Both', cooked = null, adjust = false } = {}) {
  const addReps = jest.fn();
  const hook = renderHook(() => useSessionRunner({ history: [], addReps, tindeqConnected: connected }));
  const plan = makePlan();
  act(() => hook.result.current.startSession({ grip: 'Micro', hand, cooked,
    adjustLoadForFatigue: adjust, mixedDomainPlan: plan }));
  if (!connected) act(() => hook.result.current.chooseOffset(false));
  return { hook, addReps, plan };
}
function complete(hook, overrides = {}) {
  const kg = hook.result.current.refWeights[hook.result.current.activeHand];
  act(() => hook.result.current.handleRepDone({ actualTime: 25, avgForce: kg,
    peakForce: kg + 1, failureValid: true, endReason: 'muscular_failure',
    forceRecording: { version: 2, capacity_eligible: true, signal_quality: 'complete' },
    ...overrides }));
}

test('both hands run five frozen loads, rest shows the next load, and only openers fit capacity', () => {
  const { hook, addReps, plan } = setup();
  expect(hook.result.current.config).toMatchObject({ repsPerSet: 5, restTime: 30, targetTime: 115 });
  // A caller changing its plan cannot alter an underway session.
  plan.steps[0].loadByHand.L = 99;
  expect(hook.result.current.refWeights.L).toBe(22);
  for (const hand of ['L', 'R']) {
    expect(hook.result.current.activeHand).toBe(hand);
    expect(hook.result.current.activeRepConfig.goal).toBe('strength');
    for (let i = 0; i < 5; i++) {
      const expectedLoads = hand === 'L' ? [22, 30, 26, 18, 14] : [27, 35, 31, 23, 19];
      expect(hook.result.current.refWeights[hand]).toBe(expectedLoads[i]);
      complete(hook, { startedAtMs: i * 60000, endedAtMs: i * 60000 + 25000 });
      if (i < 4) {
        expect(hook.result.current.phase).toBe('resting');
        expect(hook.result.current.nextWeight).toBe(expectedLoads[i + 1]);
        act(() => hook.result.current.handleRestDone());
      }
    }
    if (hand === 'L') {
      expect(hook.result.current.phase).toBe('switch_hands');
      act(() => hook.result.current.setPhase('rep_ready'));
    }
  }
  expect(hook.result.current.phase).toBe('done');
  const saved = addReps.mock.calls.flatMap(c => c[0]);
  expect(saved).toHaveLength(10);
  expect(saved.filter(r => r.hand === 'L').map(r => r.target_duration)).toEqual([115, 30, 70, 160, 220]);
  expect(saved[1]).toMatchObject({ prescribed_load_kg: 30, rest_s: 30, failed: false,
    rep_timing: { rest_before_s: 35 }, failure_valid: true,
    force_recording: { capacity_eligible: false, session_protocol: { role: 'fatigued_hold', zone: 'power' } } });
  expect(freshFitReps(saved).map(r => [r.hand, r.rep_num])).toEqual([['L', 1], ['R', 1]]);
  expect(recoveryEvidence(saved.filter(r => r.hand === 'L'))).toMatchObject({ eligible: false, reason: 'mixed_load_protocol' });
  act(() => hook.result.current.handleNextSet());
  expect(hook.result.current.currentSet).toBe(1);
  expect(hook.result.current.phase).toBe('done');
});

test('manual rest waits for the next load and records nominal loads without inventing sensor evidence', () => {
  const { hook, addReps } = setup({ connected: false, hand: 'R' });
  complete(hook, { avgForce: null, peakForce: null, forceRecording: null, manualLoadKg: 27 });
  act(() => hook.result.current.handleRestDone());
  expect(hook.result.current.phase).toBe('rep_ready');
  expect(hook.result.current.refWeights.R).toBe(35);
  complete(hook, { avgForce: null, peakForce: null, forceRecording: null, manualLoadKg: 35 });
  expect(addReps.mock.calls[1][0][0]).toMatchObject({ manual_load_kg: 35,
    load_provenance: 'nominal_setting', prescribed_load_kg: 35,
    force_recording: { capacity_eligible: false } });
});

test('fatigue adjustment is applied exactly once to every planned load', () => {
  const { hook } = setup({ hand: 'L', cooked: 8, adjust: true });
  expect(hook.result.current.refWeights.L).toBeCloseTo(17.6);
  complete(hook);
  expect(hook.result.current.nextWeight).toBeCloseTo(24);
});

test('interrupted opener is retained but neither fits capacity nor advances opening rotation', () => {
  const { hook } = setup({ hand: 'L' });
  complete(hook, { failureValid: false, endReason: 'equipment_interruption',
    forceRecording: { capacity_eligible: false } });
  act(() => hook.result.current.handleAbort());
  const saved = hook.result.current.sessionReps;
  expect(saved[0].actual_time_s).toBe(25);
  expect(freshFitReps(saved)).toEqual([]);
  expect(nextMixedDomainZone(saved, 'Micro', ['L'], 'strength')).toBe('strength');
});

test('beta history cannot advance, reset, or replace a regular ladder or same-load comparison', () => {
  const old = [40, 24, 16, 12].map((t, i) => ({ id: `old-${i}`, session_id: 'old',
    date: '2026-01-01', grip: 'Micro', hand: 'L', set_num: 1, rep_num: i + 1,
    actual_time_s: t, target_duration: 40, prescribed_load_kg: 30 }));
  const { hook } = setup({ hand: 'L' });
  for (let i = 0; i < 5; i++) {
    complete(hook);
    if (i < 4) act(() => hook.result.current.handleRestDone());
  }
  const combined = [...old, ...hook.result.current.sessionReps];
  expect(computeDensityLadder(combined, 'Micro', 'power')).toEqual(computeDensityLadder(old, 'Micro', 'power'));
  expect(computeDensityLadder(combined, 'Micro', 'power').reps).toBe(5);
  expect(findPrevSessionReps(combined, { grip: 'Micro', hand: 'L', targetDuration: 40 })).toEqual(old);
});

test('malformed or missing-hand beta plans cannot start a workout', () => {
  const hook = renderHook(() => useSessionRunner({ history: [], addReps: jest.fn(), tindeqConnected: true }));
  const plan = makePlan();
  delete plan.steps[3].loadByHand.R;
  act(() => hook.result.current.startSession({ grip: 'Micro', hand: 'Both', mixedDomainPlan: plan }));
  expect(hook.result.current.phase).toBe('idle');
});

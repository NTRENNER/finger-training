// Protocol tests assume enrollment eligibility; access is covered separately.
import { act, renderHook } from '@testing-library/react';
import { useSessionRunner } from '../useSessionRunner.js';
import { makeMixedDomainPlan, MIXED_DOMAIN_ZONES } from '../../model/mixedDomain.js';
import { freshFitReps } from '../../model/load.js';
import { predForceThreeExp } from '../../model/threeExp.js';
import { summarizeMixedPredictions } from '../../model/mixedLoadPrediction.js';
import { recoveryEvidence } from '../../model/recoveryEvidence.js';
import { computeDensityLadder } from '../../model/densityLadder.js';
import { findPrevSessionReps } from '../../model/repCurveData.js';
jest.mock('../../model/betaEligibility.js', () => ({ betaEligibility: () => ({ eligible: true }) }));
jest.mock('../../lib/sync.js', () => ({ pushDailyState: jest.fn() }));

const rows = MIXED_DOMAIN_ZONES.map((key, i) => ({ key, L: 30 - i * 4, R: 35 - i * 4 }));
const makePlan = () => ({ ...makeMixedDomainPlan(rows, 'strength', ['L', 'R'], false), version: 1 }); // Legacy fixed-reference plans remain supported.
function setup({ connected = true, hand = 'Both', cooked = null, adjust = false, history = [] } = {}) {
  const addReps = jest.fn();
  const view = renderHook(() => useSessionRunner({ history, addReps, tindeqConnected: connected }));
  const plan = makePlan();
  act(() => view.result.current.startSession({ grip: 'Micro', hand, cooked,
    adjustLoadForFatigue: adjust, mixedDomainPlan: plan }));
  if (!connected) act(() => view.result.current.chooseOffset(false));
  return { view, addReps, plan };
}
function complete(view, overrides = {}) {
  const kg = view.result.current.refWeights[view.result.current.activeHand];
  act(() => view.result.current.handleRepDone({ actualTime: 25, avgForce: kg,
    peakForce: kg + 1, failureValid: true, endReason: 'muscular_failure',
    forceRecording: { version: 2, capacity_eligible: true, signal_quality: 'complete', duration_s: 25, impulse_kg_s: kg * 25 },
    ...overrides }));
}

test('both hands run five frozen loads, rest shows the next load, and only openers fit capacity', () => {
  const { view, addReps, plan } = setup();
  expect(view.result.current.config).toMatchObject({ repsPerSet: 5, restTime: 30, targetTime: 115 });
  // A caller changing its plan cannot alter an underway session.
  plan.steps[0].loadByHand.L = 99;
  expect(view.result.current.refWeights.L).toBe(22);
  for (const hand of ['L', 'R']) {
    expect(view.result.current.activeHand).toBe(hand);
    expect(view.result.current.activeRepConfig.goal).toBe('strength');
    for (let i = 0; i < 5; i++) {
      const expectedLoads = hand === 'L' ? [22, 30, 26, 18, 14] : [27, 35, 31, 23, 19];
      expect(view.result.current.refWeights[hand]).toBe(expectedLoads[i]);
      complete(view, { startedAtMs: i * 60000, endedAtMs: i * 60000 + 25000 });
      expect(view.result.current.phase).toBe(i < 4 ? 'resting' : hand === 'L' ? 'switch_hands' : 'done');
      const nextLoads = i < 4 ? [view.result.current.nextWeight] : [];
      expect(nextLoads).toEqual(expectedLoads.slice(i + 1, i + 2));
      if (i < 4) {
        act(() => view.result.current.handleRestDone());
      }
    }
    expect(view.result.current.phase).toBe(hand === 'L' ? 'switch_hands' : 'done');
    if (hand === 'L') {
      act(() => view.result.current.setPhase('rep_ready'));
    }
  }
  expect(view.result.current.phase).toBe('done');
  const saved = addReps.mock.calls.flatMap(c => c[0]);
  expect(saved).toHaveLength(10);
  expect(saved.filter(r => r.hand === 'L').map(r => r.target_duration)).toEqual([115, 30, 70, 160, 220]);
  expect(saved[1]).toMatchObject({ prescribed_load_kg: 30, rest_s: 30, failed: false,
    rep_timing: { rest_before_s: 35 }, failure_valid: true,
    force_recording: { capacity_eligible: false, session_protocol: { role: 'fatigued_hold', zone: 'power' } } });
  expect(freshFitReps(saved).map(r => [r.hand, r.rep_num])).toEqual([['L', 1], ['R', 1]]);
  expect(recoveryEvidence(saved.filter(r => r.hand === 'L'))).toMatchObject({ eligible: false, reason: 'mixed_load_protocol' });
  act(() => view.result.current.handleNextSet());
  expect(view.result.current.currentSet).toBe(2);
  expect(view.result.current.phase).toBe('between_sets');
});

test('manual rest waits for the next load and records nominal loads without inventing sensor evidence', () => {
  const { view, addReps } = setup({ connected: false, hand: 'R' });
  complete(view, { avgForce: null, peakForce: null, forceRecording: null, manualLoadKg: 27 });
  act(() => view.result.current.handleRestDone());
  expect(view.result.current.phase).toBe('rep_ready');
  expect(view.result.current.refWeights.R).toBe(35);
  complete(view, { avgForce: null, peakForce: null, forceRecording: null, manualLoadKg: 35 });
  expect(addReps.mock.calls[1][0][0]).toMatchObject({ manual_load_kg: 35,
    load_provenance: 'nominal_setting', prescribed_load_kg: 35,
    force_recording: { capacity_eligible: false } });
});

test('fatigue adjustment is applied exactly once to every planned load', () => {
  const { view } = setup({ hand: 'L', cooked: 8, adjust: true });
  expect(view.result.current.refWeights.L).toBeCloseTo(17.6);
  complete(view);
  expect(view.result.current.nextWeight).toBeCloseTo(24);
});

test('interrupted opener is retained but does not fit capacity', () => {
  const { view } = setup({ hand: 'L' });
  complete(view, { failureValid: false, endReason: 'equipment_interruption',
    forceRecording: { capacity_eligible: false } });
  act(() => view.result.current.handleAbort());
  const saved = view.result.current.sessionReps;
  expect(saved[0].actual_time_s).toBe(25);
  expect(freshFitReps(saved)).toEqual([]);
});

test('beta history cannot advance, reset, or replace a regular ladder or same-load comparison', () => {
  const old = [40, 24, 16, 12].map((t, i) => ({ id: `old-${i}`, session_id: 'old',
    date: '2026-01-01', grip: 'Micro', hand: 'L', set_num: 1, rep_num: i + 1,
    actual_time_s: t, target_duration: 40, prescribed_load_kg: 30 }));
  const { view } = setup({ hand: 'L' });
  for (let i = 0; i < 5; i++) {
    complete(view);
    if (i < 4) act(() => view.result.current.handleRestDone());
  }
  const combined = [...old, ...view.result.current.sessionReps];
  expect(computeDensityLadder(combined, 'Micro', 'power')).toEqual(computeDensityLadder(old, 'Micro', 'power'));
  expect(computeDensityLadder(combined, 'Micro', 'power').reps).toBe(5);
  expect(findPrevSessionReps(combined, { grip: 'Micro', hand: 'L', targetDuration: 40 })).toEqual(old);
});

test('malformed or missing-hand beta plans cannot start a workout', () => {
  const view = renderHook(() => useSessionRunner({ history: [], addReps: jest.fn(), tindeqConnected: true }));
  const plan = makePlan();
  delete plan.steps[3].loadByHand.R;
  act(() => view.result.current.startSession({ grip: 'Micro', hand: 'Both', mixedDomainPlan: plan }));
  expect(view.result.current.phase).toBe('idle');
});


test('shadow forecasts persist for both hands while live history changes and loads stay frozen', () => {
  const history = ['L', 'R'].flatMap(hand => [10, 30, 70, 115, 160, 220].map((t, i) => ({
    id: `old-${hand}-${i}`, session_id: `old-${i}`, date: `2026-09-${10 + i}`, grip: 'Micro', hand,
    rep_num: 1, set_num: 1, actual_time_s: t, avg_force_kg: predForceThreeExp([18, 15, 25], t),
    peak_force_kg: 60, load_provenance: 'measured_force', failure_valid: true,
    force_recording: { version: 2, capacity_eligible: true },
  })));
  jest.useFakeTimers().setSystemTime(new Date('2026-09-23T12:00:00Z'));
  try {
    const { view, addReps } = setup({ history });
    const firstModels = {}, openingPredictions = [];
    for (const hand of ['R', 'L']) {
      for (let i = 0; i < 5; i++) {
        complete(view, { startedAtMs: i * 60000, endedAtMs: i * 60000 + 25000 });
        const r = addReps.mock.calls.at(-1)[0][0];
        const p = r.force_recording.mixed_load_prediction;
        expect(p.model.status).toBe('ready');
        expect(p.model.source_sessions).toBe(6);
        expect(p.comparison.status).toBe('recorded');
        expect(p.prior_rep_ids).toHaveLength(i);
        if (i === 0) {
          openingPredictions.push([p.prediction, p.fresh_only]);
          firstModels[hand] = p.model;
        }
        expect(p.model).toEqual(firstModels[hand]);
        // Simulate data changing during the workout. This must not refit it.
        history.push({ ...history[0], id: `new-${hand}-${i}`, session_id: `new-${hand}-${i}`,
          date: '2026-09-23', avg_force_kg: 100 });
        view.rerender();
        if (i < 4) act(() => view.result.current.handleRestDone());
      }
      if (hand === 'R') act(() => view.result.current.setPhase('rep_ready'));
    }
    expect(openingPredictions).toHaveLength(2);
    for (const [prediction, fresh] of openingPredictions) expect(prediction).toEqual(fresh);
    const saved = JSON.parse(JSON.stringify(addReps.mock.calls.flatMap(c => c[0])));
    expect(saved.map(r => r.prescribed_load_kg)).toEqual([27,35,31,23,19,22,30,26,18,14]);
    expect(summarizeMixedPredictions(saved).excluded.edited_since_prediction).toBeUndefined();
    expect(saved.filter(r => r.force_recording.capacity_eligible)).toHaveLength(2);
    // A new session gets a new snapshot and no previous hand's fatigue.
    act(() => view.result.current.startSession({ grip: 'Micro', hand: 'L', mixedDomainPlan: makePlan() }));
    complete(view);
    const next = addReps.mock.calls.at(-1)[0][0].force_recording.mixed_load_prediction;
    expect(next.prior_rep_ids).toEqual([]);
    // Identical repeated rows are deduplicated by the shared fresh-history filter.
    expect(next.model.source_sessions).toBe(6); // a second same-day session is not fresh evidence
  } finally { jest.useRealTimers(); }
});


test('new domain-cycle plans run the frozen sequence on both hands and save its version', () => {
  const addReps = jest.fn();
  const history = [];
  const view = renderHook(() => useSessionRunner({ history, addReps, tindeqConnected: true }));
  const plan = makeMixedDomainPlan(rows, 'strength_endurance', ['L', 'R'], false);
  act(() => view.result.current.startSession({ grip: 'Micro', hand: 'Both', mixedDomainPlan: plan }));
  const expected = ['strength_endurance', 'endurance', 'power', 'power_strength', 'strength'];
  plan.steps.reverse(); // Changes to setup data cannot rearrange an active session.
  const first = view.result.current.activeHand;
  for (let h = 0; h < 2; h++) {
    const hand = view.result.current.activeHand;
    expect(hand).toBe(h === 0 ? first : first === 'L' ? 'R' : 'L');
    for (let i = 0; i < 5; i++) {
      expect(view.result.current.activeRepConfig.goal).toBe(expected[i]);
      complete(view);
      if (i < 4) act(() => view.result.current.handleRestDone());
    }
    if (h === 0) act(() => view.result.current.setPhase('rep_ready'));
  }
  const saved = addReps.mock.calls.flatMap(c => c[0]);
  for (const hand of ['L', 'R']) {
    expect(saved.filter(r => r.hand === hand).map(r => r.force_recording.session_protocol.zone)).toEqual(expected);
  }
  expect(saved.every(r => r.force_recording.session_protocol.version === 2)).toBe(true);
});


test('adaptive sessions with no measured history persist opening and fallback truthfully', () => {
  const addReps = jest.fn();
  const view = renderHook(() => useSessionRunner({ history: [], addReps, tindeqConnected: true }));
  act(() => view.result.current.startSession({ grip: 'Micro', hand: 'L',
    mixedDomainPlan: makeMixedDomainPlan(rows, 'power', ['L']) }));
  complete(view);
  act(() => view.result.current.handleRestDone());
  complete(view);
  const [first, second] = addReps.mock.calls.flatMap(c => c[0]);
  expect(first.force_recording.session_protocol).toMatchObject({ load_mode: 'opening_reference', requested_load_mode: 'adaptive_targets' });
  expect(second.force_recording.session_protocol).toMatchObject({ load_mode: 'reference_fallback',
    duration_reference: 'fresh_load_reference', adjustment_reason: 'insufficient_fresh_history' });
  expect(second.force_recording.mixed_load_prediction.adjustment.status).toBe('unavailable');
  expect(second.prescribed_load_kg).toBe(rows[1].L);
});

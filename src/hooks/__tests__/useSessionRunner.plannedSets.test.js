import { act, renderHook } from '@testing-library/react';
import { useSessionRunner } from '../useSessionRunner.js';
import { makeMixedDomainPlan, MIXED_DOMAIN_ZONES } from '../../model/mixedDomain.js';
import { predForceThreeExp } from '../../model/threeExp.js';
import { ZONE_REF_T } from '../../model/zones.js';
import { freshFitReps } from '../../model/load.js';
import { summarizeMixedPredictions } from '../../model/mixedLoadPrediction.js';
jest.mock('../../model/betaEligibility.js', () => ({ betaEligibility: () => ({ eligible: true }) }));
jest.mock('../../lib/sync.js', () => ({ pushDailyState: jest.fn() }));
const history = ['L', 'R'].flatMap(hand => [10, 30, 70, 115, 160, 220].map((t, i) => ({
  id: `old-${hand}-${i}`, session_id: `old-${i}`, date: `2026-09-${10+i}`, grip: 'Micro', hand,
  rep_num: 1, set_num: 1, actual_time_s: t, avg_force_kg: predForceThreeExp([18,15,25], t),
  load_provenance: 'measured_force', failure_valid: true,
  force_recording: { version: 3, basis: 'target_acquired', capacity_eligible: true, signal_quality: 'complete' },
})));
const plan = () => makeMixedDomainPlan(MIXED_DOMAIN_ZONES.map(key => ({ key,
  L: predForceThreeExp([18,15,25], ZONE_REF_T[key]), R: predForceThreeExp([18,15,25], ZONE_REF_T[key]),
})), 'power', ['L','R']);
beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-10-01T12:00:00Z')));
afterEach(() => jest.useRealTimers());
const advanceClock = ms => { act(() => jest.advanceTimersByTime(ms)); };
function setup(mixed, connected = true, hand = 'Both') {
  const view = renderHook(() => useSessionRunner({ history, addReps: jest.fn(), tindeqConnected: connected }));
  act(() => view.result.current.startSession({ grip: 'Micro', hand, plannedSets: 3,
    targetTime: 30, repsPerSet: 4, restTime: 20, plannedLoadByHand: { L: 20, R: 22 },
    ...(mixed ? { mixedDomainPlan: plan() } : {}) }));
  if (!connected) act(() => view.result.current.chooseOffset(false));
  return view;
}
function pull(view, connected = true, interrupted = false) {
  const kg = view.result.current.refWeights[view.result.current.activeHand], start = Date.now(), time = 10;
  advanceClock(time * 1000);
  act(() => view.result.current.handleRepDone({ actualTime: time, startedAtMs: start, endedAtMs: Date.now(),
    failureValid: !interrupted, endReason: interrupted ? 'equipment_interruption' : 'muscular_failure',
    ...(connected ? { avgForce: kg, forceRecording: { version: 3, basis: 'target_acquired',
      acquisition_s: 0, duration_s: time, impulse_kg_s: kg*time, capacity_eligible: true,
      signal_quality: 'complete', recording_stop_reason: 'release',
      activity: { started_at_ms: start, ended_at_ms: Date.now(), signal_quality: 'complete', duration_s: time, impulse_kg_s: kg*time } } }
      : { manualLoadKg: kg }) }));
}
function handSet(view, connected = true, interrupted = false) {
  const n = view.result.current.config.repsPerSet;
  for (let i = 0; i < n; i++) {
    pull(view, connected, interrupted && i === 0);
    if (i < n-1) { advanceClock(view.result.current.config.restTime * 1000); act(() => view.result.current.handleRestDone()); }
  }
}

function threeSets(mixed) {
  const view = setup(mixed), first = view.result.current.activeHand;
  const transitions = [], readyPhases = [];
  for (let set = 1; set <= 3; set++) {
    expect(view.result.current.currentSet).toBe(set);
    expect(view.result.current.activeHand).toBe(first);
    handSet(view);
    act(() => view.result.current.handleSwitchHandsReady());
    expect(view.result.current.phase).toBe(set > 1 ? 'between_sets' : 'rep_ready');
    if (set > 1) {
      act(() => view.result.current.handleSetRestDone());
    }
    handSet(view);
    expect(view.result.current.phase).toBe('done');
    if (set < 3) {
      act(() => { view.result.current.handleNextSet(); view.result.current.handleNextSet(); });
      const next = view.result.current;
      transitions.push({ currentSet: next.currentSet, phase: next.phase, setRestSeconds: next.setRestSeconds });
      advanceClock(300000);
      act(() => view.result.current.handleSetRestDone());
      readyPhases.push(view.result.current.phase);
    }
  }
  const rows = view.result.current.sessionReps;
  expect(rows).toHaveLength((mixed ? 5 : 4) * 2 * 3);
  expect(rows.every(r => r.force_recording.workout_plan.sets === 3 && !r.force_recording.volume_beta)).toBe(true);
  expect(freshFitReps(rows).every(r => r.set_num === 1)).toBe(true);
  expect(freshFitReps(rows)).toHaveLength(2);
  const later = rows.find(r => r.hand === first && r.set_num === 2 && r.rep_num === 1);
  expect(later.rep_timing.rest_before_s).toBeGreaterThanOrEqual(300);
  expect(transitions).toEqual([2,3].map(currentSet => ({ currentSet, phase: 'between_sets', setRestSeconds: 300 })));
  expect(readyPhases).toEqual(['rep_ready', 'rep_ready']);
  return { rows, later, first };
}

test('three Chaos sets preserve cumulative fatigue, rest and hand order', () => {
  const { rows, later, first } = threeSets(true);
    expect(later.force_recording).toMatchObject({ capacity_eligible: false,
      session_protocol: { role: 'fatigued_hold', load_mode: 'adaptive_targets' } });
    expect(later.force_recording.mixed_load_prediction.prior_rep_ids).toHaveLength(5);
    const last = rows.filter(r => r.hand === first).at(-1);
    expect(last.force_recording.mixed_load_prediction.prior_rep_ids).toHaveLength(14);
    expect(last.force_recording.mixed_load_prediction.comparison.status).toBe('recorded');
    const review = summarizeMixedPredictions(rows);
    expect(review.excluded.invalid_sequence).toBeUndefined();
    expect(review.excluded.edited_since_prediction).toBeUndefined();
    expect(review.observations.some(o => o.id === later.id)).toBe(true);
});
test('three ordinary sets preserve loads, rest and hand order', () => {
  const { rows, first } = threeSets(false);
  expect(rows.filter(r => r.hand === first).every(r => r.prescribed_load_kg === (first === 'L' ? 20 : 22))).toBe(true);
});

test('manual selected sets retain the real rest and do not enroll in Volume Beta', () => {
  const view = setup(false, false, 'L');
  handSet(view, false);
  act(() => view.result.current.handleNextSet());
  advanceClock(240000); act(() => view.result.current.handleSetRestDone()); pull(view, false);
  expect(view.result.current.sessionReps.at(-1)).toMatchObject({ set_num: 2, rep_timing: { rest_before_s: 240 },
    force_recording: { workout_plan: { source: 'user_selected' } } });
});
test('interrupted Chaos work remains in the next set prefix instead of resetting fatigue', () => {
  const view = setup(true, true, 'L');
  handSet(view, true, true);
  act(() => view.result.current.handleNextSet());
  advanceClock(300000); act(() => view.result.current.handleSetRestDone());
  expect(view.result.current.activeRepConfig.mixedLoadAdjustment).toMatchObject({ status: 'unavailable', reason: 'unmeasured_or_interrupted_prefix' });
  pull(view);
  expect(view.result.current.sessionReps.at(-1).force_recording.session_protocol.load_mode).toBe('reference_fallback');
});

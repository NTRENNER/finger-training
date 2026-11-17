import { act, renderHook } from '@testing-library/react';
import { useSessionRunner } from '../useSessionRunner.js';

jest.mock('../../lib/sync.js', () => ({ pushDailyState: jest.fn() }));

// The previous day's 30 s opener for this grip and hand: 15 kg for 10 s.
const recording = { version: 3, basis: 'target_acquired', capacity_eligible: true, signal_quality: 'complete' };
const history = [{ id: 'prev-L', session_id: 'prev', date: '2026-09-30', session_started_at: '2026-09-30T12:00:00Z',
  grip: 'Micro', hand: 'L', rep_num: 1, set_num: 1, target_duration: 30, actual_time_s: 10, avg_force_kg: 15,
  load_provenance: 'measured_force', failure_valid: true, end_reason: 'muscular_failure', force_recording: recording }];

beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-10-01T12:00:00Z')));
afterEach(() => jest.useRealTimers());
const advanceClock = ms => { act(() => jest.advanceTimersByTime(ms)); };

function pull(view) {
  const kg = view.result.current.refWeights.L, start = Date.now(), time = 10;
  advanceClock(time * 1000);
  act(() => view.result.current.handleRepDone({ actualTime: time, startedAtMs: start, endedAtMs: Date.now(),
    failureValid: true, endReason: 'muscular_failure', avgForce: kg, forceRecording: { ...recording,
      acquisition_s: 0, duration_s: time, impulse_kg_s: kg * time, recording_stop_reason: 'release',
      activity: { started_at_ms: start, ended_at_ms: Date.now(), signal_quality: 'complete', duration_s: time, impulse_kg_s: kg * time } } }));
}
function set(view) {
  for (let i = 0; i < view.result.current.config.repsPerSet; i++) {
    pull(view);
    if (i < view.result.current.config.repsPerSet - 1) {
      advanceClock(20000); act(() => view.result.current.handleRestDone());
    }
  }
}

// Two sets chosen up front: set one moves straight to the set break, so the
// summary only appears after set two. Set one's awards must still show there.
test('awards earned in set one appear on the summary after a second set', () => {
  const view = renderHook(() => useSessionRunner({ history, addReps: jest.fn(), tindeqConnected: true }));
  act(() => view.result.current.startSession({ grip: 'Micro', hand: 'L', plannedSets: 2,
    targetTime: 30, repsPerSet: 2, restTime: 20, plannedLoadByHand: { L: 20 } }));
  set(view);
  expect(view.result.current.phase).toBe('between_sets');
  act(() => view.result.current.handleNextSet());
  advanceClock(300000); act(() => view.result.current.handleSetRestDone());
  set(view);
  expect(view.result.current.phase).toBe('done');
  expect(view.result.current.sessionReps.some(r => r.set_num === 2)).toBe(true);
  expect(view.result.current.awards).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'last_time', hand: 'L', previousDate: '2026-09-30' })]));
});

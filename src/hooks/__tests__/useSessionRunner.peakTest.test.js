import { act, renderHook } from '@testing-library/react';
import { useSessionRunner } from '../useSessionRunner.js';
import { freshFitReps } from '../../model/load.js';
import { computeDensityLadder } from '../../model/densityLadder.js';
import { isPeakTestRep } from '../../model/peakForce.js';
jest.mock('../../lib/sync.js', () => ({ pushDailyState: jest.fn() }));

test('Peak Test keeps sustained averages and peaks distinct through three attempts per hand', () => {
  const addReps = jest.fn();
  const { result } = renderHook(() => useSessionRunner({ history: [], addReps, tindeqConnected: true }));
  act(() => result.current.startSession({ grip: 'Micro', hand: 'Both', peakTest: true,
    targetTime: 3, repsPerSet: 6, restTime: 20, ladderLoadByHand: { L: 99 }, plannedLoadByHand: { L: 20, R: 21 } }));
  expect(result.current.config).toMatchObject({ targetTime: 5, repsPerSet: 3, restTime: 150, ladderLoadByHand: null });
  for (const hand of ['L', 'R']) {
    for (let i = 0; i < 3; i++) {
      act(() => result.current.handleRepDone({ actualTime: 7 + i, avgForce: 20, peakForce: 28,
        failureValid: !(hand === 'R' && i === 0), endReason: hand === 'R' && i === 0 ? 'interrupted' : 'muscular_failure',
        startedAtMs: i * 160000, endedAtMs: i * 160000 + (7 + i) * 1000,
        forceRecording: { version: 3, basis: 'target_acquired', capacity_eligible: !(hand === 'R' && i === 0) } }));
      if (i < 2) act(() => result.current.handleRestDone());
    }
    if (hand === 'L') act(() => result.current.setPhase('rep_ready'));
  }
  const rows = addReps.mock.calls.flatMap(c => c[0]);
  expect(rows).toHaveLength(6);
  expect(rows.every(isPeakTestRep)).toBe(true);
  expect(rows[0]).toMatchObject({ actual_time_s: 7, avg_force_kg: 20, peak_force_kg: 28, target_duration: 5 });
  expect(freshFitReps(rows)).toHaveLength(1);
  expect(freshFitReps(rows)[0].avg_force_kg).toBe(20);
  expect(computeDensityLadder(rows, 'Micro', 'max_strength')).toBeNull();
  act(() => result.current.handleNextSet());
  expect(result.current.currentSet).toBe(1);
  expect(result.current.phase).toBe('done');
});

import { act, renderHook } from '@testing-library/react';
import { useSessionRunner } from '../useSessionRunner.js';
jest.mock('../../lib/sync.js', () => ({ pushDailyState: jest.fn() }));

test('Peak Test launches the brief protocol and cannot save through the failure runner', () => {
  const addReps = jest.fn();
  const { result } = renderHook(() => useSessionRunner({ history: [], addReps, tindeqConnected: true }));
  act(() => result.current.startSession({ grip: 'Micro', hand: 'Both', peakTest: true,
    targetTime: 5, repsPerSet: 6, restTime: 150, ladderLoadByHand: { L: 99 } }));
  expect(result.current.config).toMatchObject({ targetTime: 3, repsPerSet: 3, restTime: 60, ladderLoadByHand: null });
  act(() => result.current.handleRepDone({ actualTime: 3, avgForce: 20, peakForce: 28 }));
  expect(addReps).not.toHaveBeenCalled();
});

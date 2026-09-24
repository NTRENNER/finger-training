import { act, renderHook } from '@testing-library/react';
import { useSessionRunner } from '../useSessionRunner.js';
jest.mock('../../lib/sync.js', () => ({ pushDailyState: jest.fn() }));

afterEach(() => jest.useRealTimers());
test.each([4, 5, 6])('right-first rotation preserves all %i reps for each hand and later sessions', count => {
  jest.useFakeTimers().setSystemTime(new Date(2026, 8, 24, 12));
  const history = [{ date: '2026-09-20', hand: 'L', actual_time_s: 30 }];
  const addReps = rows => history.push(...rows);
  const { result } = renderHook(() => useSessionRunner({ history, addReps, tindeqConnected: true }));
  const cfg = { grip: 'Micro', hand: 'Both', targetTime: 30, repsPerSet: count, restTime: 20, plannedLoadByHand: { L: 10, R: 11 } };
  act(() => result.current.startSession(cfg));
  expect(result.current.activeHand).toBe('R');
  for (const hand of ['R', 'L']) {
    for (let i = 0; i < count; i++) {
      expect(result.current.activeHand).toBe(hand);
      act(() => result.current.handleRepDone({ actualTime: 30, avgForce: 10 }));
      if (i < count - 1) act(() => result.current.handleRestDone());
    }
    if (hand === 'R') {
      expect(result.current.phase).toBe('switch_hands');
      act(() => result.current.setPhase('rep_ready'));
    }
  }
  expect(result.current.phase).toBe('done');
  expect(result.current.sessionReps).toHaveLength(count * 2);
  expect(result.current.sessionReps.every(r => r.force_recording.hand_order.first_hand === 'R')).toBe(true);
  act(() => result.current.handleNextSet());
  expect(result.current.activeHand).toBe('R');
  act(() => result.current.startSession({ ...cfg, grip: 'Crusher' }));
  expect(result.current.activeHand).toBe('R');
  jest.setSystemTime(new Date(2026, 8, 29, 12));
  act(() => result.current.startSession(cfg));
  expect(result.current.activeHand).toBe('L');
});

test('single-hand sessions record the hand that actually started, then rotate the next day', () => {
  jest.useFakeTimers().setSystemTime(new Date(2026,8,24,12));
  const history = [];
  const { result } = renderHook(() => useSessionRunner({history, addReps: rows => history.push(...rows), tindeqConnected:true}));
  act(() => result.current.startSession({grip:'Micro',hand:'R',targetTime:30,repsPerSet:4,restTime:20,plannedLoadByHand:{R:10}}));
  act(() => result.current.handleRepDone({actualTime:30,avgForce:10}));
  expect(history[0].force_recording.hand_order.first_hand).toBe('R');
  jest.setSystemTime(new Date(2026,8,25,12));
  act(() => result.current.startSession({grip:'Micro',hand:'Both',targetTime:30,repsPerSet:4,restTime:20,plannedLoadByHand:{R:10,L:10}}));
  expect(result.current.activeHand).toBe('L');
});

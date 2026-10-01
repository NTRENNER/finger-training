import { act, renderHook } from '@testing-library/react';
import { useSessionRunner } from '../useSessionRunner.js';
jest.mock('../../lib/sync.js', () => ({ pushDailyState: jest.fn() }));
const cfg = { grip: 'Micro', hand: 'L', targetTime: 30, repsPerSet: 4, restTime: 20, plannedLoadByHand: { L: 20 } };
test.each(['mixedDomainPlan', 'volumePlan'])('stale %s cannot start without qualifying history', field => {
  const onSessionStart = jest.fn();
  const { result } = renderHook(() => useSessionRunner({ history: [], addReps: jest.fn(), onSessionStart, tindeqConnected: true }));
  act(() => expect(result.current.startSession({ ...cfg, [field]: { id: 'stale-plan' } })).toBe(false));
  expect(result.current.phase).toBe('idle');
  expect(onSessionStart).not.toHaveBeenCalled();
  act(() => result.current.startSession(cfg));
  expect(result.current.phase).not.toBe('idle');
});

test('real qualifying history unlocks a Volume workout and preserves its two-set plan', () => {
  jest.useFakeTimers().setSystemTime(new Date('2026-10-01T12:00:00Z'));
  try {
    const row = date => ({ date, grip: 'Micro', hand: 'L', target_duration: 30, actual_time_s: 30,
      avg_force_kg: 20, peak_force_kg: 22 });
    const history = [row('2026-07-01'), ...Array.from({ length: 10 }, (_, w) => [1, 4].map(d =>
      row(new Date(Date.parse('2026-10-01') - (w * 7 + d) * 86400000).toISOString().slice(0, 10)))).flat()];
    const plan = { id: 'volume_beta', version: 1, experiment_id: 'trial', started_on: '2026-10-01',
      ends_on: '2026-11-11', sets: 2, rest_s: 300, goal_sessions_per_grip: 18 };
    const { result } = renderHook(() => useSessionRunner({ history, addReps: jest.fn(), tindeqConnected: true }));
    act(() => result.current.startSession({ ...cfg, volumePlan: plan }));
    expect(result.current.phase).toBe('rep_ready');
    expect(result.current.config.volumePlan).toMatchObject({ experiment_id: 'trial', sets: 2 });
  } finally { jest.useRealTimers(); }
});

test.each(['mixedDomainPlan', 'volumePlan'])('another grip cannot borrow Micro access through a restored %s', field => {
  jest.useFakeTimers().setSystemTime(new Date('2026-10-01T12:00:00Z'));
  try {
    const history = Array.from({ length: 15 }, (_, w) => [1, 4].map(d => ({
      date: new Date(Date.parse('2026-10-01') - (w * 7 + d) * 86400000).toISOString().slice(0, 10),
      grip: 'Micro', hand: 'L', target_duration: 30, actual_time_s: 30, avg_force_kg: 20, peak_force_kg: 22,
    }))).flat();
    const { result } = renderHook(() => useSessionRunner({ history, addReps: jest.fn(), tindeqConnected: true }));
    let started;
    act(() => { started = result.current.startSession({ ...cfg, grip: 'Prime', [field]: { id: 'stale' } }); });
    expect(started).toBe(false);
    expect(result.current.phase).toBe('idle');
    act(() => result.current.startSession({ ...cfg, grip: 'Prime', plannedSets: 3 }));
    expect(result.current.phase).toBe('rep_ready');
    expect(result.current.config.plannedSets).toBe(3);
  } finally { jest.useRealTimers(); }
});

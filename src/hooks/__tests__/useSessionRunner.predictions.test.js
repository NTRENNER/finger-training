import { act, renderHook } from '@testing-library/react';
import { useSessionRunner } from '../useSessionRunner.js';
import { recoveryRows } from '../../testHelpers/recoveryRows.js';
import { buildFreshLoadMap } from '../../model/prescription.js';
import { buildThreeExpPriors } from '../../model/threeExp.js';
import { buildPredictionModels, summarizePredictions } from '../../model/predictionTracking.js';
jest.mock('../../lib/sync.js', () => ({ pushDailyState: jest.fn() }));

jest.mock('../../model/predictionWorkerClient.js', () => ({ createPredictionWorker: jest.fn() }));
const { createPredictionWorker } = require('../../model/predictionWorkerClient.js');
beforeEach(() => {
  global.Worker = jest.fn();
  createPredictionWorker.mockImplementation(() => {
    const worker = { terminate: jest.fn(), postMessage: ({ history, grip, target, day }) => {
      const models = Object.fromEntries(['L','R'].map(hand => [hand,
        buildPredictionModels(history, grip, hand, target, { referenceDate: day })]));
      worker.onmessage({ data: { models } });
    } };
    return worker;
  });
});
afterEach(() => { jest.useRealTimers(); delete global.Worker; });
test.each([4, 5, 6])('frozen forecasts persist without changing a %i-rep session or its loads', async count => {
  jest.useFakeTimers().setSystemTime(new Date('2026-09-24T12:00:00Z'));
  const history = Array.from({ length: 8 }, (_, i) => recoveryRows('legacy', {
    sessionId: `old-${i}`, date: `2026-09-${String(i + 1).padStart(2, '0')}`,
  })).flat();
  const freshMap = buildFreshLoadMap(history), threeExpPriors = buildThreeExpPriors(history);
  const addReps = jest.fn();
  const { result, rerender } = renderHook(() => useSessionRunner({ history, freshMap, threeExpPriors, addReps, tindeqConnected: true }));
  const cfg = { grip: 'Crusher', hand: 'L', targetTime: 30,
    repsPerSet: count, restTime: 20, ladderLoadByHand: { L: 30 }, cooked: null };
  await act(async () => result.current.setConfig(cfg));
  await act(async () => {});
  act(() => result.current.startSession());
  const started = new Date().toISOString();
  // Change all fitting inputs before the outcome callback. The frozen model
  // must still match session-start data, including through a parent rerender.
  threeExpPriors.get('Crusher')[0] = 999;
  history[0].avg_force_kg = 999;
  rerender();
  for (let i = 0; i < count; i++) {
    jest.setSystemTime(new Date(Date.parse(started) + (i + 1) * 60000));
    const startedAtMs = Date.parse(started) + i * 60000;
    act(() => result.current.handleRepDone({ actualTime: 40, avgForce: 30,
      failureValid: true, endReason: 'muscular_failure', startedAtMs, endedAtMs: startedAtMs + 40000,
      forceRecording: { version: 3, basis: 'target_acquired', acquisition_s: .8,
        capacity_eligible: true, signal_quality: 'complete' } }));
    if (i < count - 1) act(() => result.current.handleRestDone());
  }
  expect(result.current.phase).toBe('done');
  const saved = addReps.mock.calls.map(call => call[0][0]);
  expect(saved).toHaveLength(count);
  expect(saved.every(r => r.prescribed_load_kg === 30 && r.target_duration === 30)).toBe(true);
  const first = saved[0].force_recording.prediction_check;
  expect(first.prepared_at).toBe(started);
  expect(first.models.current.amps.every(n => n < 999)).toBe(true);
  const last = saved.at(-1).force_recording.prediction_check;
  expect(last.models.current.source_days).toBe(first.models.current.source_days);
  expect(last.models.recovery).toBeUndefined();
  expect(last.model_snapshot_rep_id).toBe(saved[0].id);
  expect(first.models.adaptive.status).toBe('ready');
  expect(first.models.adaptive.history_before).toBe('2026-09-24');
  expect(first.models.adaptive.forces.every(n => n < 999)).toBe(true);
  expect(summarizePredictions(saved)).toMatchObject({ days: 1,
    adaptive: { days: 1 },
    recovery: { current: { observations: count - 1 } } });
  act(() => result.current.handleNextSet());
  act(() => result.current.handleRepDone({ actualTime: 25, avgForce: 30 }));
  expect(addReps.mock.calls.at(-1)[0][0].force_recording.prediction_check).toBeUndefined();
});

test('standalone peak tests are not treated as ordinary opening-hold predictions', () => {
  const addReps = jest.fn();
  const { result } = renderHook(() => useSessionRunner({ history: [], addReps, tindeqConnected: true }));
  act(() => result.current.startSession({ grip: 'Crusher', hand: 'L', peakTest: true }));
  act(() => result.current.handleRepDone({ actualTime: 3, avgForce: 30 }));
  expect(addReps).not.toHaveBeenCalled();
});

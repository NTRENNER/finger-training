import { act, renderHook, waitFor } from '@testing-library/react';
import { usePerformanceObservations } from '../usePerformanceObservations.js';
import { buildPerformanceObservations } from '../../model/performanceTrendEvidence.js';
import { createPerformanceObservationsWorker } from '../../model/performanceObservationsWorkerClient.js';

jest.mock('../../model/performanceTrendEvidence.js', () => ({ buildPerformanceObservations: jest.fn() }));
jest.mock('../../model/performanceObservationsWorkerClient.js', () => ({
  createPerformanceObservationsWorker: jest.fn(),
}));

const grips = ['Crusher'];
let workers;
function fakeWorker() {
  const worker = { postMessage: jest.fn(), terminate: jest.fn(), onmessage: null, onerror: null };
  workers.push(worker);
  return worker;
}

beforeEach(() => {
  workers = [];
  globalThis.Worker = function Worker() {};
  createPerformanceObservationsWorker.mockImplementation(fakeWorker);
  buildPerformanceObservations.mockReturnValue({ rows: ['main-thread'], observations: [] });
});
afterEach(() => { delete globalThis.Worker; });

test('computes off the main thread, then reuses the result for the same history and scope', async () => {
  const history = [{ id: 1 }];
  const view = renderHook(({ hand }) => usePerformanceObservations(history, grips, hand),
    { initialProps: { hand: 'pooled' } });
  expect(view.result.current).toEqual({ loading: true, result: null });
  await waitFor(() => expect(workers).toHaveLength(1));
  expect(workers[0].postMessage).toHaveBeenCalledWith({ history, grips, hand: 'pooled' });
  const result = { rows: ['pooled'], observations: [] };
  act(() => workers[0].onmessage({ data: { result } }));
  expect(view.result.current).toEqual({ loading: false, result });
  expect(workers[0].terminate).toHaveBeenCalled();
  expect(buildPerformanceObservations).not.toHaveBeenCalled();

  view.rerender({ hand: 'L' });
  expect(view.result.current.loading).toBe(true);
  await waitFor(() => expect(workers).toHaveLength(2));
  act(() => workers[1].onmessage({ data: { result: { rows: ['L'], observations: [] } } }));
  view.rerender({ hand: 'pooled' });
  expect(view.result.current).toEqual({ loading: false, result });
  expect(workers).toHaveLength(2);
});

test('a failed worker falls back to the main thread', async () => {
  const history = [{ id: 2 }];
  const view = renderHook(() => usePerformanceObservations(history, grips, 'pooled'));
  await waitFor(() => expect(workers).toHaveLength(1));
  act(() => workers[0].onerror());
  expect(view.result.current).toEqual({ loading: false, result: { rows: ['main-thread'], observations: [] } });
});

test('without Worker support it computes synchronously', () => {
  delete globalThis.Worker;
  const history = [{ id: 3 }];
  const view = renderHook(() => usePerformanceObservations(history, grips, 'pooled'));
  expect(view.result.current).toEqual({ loading: false, result: { rows: ['main-thread'], observations: [] } });
  expect(createPerformanceObservationsWorker).not.toHaveBeenCalled();
});

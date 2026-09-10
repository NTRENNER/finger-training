const mockOrder = jest.fn();
jest.mock('../supabase.js', () => ({supabase: {from: () => ({select: () => ({order: (...args) => mockOrder(...args)})})}}));
import { repPayload, fetchReps } from '../sync.js';
import { freshFitReps } from '../../model/load.js';

test('cloud round-trip retains interrupted activity and excludes it from fitting', async () => {
  const rep = {id: 'rep', date: '2026-09-10', grip: 'Micro', hand: 'L', rep_num: 1, set_num: 1,
    actual_time_s: 12, avg_force_kg: 17.5, failure_valid: false, end_reason: 'interrupted',
    force_recording: {version: 1, method: 'time_weighted', duration_s: 12}};
  const payload = repPayload(rep, 'user');
  mockOrder.mockResolvedValue({data: [payload], error: null});
  const [restored] = await fetchReps();
  expect(restored).toMatchObject(rep);
  expect(freshFitReps([restored])).toEqual([]);
});
test('cloud round-trip leaves historical validity unspecified', async () => {
  mockOrder.mockResolvedValue({data: [{actual_time_s: 30, avg_force_kg: 20}], error: null});
  const [restored] = await fetchReps();
  expect(restored.failure_valid).toBeNull();
  expect(restored.force_recording).toBeNull();
});

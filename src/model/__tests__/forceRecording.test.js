import { recordForce, isValidFailureRep } from '../forceRecording.js';
import { freshFitReps, effectiveLoad } from '../load.js';
import { prescription, demonstratedCapacityKg } from '../prescription.js';
import { computeDensityLadder } from '../densityLadder.js';
import { computePersonalRecoveryTausForGrip } from '../recoveryFit.js';

const trace = (seconds, force) => Array.from({ length: seconds * 100 + 1 }, (_, i) => ({ ts: i * 10, kg: force(i / 100) }));
test('steady pull pairs its measured average with exactly the observed duration', () => {
  const result = recordForce(trace(30, () => 20));
  expect(result).toMatchObject({ actualTime: 30, avgForce: 20, failureValid: true });
});
test('normal fluctuations contribute symmetrically', () => {
  const result = recordForce(trace(30, t => 20 + Math.sin(t * Math.PI * 2)));
  expect(result.avgForce).toBeCloseTo(20, 5);
  expect(result.failureValid).toBe(true);
});
test('strong opening followed by a long weaker pull is not recorded as sustained peak', () => {
  const result = recordForce(trace(30, t => t < 5 ? 30 : 15));
  expect(result.avgForce).toBeCloseTo(17.5, 5);
  expect(result.actualTime).toBe(30);
  expect(result.peakForce).toBe(30);
});
test('gradual decline contributes across the complete interval', () => {
  const result = recordForce(trace(30, t => 30 - t / 2));
  expect(result.avgForce).toBeCloseTo(22.5, 2);
  expect(result.actualTime).toBe(30);
});
test('abrupt release excludes confirmation delay and zero-force tail', () => {
  const result = recordForce(trace(31, t => t < 30 ? 20 : 0), 30000);
  expect(result).toMatchObject({ actualTime: 30, avgForce: 20, failureValid: true });
});
test('unequal sampling intervals are time weighted', () => {
  expect(recordForce([{ts: 0, kg: 30}, {ts: 100, kg: 10}, {ts: 1000, kg: 0}]).avgForce).toBe(12);
});
test('equipment gaps preserve observed work but cannot become valid failure data', () => {
  const result = recordForce([{ts: 0, kg: 20}, {ts: 100, kg: 20}, {ts: 5000, kg: 0}]);
  expect(result.failureValid).toBe(false);
  expect(result.forceRecording.observed_time_s).toBe(0.1);
});
test('empty and duplicate sample streams are not valid failure data', () => {
  expect(recordForce([]).failureValid).toBe(false);
  expect(recordForce([{ts: 0, kg: 20}, {ts: 0, kg: 20}]).failureValid).toBe(false);
});
const rep = { id: 'r', session_id: 's', date: '2026-09-09', grip: 'Crusher', hand: 'L',
  actual_time_s: 40, target_duration: 40, avg_force_kg: 20, peak_force_kg: 21,
  rep_num: 1, set_num: 1, rest_s: 20, failure_valid: false };
test('interrupted activity retains its load but cannot fit, anchor, or advance', () => {
  expect(effectiveLoad(rep)).toBe(20);
  expect(freshFitReps([rep])).toEqual([]);
  expect(demonstratedCapacityKg([rep], 'L', 'Crusher', 40)).toBeNull();
  expect(prescription([rep], 'L', 'Crusher', 40)).toEqual(prescription([], 'L', 'Crusher', 40));
  const reps = [40, 24, 16, 12].map((t, i) => ({...rep, actual_time_s: t, rep_num: i + 1, failure_valid: i !== 2}));
  expect(computeDensityLadder(reps, 'Crusher', 'power')).toBeNull();
  expect(computePersonalRecoveryTausForGrip(reps, 'Crusher')).toBeNull();
});
test('legacy failure records retain their existing eligibility', () => {
  expect(isValidFailureRep({ ...rep, failure_valid: undefined })).toBe(true);
});

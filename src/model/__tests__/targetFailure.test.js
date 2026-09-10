import { createTargetFailureDetector } from '../targetFailure.js';
import { recordForce, isCapacityEvidenceRep } from '../forceRecording.js';
import { freshFitReps } from '../load.js';
import { demonstratedCapacityKg } from '../prescription.js';

const trace = (seconds, fn) => Array.from({length: seconds * 100 + 1}, (_, i) => ({ts:i*10, kg:fn(i/100)}));
function end(samples, target = 25) {
  const detector = createTargetFailureDetector(target);
  for (const sample of samples) { const result = detector(sample); if (result) return result; }
  return null;
}
test('initial ramp and overshooting do not end a rep', () => {
  const samples = trace(30, t => t < .3 ? 5 + t * 100 : 30 + Math.sin(t));
  expect(end(samples)).toBeNull();
  expect(recordForce(samples, 30000, 25).forceRecording.capacity_eligible).toBe(true);
});
test('the first drop below target ends the rep without a lower allowance', () => {
  const result = end(trace(10, t => t < 5 ? 55 : 54.9), 55);
  expect(result).toEqual({endTs:5000, targetAcquired:true});
});
test('an attempt never reaching target does not arm failure detection', () => {
  expect(end(trace(5, () => 15))).toBeNull();
  expect(recordForce(trace(5, () => 15), 5000, 25).forceRecording.capacity_eligible).toBe(false);
});
test('sustained and varying overshoot remain usable at their measured force', () => {
  for (const samples of [trace(30, () => 35), trace(30, t => t < 5 ? 45 : 26)]) {
    const result = recordForce(samples, 30000, 25);
    const rep = {failure_valid:true, force_recording:result.forceRecording,
      avg_force_kg:result.avgForce, load_provenance:'measured_force'};
    expect(isCapacityEvidenceRep(rep)).toBe(true);
    expect(result.avgForce).toBeGreaterThan(25);
  }
});
test('30 kg for 10 seconds then 10 kg for 50 preserves activity and its own strong-phase time', () => {
  const result = recordForce(trace(60, t => t < 10 ? 30 : 10));
  expect(result.avgForce).toBeCloseTo(13.3333, 3);
  expect(result.forceRecording.plateau).toMatchObject({avg_force_kg:30, duration_s:10});
  const rep = {date:'2026-09-10', hand:'L', grip:'Crusher', rep_num:1,
    actual_time_s:result.actualTime, avg_force_kg:result.avgForce, peak_force_kg:30,
    failure_valid:true, force_recording:result.forceRecording, load_provenance:'measured_force'};
  expect(isCapacityEvidenceRep(rep)).toBe(true);
  expect(freshFitReps([rep])).toHaveLength(1);
  expect(demonstratedCapacityKg([rep], 'L','Crusher',60)).not.toBeNull();
});

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
test('a confirmed drop below the tolerance ends at its onset', () => {
  const result = end(trace(10, t => t < 5 ? 55 : 51), 55);
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


test('a brief dip after overshooting does not finish the rep', () => {
  expect(end(trace(10, t => t < 2 ? 35 : t < 2.2 ? 22 : 25))).toBeNull();
});
test('separate brief dips do not accumulate confirmation time', () => {
  expect(end(trace(10, t => Math.round(t * 100) % 40 < 20 ? 27 : 22))).toBeNull();
});
test('confirmation requires 2000 ms and recovery exactly to the tolerance resets it', () => {
  const detector = createTargetFailureDetector(25);
  for (const sample of [{ts:0,kg:30},{ts:100,kg:22},{ts:2099,kg:22},{ts:2100,kg:23.25},
    {ts:2200,kg:22},{ts:4199,kg:22}]) expect(detector(sample)).toBeNull();
  expect(detector({ts:4200,kg:22})).toEqual({endTs:2200,targetAcquired:true});
});
test('abrupt release is confirmed and duration excludes the delay', () => {
  const samples = trace(7, t => t < 5 ? 30 : 0);
  const result = end(samples);
  expect(result.endTs).toBe(5000);
  expect(recordForce(samples, result.endTs, 25)).toMatchObject({actualTime:5,avgForce:30});
});


test('sustained force within the 7 percent tolerance does not end the rep', () => {
  expect(end(trace(10, t => t < 1 ? 55 : 52), 55)).toBeNull();
});
test('the tolerance band does not arm a rep that never reaches its target', () => {
  expect(end(trace(10, t => t < 1 ? 24 : 22))).toBeNull();
});

test('one pound minimum allowance protects a 10 lb target from sustained sub-pound fluctuations', () => {
  const lb = 0.45359237;
  expect(end(trace(8, t => t < 1 ? 10 * lb : 9.2 * lb), 10 * lb)).toBeNull();
  expect(end(trace(8, t => t < 3 ? 10 * lb : 8.9 * lb), 10 * lb))
    .toEqual({ endTs: 3000, targetAcquired: true });
});
test('very light targets never allow more than a 20 percent loss', () => {
  expect(end(trace(8, t => t < 1 ? 1 : 0.81), 1)).toBeNull();
  expect(end(trace(8, t => t < 3 ? 1 : 0.79), 1))
    .toEqual({ endTs: 3000, targetAcquired: true });
});
test('low-load recovery resets confirmation and separate dips cannot accumulate', () => {
  const detector = createTargetFailureDetector(2);
  for (const sample of [{ ts: 0, kg: 2 }, { ts: 100, kg: 1.5 },
    { ts: 2099, kg: 1.5 }, { ts: 2100, kg: 1.6 }, { ts: 2200, kg: 1.5 },
    { ts: 4199, kg: 1.5 }]) expect(detector(sample)).toBeNull();
  expect(detector({ ts: 4200, kg: 1.5 })).toEqual({ endTs: 2200, targetAcquired: true });
});
test('minimum allowance never arms a low-load rep before target acquisition', () => {
  expect(end(trace(8, t => t < 3 ? 1.9 : 1), 2)).toBeNull();
});
test.each([null, 0, -1, NaN, Infinity])('invalid target %s cannot create a failure', target => {
  expect(end(trace(3, t => t < 1 ? 20 : 0), target)).toBeNull();
});

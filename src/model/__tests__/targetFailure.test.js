import { createTargetFailureDetector, repDetectionThresholds } from '../targetFailure.js';
import { recordCapacityForce } from '../forceRecording.js';
const lb = .45359237;
const trace = (seconds, fn, step = 10) => Array.from({length: seconds * 1000 / step + 1}, (_, i) => ({ts:i*step, kg:fn(i*step/1000), at:100000+i*step}));
function run(samples, target) {
  const detector = createTargetFailureDetector(target);
  let result;
  for (const sample of samples) result = detector(sample);
  return { detector, result };
}
test('14 lb target accepts a steady 13.5 lb hold without an exact-target spike', () => {
  const { detector, result } = run(trace(10, () => 13.5 * lb), 14 * lb);
  expect(result).toBeNull();
  expect(detector.snapshot().startTs).toBe(0);
  expect(detector.finish(10000)).toMatchObject({endTs:10000,targetAcquired:true,reason:'release'});
});
test('14 lb target settling at 12.5 confirms a loss at its smoothed onset', () => {
  const { result } = run(trace(12, t => (t < 5 ? 13.5 : 12.5) * lb), 14 * lb);
  expect(result).toMatchObject({targetAcquired:true,reason:'sustained_force_loss'});
  expect(result.endTs).toBeGreaterThanOrEqual(5000);
  expect(result.endTs).toBeLessThanOrEqual(5300);
});
test.each([1, 1.5, 2])('%s second partial adjustment and a steady return preserve the rep', dip => {
  const { detector, result } = run(trace(15, t => (t >= 5 && t < 5 + dip ? 80 : 100) * lb), 100 * lb);
  expect(result).toBeNull();
  expect(detector.snapshot().excursions).toHaveLength(1);
  expect(detector.finish(15000).endTs).toBe(15000);
});
test('gradual decline is detected using recent force despite a long strong opening', () => {
  const { result } = run(trace(75, t => Math.max(80, 100 - Math.max(0, t - 60) * 2) * lb), 100 * lb);
  expect(result.endTs).toBeGreaterThan(63000);
  expect(result.endTs).toBeLessThan(64000);
});
test('100 ms spikes cannot repeatedly reset a sustained loss', () => {
  const { result } = run(trace(20, t => t < 5 ? 20 : Math.round(t*1000) % 1000 < 100 ? 18.7 : 18), 20);
  expect(result.endTs).toBeGreaterThanOrEqual(5000);
  expect(result.endTs).toBeLessThan(5400);
});
test('a return shorter than the recovery window does not clear a loss', () => {
  const { detector, result } = run(trace(12, t => t < 5 || (t >= 7 && t < 7.4) ? 25 : 20), 25);
  expect(result.endTs).toBeLessThan(5300);
  expect(detector.snapshot().excursions).toHaveLength(0);
});
test('separate fully recovered dips do not accumulate to a failure', () => {
  const { detector, result } = run(trace(20, t => t < 3 || t % 5 >= 2 ? 25 : 20), 25);
  expect(result).toBeNull();
  expect(detector.snapshot().excursions.length).toBeGreaterThan(1);
});
test('short initial spikes do not acquire a working hold', () => {
  const { detector, result } = run(trace(8, t => t < .1 ? 25 : 15), 25);
  expect(result).toBeNull();
  expect(detector.finish(8000).targetAcquired).toBe(false);
});
test('confirmation takes four seconds from loss, not from acquisition', () => {
  const samples = trace(15, t => t < 5 ? 25 : 20);
  const detector = createTargetFailureDetector(25);
  let first;
  for (const sample of samples) if (detector(sample)) { first = sample; break; }
  const result = detector(first);
  expect(first.ts - result.endTs).toBe(4000);
});
test('release stops at physical release, excluding its confirmation delay', () => {
  const samples = trace(6, t => t < 5 ? 25 : 0);
  const { detector } = run(samples, 25);
  const decision = {...detector.finish(5000),activityEndTs:5000,stopReason:'release',summary:detector.snapshot()};
  expect(decision).toMatchObject({endTs:5000,reason:'release'});
  expect(recordCapacityForce(samples, decision.endTs, 25, decision)).toMatchObject({actualTime:5,avgForce:25,
    forceRecording:{failure_policy:{version:8},recording_stop_reason:'release',capacity_end_reason:'release'}});
});
test('sag tail is physical activity but not credited hold time or rest', () => {
  const samples = trace(12, t => t < 5 ? 25 : t < 11 ? 20 : 0);
  const { detector } = run(samples, 25);
  const decision = {...detector.finish(11000),activityEndTs:11000,stopReason:'release',summary:detector.snapshot()};
  const stats = recordCapacityForce(samples, decision.endTs, 25, decision);
  expect(stats.actualTime).toBeLessThan(5.3);
  expect(stats.forceRecording.activity).toMatchObject({duration_s:11,ended_at_ms:111000,impulse_kg_s:245});
  expect(stats.endedAtMs).toBeLessThan(105300);
});
test('recovered dips retain elapsed credit and measured force, without claiming all time was in band', () => {
  const samples = trace(12, t => t >= 5 && t < 7 ? 20 : 25);
  const { detector } = run(samples, 25);
  const decision = {...detector.finish(12000),activityEndTs:12000,stopReason:'release',summary:detector.snapshot()};
  const stats = recordCapacityForce(samples, 12000, 25, decision);
  expect(stats.actualTime).toBe(12);
  expect(stats.avgForce).toBeCloseTo(290/12);
  expect(stats.forceRecording.target_band_time_s).toBe(10);
  expect(stats.forceRecording.target_band_fraction).toBeCloseTo(10/12);
});
test('substantial recovered unloading is preserved but excluded from continuous capacity', () => {
  const samples = trace(12, t => t >= 5 && t < 5.5 ? 0 : 25);
  const { detector } = run(samples, 25);
  const decision = {...detector.finish(12000),activityEndTs:12000,stopReason:'release'};
  expect(recordCapacityForce(samples,12000,25,decision).forceRecording)
    .toMatchObject({capacity_eligible:false,continuity:'intermittent',activity:{duration_s:12}});
});
test('light targets retain an absolute allowance bounded by 20 percent', () => {
  expect(run(trace(8, () => .81), 1).result).toBeNull();
  expect(run(trace(8, t => t < 2 ? 1 : .79), 1).result).not.toBeNull();
});
test.each([null, 0, -1, NaN, Infinity])('invalid target %s cannot create a failure', target => {
  expect(run(trace(8, t => t < 1 ? 20 : 0), target).result).toBeNull();
});
test('targeted release is near zero and untargeted warmups keep legacy thresholds', () => {
  expect(repDetectionThresholds(25)).toEqual({startKg:4,releaseKg:.5});
  expect(repDetectionThresholds(2.5)).toEqual({startKg:2,releaseKg:.25});
  expect(repDetectionThresholds(null)).toEqual({startKg:4,releaseKg:3});
});
test('audit runs cover acquisition through the last evaluated sample without gaps',()=>{
  const {detector}=run(trace(15,t=>t>=5&&t<7?20:25),25);
  const runs=detector.snapshot().runs;
  expect(runs[0].from_ms).toBe(0);
  expect(runs.at(-1).to_ms).toBe(15000);
  for(let i=1;i<runs.length;i++) expect(runs[i].from_ms).toBe(runs[i-1].to_ms);
});

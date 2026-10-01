import { measureSustainedMax, sustainedMaxKg, sustainedMaxRecords } from '../sustainedMax.js';
import { recordForce, recordCapacityForce, finalizeDeviceActivity } from '../forceRecording.js';
import { peakMeasurementRecord } from '../peakTest.js';
import { freshFitReps } from '../load.js';
import { recentBestPeakKg, historicalBestPeakKg, bestAvailablePeakMeasurement } from '../prescription.js';

const trace = (seconds, fn, offset = 0) => Array.from({ length: Math.round(seconds * 100) + 1 }, (_, i) => ({ ts: offset + i * 10, kg: fn(i / 100) }));
const row = (kg, extra = {}) => ({ id: 'record', grip: 'Micro', hand: 'L', date: '2026-09-29',
  session_id: 'later', session_started_at: '2026-09-29T18:00:00Z', actual_time_s: 10,
  rep_num: 4, set_num: 2, target_duration: 160, peak_force_kg: kg + 20, avg_force_kg: kg,
  force_recording: { version: 4, sustained_max: measureSustainedMax(trace(3, () => kg)) }, ...extra });
const earlier = { ...row(20), id: 'earlier', session_id: 'earlier', session_started_at: '2026-09-29T08:00:00Z',
  rep_num: 1, set_num: 1, target_duration: 30, force_recording: { version: 4 } };
const legacy = { id: 'legacy', grip: 'Micro', hand: 'L', date: '2026-09-28', actual_time_s: 3,
  target_duration: 3, rep_num: 1, set_num: 1, peak_force_kg: 30, avg_force_kg: 25 };

test('requires a full two seconds and separates a brief spike from sustained force', () => {
  expect(measureSustainedMax(trace(1.99, () => 50))).toBeNull();
  expect(measureSustainedMax(trace(2, () => 50)).avg_force_kg).toBeCloseTo(50);
  const stats = recordForce(trace(5, t => t === 2 ? 100 : 20));
  expect(stats.peakForce).toBe(100);
  expect(stats.forceRecording.sustained_max.avg_force_kg).toBeCloseTo(20.4);
});

test('finds the best window anywhere, with offsets independent of absolute timestamps', () => {
  const m = measureSustainedMax(trace(10, t => t >= 5 && t < 7 ? 40 : 10, 1234567890123));
  expect(m).toMatchObject({ avg_force_kg: 40, start_offset_s: 5, end_offset_s: 7 });
});

test('time weights irregular samples and clips the recording endpoint', () => {
  const samples = Array.from({ length: 31 }, (_, i) => ({ ts: i * 100, kg: i < 10 ? 10 : 30 }));
  samples.splice(1, 0, { ts: 1, kg: 10 }, { ts: 2, kg: 10 });
  expect(measureSustainedMax(samples, 2000).avg_force_kg).toBeCloseTo(20);
  expect(measureSustainedMax(samples, 2500).avg_force_kg).toBeCloseTo(25);
  expect(measureSustainedMax(samples, 9000).end_offset_s).toBe(3); // no extrapolated tail
});

test('never bridges gaps, corrupt values or reversed time; accepts an intact window before a later gap', () => {
  expect(measureSustainedMax([{ ts: 0, kg: 50 }, { ts: 2000, kg: 50 }])).toBeNull();
  for (const kg of [NaN, Infinity, 200, -1]) {
    const samples = trace(3, () => 30); samples[150].kg = kg;
    expect(measureSustainedMax(samples)).toBeNull();
  }
  const samples = trace(3, () => 30);
  expect(measureSustainedMax([...samples, { ts: 2999, kg: 50 }])).toBeNull();
  expect(measureSustainedMax([...samples, { ts: 3000, kg: 50 }])).toBeNull();
  expect(measureSustainedMax([...samples, { ts: 6000, kg: 50 }]).avg_force_kg).toBe(30);
});

test('matches an independent moving-window calculation across nonuniform signals', () => {
  let seed = 123;
  const rand = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed; };
  for (let trial = 0; trial < 20; trial++) {
    let ts = 0;
    const samples = Array.from({ length: 80 }, () => { ts += 10 + rand() % 100; return { ts, kg: 5 + rand() % 70 }; });
    const ends = samples.flatMap(s => [s.ts, s.ts + 2000]).filter(e => e >= samples[0].ts + 2000 && e <= samples.at(-1).ts);
    const expected = Math.max(...ends.map(end => samples.slice(0, -1).reduce((area, s, i) =>
      area + Math.max(0, Math.min(end, samples[i + 1].ts) - Math.max(end - 2000, s.ts)) * s.kg, 0) / 2000));
    expect(measureSustainedMax(samples).avg_force_kg).toBeCloseTo(expected, 8);
  }
});

test('record comes from activity, including a valid later window beyond the credited failure endpoint', () => {
  const stats = recordCapacityForce(trace(10, t => t < 5 ? 20 : 40), 4000, 20, {
    startTs: 1000, endTs: 4000, activityEndTs: 10000, reason: 'sustained_force_loss', stopReason: 'release',
  });
  expect(stats.actualTime).toBe(3);
  expect(stats.forceRecording.sustained_max).toMatchObject({ avg_force_kg: 40, start_offset_s: 5 });
  expect(stats.forceRecording.activity.duration_s).toBe(10);
  const interrupted = finalizeDeviceActivity(stats, 0, 10000, true);
  expect(interrupted.failureValid).toBe(false);
  expect(sustainedMaxKg({ force_recording: interrupted.forceRecording })).toBe(40);
});

test('a timed peak test preserves both measures without becoming a failure observation', () => {
  const stats = recordForce(trace(3, t => t === 1 ? 80 : 40));
  const r = peakMeasurementRecord({ stats, hand: 'L', round: 0, grip: 'Micro', sessionId: 'peak', date: '2026-09-29', firstHand: 'L' });
  expect(r.peak_force_kg).toBe(80);
  expect(sustainedMaxKg(r)).toBeCloseTo(40.2);
  expect(freshFitReps([r])).toEqual([]);
  expect(bestAvailablePeakMeasurement([r], 'L', 'Micro', '2026-09-30'))
    .toMatchObject({ instantaneousKg: 80, sustainedKg: 40.2, capKg: 76, capBasis: 'instantaneous_peak' });
});

test('later sets and fatigued Chaos holds raise observed records but stay out of the fresh curve', () => {
  const later = row(40, { force_recording: { ...row(40).force_recording, capacity_eligible: false,
    session_protocol: { id: 'whole_curve', role: 'fatigued_hold' } } });
  const history = [earlier, later, row(35), row(60, { hand: 'R' }), row(90, { grip: 'Crusher' })];
  expect(sustainedMaxRecords(history).find(r => r.hand === 'L' && r.grip === 'Micro').kg).toBe(40);
  expect(freshFitReps(history).map(r => r.id)).not.toContain('record');
  expect(recentBestPeakKg([legacy, ...history], 'L', 'Micro', '2026-09-30')).toBe(40);
});

test('new ordinary evidence only raises established caps and never leaks across date, grip or hand', () => {
  expect(recentBestPeakKg([legacy, row(20)], 'L', 'Micro', '2026-09-30')).toBe(30);
  expect(recentBestPeakKg([row(20)], 'L', 'Micro', '2026-09-30')).toBeNull();
  expect(recentBestPeakKg([legacy, row(40)], 'L', 'Micro', '2026-09-29')).toBe(30);
  expect(recentBestPeakKg([legacy, row(40, { hand: 'R' })], 'L', 'Micro', '2026-09-30')).toBe(30);
  expect(recentBestPeakKg([legacy, row(40, { grip: 'Crusher' })], 'L', 'Micro', '2026-09-30')).toBe(30);
  expect(historicalBestPeakKg([legacy, row(40)], 'L', 'Micro', '2026-09-30')).toBe(40);
});

test('low recent ordinary work cannot replace an older strong peak; exceeding it refreshes the bound', () => {
  const old = { ...legacy, date: '2026-01-01' };
  expect(bestAvailablePeakMeasurement([old, row(20)], 'L', 'Micro', '2026-09-30')).toMatchObject({ kg: 30, stale: true });
  expect(bestAvailablePeakMeasurement([old, row(40)], 'L', 'Micro', '2026-09-30')).toMatchObject({ kg: 40, stale: false });
});

test('no fabricated legacy windows, and a new short spike cannot fall back to instantaneous peak', () => {
  expect(sustainedMaxKg(legacy)).toBeNull();
  expect(sustainedMaxKg({ ...row(40), force_recording: { sustained_max: { avg_force_kg: 40, window_ms: 2000 } } })).toBeNull();
  const short = row(70, { target_duration: 3, force_recording: { version: 4, sustained_max: null } });
  expect(recentBestPeakKg([legacy, short], 'L', 'Micro', '2026-09-30')).toBe(30);
});

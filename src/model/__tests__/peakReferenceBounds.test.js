import { bestAvailablePeakMeasurement, loadBounds, prescription, buildFreshLoadMap } from '../prescription.js';
import { recordForce } from '../forceRecording.js';
import { peakMeasurementRecord } from '../peakTest.js';
import { measureSustainedMax, sustainedMaxKg, sustainedMaxRecords } from '../sustainedMax.js';
import { freshFitReps } from '../load.js';
import { buildThreeExpPriors } from '../threeExp.js';
import { computeDensityLadder } from '../densityLadder.js';
import { coachingRecommendationContinuous } from '../coaching.js';

const REF = '2026-09-30';
const trace = (kg = 56) => Array.from({ length: 301 }, (_, i) => ({ ts: i * 10, kg }));
const windowAt = kg => measureSustainedMax(trace(kg));
const peak = (metadata = {}) => ({ id: 'peak', date: '2026-09-29', grip: 'Micro', hand: 'L',
  session_id: 'peak', target_duration: 3, actual_time_s: 3, set_num: 1, rep_num: 1,
  avg_force_kg: 56, peak_force_kg: 62, failure_valid: false, end_reason: 'peak_test_complete',
  force_recording: { version: 4, signal_quality: 'complete', peak_valid: true,
    capacity_eligible: false, session_protocol: { id: 'peak_test', version: 2 }, ...metadata } });
const read = h => bestAvailablePeakMeasurement(h, 'L', 'Micro', REF);
const bounds = h => loadBounds(h, 'L', 'Micro', 5, { referenceDate: REF });
const seed = [30,70,115,160,220].map((t, i) => ({ id: `seed-${i}`, session_id: `seed-${i}`,
  date: `2026-09-${20+i}`, grip: 'Micro', hand: 'L', set_num: 1, rep_num: 1,
  target_duration: t, actual_time_s: t, avg_force_kg: 80 - i * 10, peak_force_kg: 85 - i * 10,
  failure_valid: true, force_recording: { version: 3, capacity_eligible: true } }));

test.each([
  ['verified window', { sustained_max: windowAt(56) }],
  ['unavailable window', { sustained_max: null }],
  ['legacy recording', {}],
  ['unrecognized window version', { sustained_max: { ...windowAt(56), version: 2 } }],
])('%s preserves the independently valid instantaneous safeguard', (_, metadata) => {
  const r = peak(metadata);
  expect(read([r])).toMatchObject({ instantaneousKg: 62, capKg: 58.9, capBasis: 'instantaneous_peak', stale: false });
  expect(bounds([r]).capValue(80)).toBe(58.9);
  const result = prescription([...seed, r], 'L', 'Micro', 5, { referenceDate: REF });
  expect(result.peakCapKg).toBe(58.9);
  expect(result.value).toBeLessThanOrEqual(58.9);
});

test('a real trace may pass whole-rep validity yet have no uninterrupted two-second window', () => {
  const samples = trace().filter(s => !(s.ts > 800 && s.ts < 1200) && !(s.ts > 1800 && s.ts < 2200));
  samples[10].kg = 62;
  const stats = recordForce(samples);
  expect(stats.failureValid).toBe(true);
  expect(stats.forceRecording.sustained_max).toBeNull();
  const r = peakMeasurementRecord({ stats, hand: 'L', round: 0, grip: 'Micro',
    sessionId: 'real-trace', date: '2026-09-29', firstHand: 'L' });
  expect(read([r])).toMatchObject({ instantaneousKg: 62, sustainedKg: null, capKg: 58.9 });
  expect(sustainedMaxRecords([r])).toEqual([]);
});

test('two-second evidence is never multiplied by the instantaneous 0.95 allowance', () => {
  const r = peak({ sustained_max: windowAt(60) });
  expect(read([r])).toMatchObject({ instantaneousKg: 62, sustainedKg: 60, capKg: 60, capBasis: 'two_second_average' });
  expect(bounds([r]).capValue(90)).toBe(60);
  expect(sustainedMaxKg(r)).toBe(60);
});

test.each(['interrupted', 'equipment_interruption', 'target_not_reached'])('rejects %s instantaneous evidence without fabricating a record', end_reason => {
  const r = { ...peak({ sustained_max: null }), end_reason };
  expect(read([r])).toBeNull();
  expect(read([peak(), r]).capKg).toBe(58.9);
});

test('rejects incomplete signal even when a saved peak-valid flag claims otherwise', () => {
  expect(read([peak({ signal_quality: 'incomplete', sustained_max: null })])).toBeNull();
  expect(read([peak({ activity: { signal_quality: 'incomplete' }, sustained_max: null })])).toBeNull();
  // A measured intact window is independent of a later interruption.
  const r = { ...peak({ signal_quality: 'incomplete', sustained_max: windowAt(60) }), end_reason: 'equipment_interruption' };
  expect(read([r])).toMatchObject({ instantaneousKg: null, sustainedKg: 60, capKg: 60, capBasis: 'two_second_average' });
  expect(freshFitReps([r])).toEqual([]);
});

test.each([null, '2026-09-29T08:00:00Z'])('ambiguous session order %s preserves a valid legacy max without admitting fresh failures', session_started_at => {
  const a = { ...seed[0], id: 'a', session_id: 'a', date: '2026-09-29', target_duration: 7,
    actual_time_s: 7, avg_force_kg: 55, peak_force_kg: 62, session_started_at };
  const b = { ...a, id: 'b', session_id: 'b', session_started_at: '2026-09-29T08:00:00Z', peak_force_kg: 60 };
  expect(freshFitReps([a, b])).toEqual([]);
  for (const history of [[a,b],[b,a]]) {
    expect(read(history)).toMatchObject({ instantaneousKg: 62, capKg: 58.9 });
    expect(bounds(history).peakCapKg).toBe(58.9);
    expect(prescription([...seed, ...history], 'L', 'Micro', 5, { referenceDate: REF }).peakCapKg).toBe(58.9);
  }
});

test('later session/set/Chaos records reach the actual ceiling but not its fit or earned ladder', () => {
  const first = { ...seed[0], id: 'first', session_id: 'first', date: '2026-09-29',
    session_started_at: '2026-09-29T08:00:00Z' };
  const base = [...seed, peak(), first];
  const later = { ...first, id: 'later', session_id: 'later', session_started_at: '2026-09-29T18:00:00Z',
    set_num: 2, rep_num: 4, target_duration: 160, actual_time_s: 20, avg_force_kg: 10,
    force_recording: { version: 4, capacity_eligible: false, sustained_max: windowAt(70),
      session_protocol: { id: 'mixed_domain', role: 'fatigued_hold', position: 4 } } };
  const history = [...base, later];
  expect(bounds(history).peakCapKg).toBe(70);
  const opts = { referenceDate: REF, captureCurve: true, threeExpPriors: buildThreeExpPriors(base), freshMap: buildFreshLoadMap(base) };
  const before = prescription(base, 'L', 'Micro', 5, opts);
  const after = prescription(history, 'L', 'Micro', 5, opts);
  expect(before.peakCapKg).toBe(58.9);
  expect(after.peakCapKg).toBe(70);
  expect(after.peakCapBasis).toBe('two_second_average');
  expect(after.value).toBeGreaterThan(before.value);
  expect(after.curveSnapshot).toEqual(before.curveSnapshot);
  expect(after.anchor).toEqual(before.anchor);
  expect(freshFitReps(history)).toEqual(freshFitReps(base));
  const ladderBefore = computeDensityLadder(base, 'Micro', 'power');
  const ladderAfter = computeDensityLadder(history, 'Micro', 'power');
  expect(ladderAfter).toMatchObject({ reps: ladderBefore.reps, decision: ladderBefore.decision,
    T: ladderBefore.T, previousLoadByHand: ladderBefore.previousLoadByHand });
  // The same earned load is allowed more headroom when the peak bound rises.
  expect(ladderAfter.loadByHand.L).toBe(70);
  expect(ladderBefore.loadByHand.L).toBe(58.9);
  const rec = coachingRecommendationContinuous(history, 'Micro', { today: REF, hand: 'L' });
  expect(rec.loadKg).toBeLessThanOrEqual(70);
});

test('separate references preserve stale and retrospective behavior, hand/grip scope and submax-only uncertainty', () => {
  const old = { ...peak(), date: '2026-01-01' };
  const low = { ...seed[0], force_recording: { version: 4, sustained_max: windowAt(20) } };
  expect(read([old, low])).toMatchObject({ kg: 62, capKg: 58.9, stale: true });
  expect(read([low])).toBeNull();
  expect(read([{ ...peak(), date: REF }])).toBeNull();
  expect(read([{ ...peak(), hand: 'R' }, { ...peak(), grip: 'Crusher' }])).toBeNull();
});

import { buildPerformanceTrends } from '../performanceTrends.js';
import { fitContextualTrend } from '../contextualTrendFit.js';
import { predForceThreeExp } from '../threeExp.js';
import {
  buildPerformanceTrendAnalysis, performanceDurationBand,
  PERFORMANCE_REFERENCE_DURATIONS, PERFORMANCE_EVIDENCE_POLICY,
} from '../performanceTrendEvidence.js';

const date = index => new Date(Date.UTC(2026, 0, 1 + index * 3)).toISOString().slice(0, 10);
const next = value => new Date(Date.parse(value) + 86400000).toISOString().slice(0, 10);
const row = (index, hand = 'L', { duration = [5, 30, 70, 115, 160, 220][index % 6],
  factor = 1, grip = 'Crusher', hour = '08', session = `session-${index}`, ...rest } = {}) => ({
  id: `${session}-${hand}`, session_id: session, date: date(index),
  session_started_at: `${date(index)}T${hour}:00:00Z`,
  grip, hand, rep_num: 1, set_num: 1, target_duration: duration, actual_time_s: duration,
  avg_force_kg: predForceThreeExp([20, 25, 30], duration) * factor * (hand === 'R' ? 0.9 : 1),
  peak_force_kg: 95, load_provenance: 'measured_force', failure_valid: true,
  force_recording: { version: 2, signal_quality: 'complete', capacity_eligible: true },
  ...rest,
});
const history = (count = 18) => Array.from({ length: count }, (_, index) => ['L', 'R'].map(hand =>
  row(index, hand, { factor: index < 8 ? 1 : index < 12 ? 1.25 : 0.8 }),
)).flat();
const withoutEvidence = rows => rows.map(item => Object.fromEntries(
  Object.entries(item).filter(([key]) => !key.endsWith('_evidence')),
));

test.each(['original', 'contextOnly', 'contextRobust'])(
  '%s evidence preserves existing percentages and exactly reconstructs short-term hand/day aggregation', model => {
    const records = history();
    for (const hand of ['L', 'R', 'pooled']) {
      const analysis = buildPerformanceTrendAnalysis(records, ['Crusher'], hand, { model });
      expect(withoutEvidence(analysis.rows)).toEqual(buildPerformanceTrends(records, ['Crusher'], hand, { model }));
      for (const point of analysis.rows.filter(item => Number.isFinite(item.Crusher_short))) {
        const selected = analysis.observations.filter(item => item.date === point.date);
        const hands = [...new Set(selected.map(item => item.hand))];
        const means = hands.map(side => {
          const values = selected.filter(item => item.hand === side).map(item => item.deviation);
          return values.reduce((a, b) => a + b, 0) / values.length;
        });
        expect(means.reduce((a, b) => a + b, 0) / means.length).toBe(point.Crusher_short);
      }
    }
  },
);

test('baseline, causal peak ratios and per-duration forces use the same equally weighted hand curves', () => {
  const records = history();
  const result = buildPerformanceTrendAnalysis(records, ['Crusher']);
  const first = result.rows[0].Crusher_evidence;
  let peak = first;
  for (const point of result.rows) {
    const evidence = point.Crusher_evidence;
    if (evidence.score > peak.score) peak = evidence;
    expect(evidence.baselineDate).toBe(first.date);
    expect(evidence.baselineScore).toBe(first.score);
    expect(100 * (evidence.score / first.score - 1)).toBeCloseTo(point.Crusher_long, 12);
    expect(evidence.peakDate).toBe(peak.date);
    expect(evidence.peakScore).toBe(peak.score);
    expect(evidence.changeFromPeak).toBeCloseTo(100 * (evidence.score / peak.score - 1), 12);
    expect(evidence.referenceForces.map(item => item.duration)).toEqual(PERFORMANCE_REFERENCE_DURATIONS);
    const fits = ['L', 'R'].map(hand => fitContextualTrend(records, hand, 'Crusher', next(point.date), { robust: false }));
    for (const value of evidence.referenceForces) {
      expect(value.force).toBeCloseTo(Math.sqrt(
        predForceThreeExp(fits[0].established, value.duration) * predForceThreeExp(fits[1].established, value.duration),
      ), 10);
      expect(value.baselineForce).toBe(first.referenceForces.find(item => item.duration === value.duration).force);
      expect(value.peakForce).toBe(peak.referenceForces.find(item => item.duration === value.duration).force);
    }
  }
  expect(result.rows.at(-1).Crusher_evidence.changeFromPeak).toBeLessThan(0);
  expect(result.rows.at(-1).Crusher_evidence.peakDate).not.toBe(result.rows.at(-1).date);
});

test('later evidence cannot rewrite an early reference, historical peak, recording mix or scored observations', () => {
  const records = history();
  const before = buildPerformanceTrendAnalysis(records, ['Crusher']);
  const extra = ['L', 'R'].map(hand => row(30, hand, { factor: 1.8,
    force_recording: { version: 5, signal_quality: 'complete', capacity_eligible: true, failure_policy: { version: 8 } } }));
  const after = buildPerformanceTrendAnalysis([...records, ...extra], ['Crusher']);
  expect(after.rows.filter(item => item.date < date(30))).toEqual(before.rows);
  expect(after.observations.filter(item => item.date < date(30))).toEqual(before.observations);
  expect(after.rows.at(-1).Crusher_evidence.baselineEvidence).toEqual(before.rows[0].Crusher_evidence.baselineEvidence);
  expect(after.rows.at(-1).Crusher_evidence.currentEvidence.recordingMethods).toHaveLength(2);
});

test('coverage counts independent dates per hand and keeps the unsupported starting reference provisional', () => {
  const early = Array.from({ length: 5 }, (_, index) => ['L', 'R'].map(hand => row(index, hand, { duration: 30 + index }))).flat();
  const sameDay = ['L', 'R'].flatMap(hand => Array.from({ length: 3 }, (_, index) => row(5, hand,
    { duration: 220, factor: 1 + index * 0.02, session: `long-${index}` })));
  const oneDay = buildPerformanceTrendAnalysis([...early, ...sameDay], ['Crusher']);
  const support = evidence => evidence.referenceSupport.find(item => item.duration === 220);
  const reference = oneDay.rows[0].Crusher_evidence.baselineEvidence;
  expect(reference.status).toBe('provisional');
  expect(reference.stability).toMatchObject({ status: 'insufficient', label: 'Insufficient for stability check' });
  expect(support(reference)).toMatchObject({ status: 'unobserved', dates: 0 });
  expect(support(oneDay.rows.at(-1).Crusher_evidence.currentEvidence)).toMatchObject({ status: 'sparse', dates: 1 });
  const leftOnly = buildPerformanceTrendAnalysis([...early, ...sameDay, row(6, 'L', { duration: 220 })], ['Crusher']);
  expect(support(leftOnly.rows.at(-1).Crusher_evidence.currentEvidence).status).toBe('sparse');
  const complete = buildPerformanceTrendAnalysis([...early, ...sameDay,
    row(6, 'L', { duration: 220 }), row(6, 'R', { duration: 220 })], ['Crusher']);
  expect(support(complete.rows.at(-1).Crusher_evidence.currentEvidence)).toMatchObject({ status: 'supported', dates: 2 });
  expect(complete.rows.at(-1).Crusher_evidence.baselineEvidence).toEqual(reference);
  expect(complete.rows.at(-1).Crusher_evidence.referenceForces.find(item => item.duration === 220))
    .toMatchObject({ baselineSupported: false, currentSupported: true });
  expect(PERFORMANCE_EVIDENCE_POLICY.minimumNearbyDates).toBe(2);
});

test('individual observations preserve eligibility, pre-day expectations, duration bands, hand and earlier-grip context', () => {
  const records = history(12);
  const earlier = row(12, 'L', { grip: 'Micro', duration: 70, session: 'earlier', rep_num: 3,
    failure_valid: false, force_recording: { capacity_eligible: false } });
  const scored = row(12, 'R', { duration: 121, target_duration: 30, session: 'scored', hour: '10' });
  const invalid = [
    row(12, 'L', { session: 'interrupted', failure_valid: false }),
    row(12, 'L', { session: 'later-rep', rep_num: 2 }),
    row(12, 'L', { session: 'later-set', set_num: 2 }),
    row(12, 'L', { session: 'manual', avg_force_kg: null, manual_load_kg: 20, load_provenance: 'manual_actual' }),
    row(12, 'L', { session: 'outside', duration: 300 }),
  ];
  const result = buildPerformanceTrendAnalysis([...records, earlier, scored, scored, ...invalid], ['Crusher']);
  const observations = result.observations.filter(item => item.date === date(12));
  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({ id: scored.id, hand: 'R', duration: 121,
    durationBand: 'long', context: 'after_training', earlierGrips: expect.arrayContaining(['Micro']) });
  const changed = buildPerformanceTrendAnalysis([...records, earlier, { ...scored, avg_force_kg: scored.avg_force_kg * 0.8 }], ['Crusher']);
  const changedObservation = changed.observations.find(item => item.id === scored.id);
  expect(changedObservation.expectedForce).toBe(observations[0].expectedForce);
  expect((1 + changedObservation.deviation / 100) / (1 + observations[0].deviation / 100)).toBeCloseTo(0.8, 12);
});

test('a transition incompatible with a native prior interval cannot create individual short-term points', () => {
  const records = Array.from({ length: 6 }, (_, index) => row(index, 'L', { duration: 40,
    force_recording: { version: 3, basis: 'target_acquired', acquisition_s: 0,
      capacity_eligible: true, signal_quality: 'complete' } }));
  const incompatible = row(6, 'L', { duration: 40 });
  const result = buildPerformanceTrendAnalysis([...records, incompatible], ['Crusher'], 'L');
  expect(result.observations.some(item => item.date === date(6))).toBe(false);
  expect(result.rows.at(-1).Crusher_short).toBeUndefined();
});

test.each([[0, null], [5, 'short'], [45, 'short'], [45.1, 'medium'], [120, 'medium'], [120.1, 'long'], [600, 'long']])(
  'actual duration %s seconds belongs to %s', (duration, band) => {
    expect(performanceDurationBand(duration)).toBe(band);
  },
);

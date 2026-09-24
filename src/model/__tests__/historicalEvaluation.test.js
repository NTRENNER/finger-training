import { evaluateRecordedPrescriptions } from '../historicalEvaluation.js';
import { evaluateForward } from '../forwardEvaluation.js';
import { recoveryRows } from '../../testHelpers/recoveryRows.js';

const set = (date = '2026-09-20', shape = 'measured') => recoveryRows(shape, { date, sessionId: date });

test('saved plan is read directly; later tired reps never count as target misses', () => {
  const rows = set().map(r => ({ ...r, prescribed_load_kg: 30, weight_kg: 60,
    target_duration: 40, actual_time_s: r.rep_num === 1 ? 44 : 1 }));
  const out = evaluateRecordedPrescriptions(rows);
  expect(out.all.matched).toMatchObject({ holds: 1, days: 1, within20Percent: 1, below80Percent: 0 });
  expect(out.observations[0].prescribedKg).toBe(30);
  expect(out.all.matched.meanPercentBeyondTarget).toBeCloseTo(10);
});

test('overshoots stay useful without pretending to be same-load time errors', () => {
  const rows = [
    { ...set('2026-09-18')[0], avg_force_kg: 40, actual_time_s: 35 },
    { ...set('2026-09-19')[0], avg_force_kg: 40, actual_time_s: 20 },
    { ...set()[0], avg_force_kg: 25, actual_time_s: 50 },
  ];
  expect(evaluateRecordedPrescriptions(rows).all).toMatchObject({ measuredOpeners: 3,
    matched: { holds: 0, meanPercentBeyondTarget: null }, higherForce: 2, higherForceAndAtLeastTargetTime: 1, lowerForce: 1 });
});

test('database target-force endings count, uncertain historical rows remain labelled', () => {
  const explicit = { ...set()[0], end_reason: 'target_force_failure' };
  const legacy = { ...set('2026-09-01', 'legacy')[0], prescribed_load_kg: null };
  const out = evaluateRecordedPrescriptions([explicit, legacy]);
  expect(out.all.matched.holds).toBe(2);
  expect(out.byEvidence.explicit_measured_failure.matched.holds).toBe(1);
  expect(out.byEvidence.legacy_or_uncertain.matched.holds).toBe(1);
  expect(out.byPrescriptionSource.legacy_weight_kg.matched.holds).toBe(1);
});

test('interruptions, manual entries, optional sets and short peak targets cannot skew the main score', () => {
  const short = { ...set()[0], target_duration: 3, actual_time_s: 4.1 };
  const optional = { ...set('2026-09-19')[0], set_num: 2 };
  const out = evaluateRecordedPrescriptions([...set('2026-09-18', 'interrupted'),
    ...set('2026-09-17', 'manual'), short, optional]);
  expect(out.all.matched.holds).toBe(0);
  expect(out.shortTargets.count).toBe(1);
});

test('durations remain as recorded for target attainment; no harmonization or rewrite', () => {
  const rows = [set('2026-09-01', 'legacy')[0], { ...set()[0], actual_time_s: 30,
    force_recording: { ...set()[0].force_recording, basis: 'target_acquired', acquisition_s: 2 } }];
  const before = JSON.stringify(rows);
  const out = evaluateRecordedPrescriptions(rows);
  expect(out.observations.at(-1).actualSeconds).toBe(30);
  expect(JSON.stringify(rows)).toBe(before);
  expect(evaluateRecordedPrescriptions([...rows, ...rows]).all).toEqual(out.all);
});

test('anchored candidate and capacity replay cannot see same-day or future outcomes', () => {
  const history = Array.from({ length: 7 }, (_, i) => set(`2026-08-0${i + 1}`, 'legacy')).flat();
  const a = evaluateForward(history);
  const b = evaluateForward([...history, ...set('2026-08-07').map(r => ({ ...r, id: `other-${r.id}`,
    session_id: 'other', avg_force_kg: 80, actual_time_s: 200 })), ...set('2026-09-20')]);
  const select = r => r.observations.force.filter(x => x.session !== 'other' && x.date <= '2026-08-07');
  expect(select(a)).toEqual(select(b));
  expect(a.force.capacityCurves.all.matched.candidateCapacity.currentCapacity.observations).toBe(2);
  expect(a.observations.force[0].predictions.freshAnchored).not.toBeNull();
});

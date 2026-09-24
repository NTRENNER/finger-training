import { evaluateForward, evaluationInterval, evaluationMetrics, prepareEvaluationRows } from '../forwardEvaluation.js';
import { recoveryRows, RECOVERY_ROW_SHAPES } from '../../testHelpers/recoveryRows.js';

const history = () => Array.from({ length: 7 }, (_, i) => recoveryRows('legacy', {
  sessionId: `day-${i}`, date: `2026-08-${String(i + 1).padStart(2, '0')}`,
})).flat();

test('future and same-day sessions cannot train earlier forecasts or any fitted dependency', () => {
  const base = history();
  const result = evaluateForward(base);
  expect(result.observations.force.length).toBe(2);
  expect(result.observations.recovery.length).toBe(6);
  const later = recoveryRows('measured', { sessionId: 'future', date: '2026-09-20' })
    .map(r => ({ ...r, avg_force_kg: 90, actual_time_s: 200 }));
  const sameDay = recoveryRows('measured', { sessionId: 'another', date: '2026-08-07' })
    .map(r => ({ ...r, avg_force_kg: 90, actual_time_s: 200 }));
  const expanded = evaluateForward([...base, ...later, ...sameDay]);
  for (const kind of ['force', 'recovery']) {
    expect(expanded.observations[kind].filter(r => r.session?.startsWith('day-')))
      .toEqual(result.observations[kind]);
  }
});

test('changing held-out later holds does not alter the predictions being scored', () => {
  const base = history();
  const a = evaluateForward(base).observations.recovery.filter(r => r.date === '2026-08-07');
  const b = evaluateForward(base.map(r => r.date === '2026-08-07' && r.rep_num > 1
    ? { ...r, actual_time_s: r.actual_time_s * 2 } : r)).observations.recovery.filter(r => r.date === '2026-08-07');
  expect(a.map(r => r.predictions)).toEqual(b.map(r => r.predictions));
  expect(a.map(r => r.actual)).not.toEqual(b.map(r => r.actual));
});

test.each(RECOVERY_ROW_SHAPES)('real storage shape %s receives explicit eligibility', shape => {
  const testRows = recoveryRows(shape, { sessionId: 'heldout', date: '2026-08-08' });
  const out = evaluateForward([...history(), ...testRows]);
  const force = out.observations.force.filter(r => r.session === 'heldout');
  const recovery = out.observations.recovery.filter(r => r.session === 'heldout');
  const usable = !['manual', 'interrupted'].includes(shape);
  expect(force.length).toBe(usable ? 1 : 0);
  expect(recovery.length).toBe(usable ? 3 : 0);
  expect(recovery[0]?.evidence).toBe(usable ? (shape === 'measured' ? 'measured' : 'historical_estimate') : undefined);
});

test('duplicate exports cannot multiply observations or alter predictions', () => {
  const base = history();
  const a = evaluateForward(base), b = evaluateForward([...base, ...base]);
  expect(b.observations).toEqual(a.observations);
  expect(b.inventory.excluded.duplicate).toBe(base.length);
  const conflict = prepareEvaluationRows([base[0], { ...base[0], avg_force_kg: 90 }]);
  expect(conflict.rows).toEqual([]);
  expect(conflict.excluded.conflicting_id).toBe(2);
});

test('harmonization is chosen from prior history and rejects missing acquisition metadata', () => {
  const legacy = history();
  const modern = { ...legacy[0], actual_time_s: 10, force_recording: { basis: 'target_acquired', acquisition_s: 0.8 } };
  expect(evaluationInterval(modern, legacy).actual_time_s).toBe(10.8);
  expect(evaluationInterval(modern, [modern]).actual_time_s).toBe(10);
  expect(evaluationInterval(legacy[0], [modern])).toBeNull();
  expect(evaluationInterval({ ...modern, force_recording: { basis: 'target_acquired', acquisition_s: null } }, legacy)).toBeNull();
});

test('planned-rest prediction is unchanged when actual rest differs; zero measured rest is allowed', () => {
  const set = recoveryRows('measured', { sessionId: 'heldout', date: '2026-08-08' });
  const a = evaluateForward([...history(), ...set]).observations.recovery.filter(r => r.session === 'heldout');
  const b = evaluateForward([...history(), ...set.map(r => ({ ...r, rep_timing: { ...r.rep_timing, rest_before_s: r.rep_num === 1 ? null : 0 } }))])
    .observations.recovery.filter(r => r.session === 'heldout');
  expect(b).toHaveLength(3);
  expect(b.map(r => r.predictions.plannedPersonal)).toEqual(a.map(r => r.predictions.plannedPersonal));
  expect(b.map(r => r.predictions.personal)).not.toEqual(a.map(r => r.predictions.personal));
});

test('metrics weight training days equally and do not turn unavailable comparisons into zero error', () => {
  const rows = [
    { date: '2026-01-01', actual: 10, predictions: { m: 20 } },
    ...Array.from({ length: 6 }, () => ({ date: '2026-01-02', actual: 10, predictions: { m: 10 } })),
    { date: '2026-01-03', actual: 10, predictions: { m: null } },
  ];
  expect(evaluationMetrics(rows, 'm')).toMatchObject({ trainingDays: 2, observations: 7, mae: 5, bias: 5, mapePct: 50 });
  expect(evaluateForward([]).force.all.available.prescription.mae).toBeNull();
});

test('an interruption preserves earlier comparisons but cannot turn later holds into fresh evidence', () => {
  const set = recoveryRows('interrupted', { sessionId: 'heldout', date: '2026-08-08', interruptedRep: 3 });
  const out = evaluateForward([...history(), ...set]);
  expect(out.observations.force.filter(r => r.session === 'heldout')).toHaveLength(1);
  expect(out.observations.recovery.filter(r => r.session === 'heldout').map(r => r.rep)).toEqual([2]);
  expect(out.recovery.excluded['tail:invalid_failure']).toBe(1);
});

test('comparison availability is explicit and pairwise errors use identical held-out observations', () => {
  const changedDuration = history().map(r => r.date === '2026-08-07' && r.rep_num === 1 ? { ...r, actual_time_s: 160 } : r);
  const out = evaluateForward(changedDuration);
  const comparison = out.force.all.matched.recentComparable;
  expect(out.force.all.available.prescription.observations).toBe(2);
  expect(comparison.prescription.observations).toBe(1);
  expect(comparison.recentComparable.observations).toBe(1);
});

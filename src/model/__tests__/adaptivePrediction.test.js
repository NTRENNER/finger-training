import { buildAdaptiveShadow, adaptiveShadowForce, adaptiveShadowTime, ADAPTIVE_PREDICTION_EXPERIMENT } from '../adaptivePrediction.js';
import { buildPredictionModels, preparePrediction, completePrediction, summarizePredictions } from '../predictionTracking.js';
import { buildThreeExpPriors } from '../threeExp.js';
import { recoveryRows } from '../../testHelpers/recoveryRows.js';

const history = () => Array.from({ length: 8 }, (_, i) => recoveryRows('legacy', {
  date: `2026-09-0${i + 1}`, sessionId: `prior-${i}`,
})).flat();
const model = () => buildPredictionModels(history(), 'Crusher', 'L', 30, {
  threeExpPriors: buildThreeExpPriors(history()), shadowReferenceDate: '2026-09-20' });
const prepared = models => preparePrediction(models, [], {
  loadKg: 30, target: 30, rest: 20, preparedAt: '2026-09-20T10:00:00Z' });
const record = (models, rep) => ({ ...rep, force_recording: { ...rep.force_recording,
  prediction_check: completePrediction(prepared(models), [], rep) } });

test('extra shadow is frozen before the hold and cannot alter current or existing candidate prescriptions', () => {
  const m = model(), before = prepared(m), snapshot = JSON.stringify(before);
  expect(m.adaptive.status).toBe('ready');
  const rep = recoveryRows('measured', { date: '2026-09-20' })[0];
  const a = completePrediction(before, [], rep);
  const b = completePrediction(before, [], { ...rep, actual_time_s: 80, avg_force_kg: 40 });
  m.adaptive.forces[0] = 190;
  expect(JSON.stringify(before)).toBe(snapshot);
  expect(a.adaptive_planned).toEqual(b.adaptive_planned);
  expect(a.models).toEqual(b.models);
  expect(a.adaptive_comparison.candidate).not.toBe(b.adaptive_comparison.candidate);
  const oldOnly = { ...m }; delete oldOnly.adaptive;
  const old = completePrediction(prepared(oldOnly), [], rep);
  expect(old.comparison).toEqual(a.comparison);
  expect(old.planned).toEqual(a.planned);
});

test('grid serializes without functions and future/same-day history cannot affect it', () => {
  const h = history();
  const a = buildAdaptiveShadow(h, 'L', 'Crusher', 30, '2026-09-20');
  const b = buildAdaptiveShadow([...h, ...recoveryRows('measured', { date: '2026-09-20' }),
    ...recoveryRows('measured', { date: '2026-10-01', sessionId: 'future' })], 'L', 'Crusher', 30, '2026-09-20');
  expect(a).toEqual(b);
  expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  expect(adaptiveShadowTime(a, adaptiveShadowForce(a, 40))).toBeCloseTo(40, 6);
  expect(adaptiveShadowForce(a, 601)).toBeNull();
  expect(adaptiveShadowTime(a, 10000)).toBeNull();
});

test('old saved checks do not fill the new checkpoint; hands count once; edits and versions are excluded', () => {
  const m = model();
  const reps = ['L', 'R'].map(hand => record({ ...m, hand }, {
    ...recoveryRows('measured', { date: '2026-09-20', sessionId: `new-${hand}` })[0], hand }));
  const report = summarizePredictions(reps);
  expect(report.adaptive).toMatchObject({ experiment: ADAPTIVE_PREDICTION_EXPERIMENT, days: 1,
    force: { current: { observations: 2 } }, daysToNextCheckpoint: 9 });
  const old = JSON.parse(JSON.stringify(reps));
  old.forEach(r => { delete r.force_recording.prediction_check.adaptive_comparison; });
  expect(summarizePredictions(old).days).toBe(1);
  expect(summarizePredictions(old).adaptive.days).toBe(0);
  const edited = reps.map(r => ({ ...r, avg_force_kg: 32 }));
  expect(summarizePredictions(edited).adaptive.days).toBe(0);
  const laterVersion = JSON.parse(JSON.stringify(reps));
  laterVersion.forEach(r => { r.force_recording.prediction_check.models.adaptive.version = 3; });
  expect(summarizePredictions(laterVersion).adaptive.days).toBe(0);
});

test('overshoots remain force evidence but not same-load time evidence; interruptions never count', () => {
  const m = model(), r = recoveryRows('measured', { date: '2026-09-20' })[0];
  const over = record(m, { ...r, avg_force_kg: 40 });
  expect(summarizePredictions([over]).adaptive.force.current.observations).toBe(1);
  expect(summarizePredictions([over]).adaptive.plannedForce.current.observations).toBe(0);
  const interrupted = record(m, { ...r, failure_valid: false, end_reason: 'equipment_interruption' });
  expect(summarizePredictions([interrupted]).adaptive.days).toBe(0);
  const partial = record(m, { ...r, force_recording: { ...r.force_recording,
    basis: 'target_acquired', acquisition_s: null } });
  expect(summarizePredictions([partial]).adaptive.days).toBe(0);
});

test('extra snapshot is opening-only and unavailable models do not prevent normal logging', () => {
  const m = model(), prefix = recoveryRows('measured', { date: '2026-09-20' }).slice(0, 1);
  const p = preparePrediction(m, prefix, { loadKg: 30, target: 30, rest: 20, preparedAt: '2026-09-20T10:00:00Z' });
  expect(p.models.adaptive).toBeUndefined();
  expect(p.adaptive_planned).toBeUndefined();
  const cold = buildAdaptiveShadow([], 'L', 'Crusher', 30, '2026-09-20');
  expect(cold.status).toBe('unavailable');
  expect(buildAdaptiveShadow(history(), 'L', 'Crusher', 5, '2026-09-20').status).toBe('unavailable');
  const result = record({ ...m, adaptive: cold }, prefix[0]);
  expect(result.force_recording.prediction_check.comparison.status).toBe('recorded');
});

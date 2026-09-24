import { buildPredictionModels, preparePrediction, completePrediction, predictionMetrics,
  summarizePredictions, predictionFingerprint } from '../predictionTracking.js';
import { buildFreshLoadMap, prescription, repKey } from '../prescription.js';
import { buildThreeExpPriors, predForceThreeExp } from '../threeExp.js';
import { freshFitReps } from '../load.js';
import { recoveryRows, RECOVERY_ROW_SHAPES } from '../../testHelpers/recoveryRows.js';

const history = () => Array.from({ length: 8 }, (_, i) => recoveryRows('legacy', {
  sessionId: `prior-${i}`, date: `2026-09-${String(i + 1).padStart(2, '0')}`,
}).map(r => ({ ...r, actual_time_s: r.actual_time_s * (1 + i / 4) }))).flat();
function setup() {
  const rows = history();
  const options = { freshMap: buildFreshLoadMap(rows), threeExpPriors: buildThreeExpPriors(rows), referenceDate: '2026-09-20' };
  return { rows, options, models: buildPredictionModels(rows, 'Crusher', 'L', 30, options) };
}
function prepare(models, prefix = [], loadKg = 30) {
  return preparePrediction(models, prefix, { loadKg, target: 30, rest: 20, preparedAt: '2026-09-20T10:00:00Z' });
}
function record(models, rep, prefix = []) {
  return { ...rep, force_recording: { ...rep.force_recording,
    prediction_check: completePrediction(prepare(models, prefix), prefix, rep) } };
}

test('snapshots expose the exact live fit; candidate changes fit points only', () => {
  const { rows, options, models } = setup();
  const current = prescription(rows, 'L', 'Crusher', 30, options);
  expect(models.current.status).toBe('ready');
  expect(models.candidate.status).toBe('ready');
  expect(models.current.planned_recommendation_kg).toBe(current.value);
  expect(predForceThreeExp(models.current.amps, 30)).toBeCloseTo(current.potential, 0);
  expect(models.current.scale).toBe(current.scale);
  const freshKeys = new Set(freshFitReps(rows).map(repKey));
  const candidateMap = new Map([...options.freshMap].map(([k, v]) => [k,
    { ...v, capacityEligible: v.capacityEligible !== false && freshKeys.has(k) }]));
  const candidate = prescription(rows, 'L', 'Crusher', 30, { ...options, freshMap: candidateMap });
  expect(models.candidate.planned_recommendation_kg).toBe(candidate.value);
  expect(models.current.duration_basis).toBe('legacy_elapsed');
  expect(options.freshMap.get(repKey(rows[1])).capacityEligible).not.toBe(false);
});

test('forecast remains frozen when history, fitted inputs and outcomes change', () => {
  const { models, rows, options } = setup();
  const p = prepare(models);
  const saved = JSON.stringify(p);
  rows[0].avg_force_kg = 90;
  options.threeExpPriors.get('Crusher')[0] = 90;
  models.current.amps[0] = 90;
  const rep = recoveryRows('measured')[0];
  const a = completePrediction(p, [], rep);
  const b = completePrediction(p, [], { ...rep, actual_time_s: 90, avg_force_kg: 40 });
  expect(JSON.stringify(p)).toBe(saved);
  expect(a.planned).toEqual(b.planned);
  expect(a.models).toEqual(b.models);
  expect(a.comparison.current).not.toEqual(b.comparison.current);
});

test.each(RECOVERY_ROW_SHAPES)('new recording with %s fields is classified explicitly', shape => {
  const { models } = setup();
  const rep = record(models, recoveryRows(shape)[0]);
  const result = summarizePredictions([rep]);
  expect(result.days).toBe(shape === 'measured' ? 1 : 0);
  if (shape !== 'measured') expect(result.exclusions.unmeasured_or_interrupted).toBe(1);
});

test('sustained overshoot scores conditional force but not the planned-load scenario', () => {
  const { models } = setup();
  const rep = record(models, { ...recoveryRows('measured')[0], avg_force_kg: 45 });
  const out = summarizePredictions([rep]);
  expect(out.days).toBe(1);
  expect(out.observations.force[0].actual).toBe(45);
  expect(out.plannedForce.current.observations).toBe(0);
});

test('target acquisition time is restored only with measured conversion metadata', () => {
  const { models } = setup();
  const raw = recoveryRows('measured')[0];
  const newer = { ...raw, force_recording: { ...raw.force_recording, basis: 'target_acquired', acquisition_s: .8 } };
  const p = record(models, newer).force_recording.prediction_check;
  expect(p.comparison.observed_s).toBe(40.8);
  for (const acquisition_s of [undefined, null, -1, NaN]) {
    expect(record(models, { ...newer, force_recording: { ...newer.force_recording, acquisition_s } })
      .force_recording.prediction_check.comparison.status).toBe('unavailable');
  }
});

test('recovery saves before the hold, uses measured rest separately, and stops at interruptions', () => {
  const { models } = setup();
  const reps = recoveryRows('measured');
  const opener = record(models, reps[0]);
  const p = prepare(models, [opener]);
  const a = completePrediction(p, [opener], reps[1]);
  const b = completePrediction(p, [opener], { ...reps[1], rep_timing: { ...reps[1].rep_timing, rest_before_s: 90 } });
  expect(a.planned).toEqual(b.planned);
  expect(a.comparison.current).not.toBe(b.comparison.current);
  expect(b.comparison.planned_matches).toBe(false);
  const interrupted = { ...reps[1], failure_valid: false };
  const bad = record(models, reps[2], [opener, interrupted]);
  expect(bad.force_recording.prediction_check.comparison.status).toBe('unavailable');
  expect(prepare(models, [opener, interrupted]).planned).toBeNull();
  const unknownRest = { ...reps[1], rep_timing: { ...reps[1].rep_timing, rest_before_s: null } };
  expect(record(models, unknownRest, [opener]).force_recording.prediction_check.comparison.status).toBe('unavailable');
});

test('JSONB reordering survives, edited or missing inputs and conflicting duplicates do not', () => {
  const { models } = setup();
  const reps = recoveryRows('measured');
  const a = record(models, reps[0]);
  const b = record(models, reps[1], [a]);
  const reorder = x => Array.isArray(x) ? x.map(reorder) : x && typeof x === 'object'
    ? Object.fromEntries(Object.keys(x).reverse().map(k => [k, reorder(x[k])])) : x;
  expect(summarizePredictions(reorder([a, b]))).toEqual(summarizePredictions([a, b]));
  expect(summarizePredictions([a, b, a, b])).toEqual(summarizePredictions([a, b]));
  expect(summarizePredictions([b]).recovery.current.days).toBe(0);
  const edit = { ...a, avg_force_kg: 90 };
  expect(summarizePredictions([edit, b]).force.current.days).toBe(0);
  expect(summarizePredictions([edit, b]).recovery.current.days).toBe(0);
  expect(summarizePredictions([a, edit, b]).force.current.days).toBe(0);
  expect(predictionFingerprint(a)).toBe(predictionFingerprint(JSON.parse(JSON.stringify(a))));
});

test('checkpoint counts days not hands/reps; future versions stay separate', () => {
  const { models } = setup();
  const all = Array.from({ length: 10 }, (_, i) => ['L', 'R'].map(hand => record({ ...models, hand }, {
    ...recoveryRows('measured', { sessionId: `new-${i}-${hand}`, date: `2026-09-${i + 10}` })[0], hand,
  }))).flat();
  const report = summarizePredictions(all);
  expect(report.days).toBe(10);
  expect(report.checkpoints).toBe(1);
  expect(report.force.current.observations).toBe(20);
  expect(report.daysToNextCheckpoint).toBe(10);
  const changed = JSON.parse(JSON.stringify(all));
  changed.forEach(r => { r.force_recording.prediction_check.experiment = 'next'; });
  expect(summarizePredictions(changed).days).toBe(0);
});

test('day weights and signed bias remain honest with different numbers of reps', () => {
  const rows = [{ date: 'a', actual: 10, m: 20 }, ...Array.from({ length: 6 }, () => ({ date: 'b', actual: 10, m: 8 }))];
  expect(predictionMetrics(rows, 'm')).toMatchObject({ days: 2, observations: 7, mae: 6, bias: 4, worst: 10 });
  expect(predictionMetrics([], 'm').mae).toBeNull();
});

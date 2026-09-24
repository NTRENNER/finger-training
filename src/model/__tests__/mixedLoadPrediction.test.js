import { buildMixedLoadModel, consumeMixedHold, recoverMixedState, mixedHoldTime,
  prepareMixedPrediction, completeMixedPrediction, summarizeMixedPredictions } from '../mixedLoadPrediction.js';
import { predForceThreeExp } from '../threeExp.js';

const amps = [18, 15, 25];
export const freshHistory = (hand = 'L') => [10, 30, 70, 115, 160, 220].map((t, i) => ({
  id: `old-${hand}-${i}`, session_id: `old-${i}`, date: `2026-09-${10 + i}`, grip: 'Micro', hand,
  rep_num: 1, set_num: 1, actual_time_s: t, avg_force_kg: predForceThreeExp(amps, t),
  peak_force_kg: 60, load_provenance: 'measured_force', failure_valid: true,
  end_reason: 'muscular_failure', force_recording: { version: 3, basis: 'target_acquired',
    capacity_eligible: true, signal_quality: 'complete' },
}));
const model = () => buildMixedLoadModel(freshHistory(), 'Micro', 'L', '2026-09-23');
const rep = (n = 1, load = 25, time = 30, rest = 30) => ({ id: `rep-${n}`, session_id: 'beta',
  grip: 'Micro', hand: 'L', rep_num: n, actual_time_s: time, avg_force_kg: load,
  load_provenance: 'measured_force', failure_valid: true, end_reason: 'muscular_failure',
  rep_timing: { rest_before_s: n === 1 ? null : rest },
  force_recording: { version: 3, basis: 'target_acquired', capacity_eligible: n === 1,
    signal_quality: 'complete', acquisition_s: 1,
    activity: { signal_quality: 'complete', duration_s: time + 1, impulse_kg_s: load * time + 10 },
    session_protocol: { id: 'whole_curve_beta', zone: 'power', position: n,
      role: n === 1 ? 'opening_hold' : 'fatigued_hold' } },
});
const saved = (m, prefix, r, plannedLoad = r.avg_force_kg) => {
  const prepared = prepareMixedPrediction(m, prefix, plannedLoad, 30);
  r.force_recording.mixed_load_prediction = completeMixedPrediction(prepared, prefix, r);
  return r;
};

test('target_force_failure from normal device recording remains valid beta evidence', () => {
  const first = { ...rep(), end_reason: 'target_force_failure' };
  const later = { ...rep(2, 20, 40), end_reason: 'target_force_failure' };
  const result = completeMixedPrediction(prepareMixedPrediction(model(), [first], 20, 30), [first], later);
  expect(result.comparison.status).toBe('recorded');
});

test('fresh holds reproduce the independent fresh curve, without the new session in its fit', () => {
  const m = model();
  expect(m).toMatchObject({ status: 'ready', source_sessions: 6, duration_basis: 'target_acquired' });
  for (const t of [10, 30, 115, 220]) expect(mixedHoldTime(m, [1,1,1], predForceThreeExp(amps, t)).seconds).toBeCloseTo(t, 2);
  expect(buildMixedLoadModel([...freshHistory(), { ...freshHistory()[0], date: '2026-09-24', avg_force_kg: 100 }],
    'Micro', 'L', '2026-09-23')).toEqual(m);
  expect(buildMixedLoadModel(freshHistory().slice(0, 2), 'Micro', 'L', '2026-09-23').status).toBe('unavailable');
});

test('force-time dose and actual recovery both change the available state', () => {
  const m = model();
  const light = consumeMixedHold(m, [1,1,1], 10 * 30);
  const heavy = consumeMixedHold(m, [1,1,1], 30 * 30);
  heavy.forEach((x, i) => expect(x).toBeLessThan(light[i]));
  const short = recoverMixedState(m, heavy, 10), long = recoverMixedState(m, heavy, 90);
  long.forEach((x, i) => expect(x).toBeGreaterThan(short[i]));
  expect(mixedHoldTime(m, long, 15).seconds).toBeGreaterThan(mixedHoldTime(m, short, 15).seconds);
});

test('lighter later holds can outlast the opener; actual prefix rest changes the next forecast', () => {
  const m = model(), first = rep();
  const later = prepareMixedPrediction(m, [first], 10, 30);
  expect(later.prediction.seconds).toBeGreaterThan(first.actual_time_s);
  const second = rep(2, 20, 40, 30);
  const short = prepareMixedPrediction(m, [first, second], 10, 30);
  second.rep_timing.rest_before_s = 100;
  expect(prepareMixedPrediction(m, [first, second], 10, 30).prediction.seconds).toBeGreaterThan(short.prediction.seconds);
});

test('current overshoot and outcome cannot rewrite the planned forecast, but have a separate diagnostic', () => {
  const m = model(), prefix = [rep()];
  const prepared = prepareMixedPrediction(m, prefix, 15, 30);
  const original = JSON.stringify(prepared);
  const low = completeMixedPrediction(prepared, prefix, rep(2, 15, 60));
  const high = completeMixedPrediction(prepared, prefix, rep(2, 20, 18));
  expect(JSON.stringify(prepared)).toBe(original);
  expect(high.prediction).toEqual(low.prediction);
  expect(high.comparison.conditional.seconds).toBeLessThan(low.comparison.conditional.seconds);
  expect(high.comparison.planned_scenario_matches).toBe(false);
  expect(high.comparison.status).toBe('recorded');
});

test.each(['interruption', 'manual', 'missing_rest', 'wrong_hand', 'wrong_session', 'gap'])('%s cannot silently reset to fresh', problem => {
  const prefix = [rep(), rep(2)];
  if (problem === 'interruption') prefix[0].failure_valid = false;
  if (problem === 'manual') prefix[0].load_provenance = 'nominal_setting';
  if (problem === 'missing_rest') prefix[1].rep_timing.rest_before_s = null;
  if (problem === 'wrong_hand') prefix[0].hand = 'R';
  if (problem === 'wrong_session') prefix[1].session_id = 'another';
  if (problem === 'gap') prefix[1].rep_num = 3;
  expect(prepareMixedPrediction(model(), prefix, 15, 30).prediction.status).toBe('unavailable');
});

test('zero actual rest is measured rest and different hands start independently', () => {
  const m = model(), prefix = [rep(), rep(2, 20, 20, 0)];
  expect(prepareMixedPrediction(m, prefix, 15, 30).prediction.status).toBe('estimated');
  const right = buildMixedLoadModel(freshHistory('R'), 'Micro', 'R', '2026-09-23');
  expect(prepareMixedPrediction(right, [], 25, 30).prediction).toEqual(prepareMixedPrediction(m, [], 25, 30).prediction);
});

test('missing actual rest, incomplete current signal, and incompatible timing never score', () => {
  const m = model(), first = rep(), current = rep(2), p = prepareMixedPrediction(m, [first], 25, 30);
  current.rep_timing.rest_before_s = null;
  expect(completeMixedPrediction(p, [first], current).comparison.reason).toBe('missing_actual_rest');
  current.rep_timing.rest_before_s = 30;
  current.force_recording.signal_quality = 'incomplete';
  expect(completeMixedPrediction(p, [first], current).comparison.status).toBe('unavailable');
  current.force_recording.signal_quality = 'complete';
  delete current.force_recording.basis;
  expect(completeMixedPrediction(p, [first], current).comparison.reason).toBe('incompatible_duration_basis');
});

test('legacy timing basis uses acquisition seconds explicitly and unavailable horizons are not clamped predictions', () => {
  const m = { ...model(), duration_basis: 'legacy_elapsed' }, r = rep();
  const result = saved(m, [], r).force_recording.mixed_load_prediction;
  expect(result.comparison.observed_s).toBe(31);
  expect(mixedHoldTime(m, [1,1,1], .01).status).toBe('beyond_horizon');
  expect(mixedHoldTime(m, [1,1,1], 100).status).toBe('above_available_force');
});

test('evaluation groups by independent workout, survives JSON, and excludes corrections', () => {
  const m = model(), first = saved(m, [], rep());
  const second = saved(m, [first], rep(2, 15, 70));
  const third = saved(m, [first, second], rep(3, 10, 100));
  const history = JSON.parse(JSON.stringify([first, second, third]));
  const report = summarizeMixedPredictions(history);
  expect(report.groups['v1|all']).toMatchObject({ sessions: 1, holds: 2, planned_scenario_sessions: 1 });
  expect(report.excluded.opening_hold).toBe(1);
  history[0].actual_time_s = 10;
  expect(summarizeMixedPredictions(history)).toMatchObject({ groups: {}, excluded: {
    edited_since_prediction: 1, edited_or_missing_prefix: 2 } });
});

test('a prediction of zero is scored as an error, not hidden as missing data', () => {
  const m = model(), first = saved(m, [], rep());
  const second = saved(m, [first], rep(2, 100, 20));
  const report = summarizeMixedPredictions([first, second]);
  expect(report.groups['v1|all']).toMatchObject({ sessions: 1, holds: 1, conditional_mae_s: 20 });
});

test('session-weighted evaluation does not let a workout with more holds dominate', () => {
  const m = model(), first = saved(m, [], rep());
  const second = saved(m, [first], rep(2, 15, 70));
  const third = saved(m, [first, second], rep(3, 10, 100));
  const otherFirst = saved(m, [], { ...rep(), id: 'other-1', session_id: 'other' });
  const otherSecond = saved(m, [otherFirst], { ...rep(2, 15, 200), id: 'other-2', session_id: 'other' });
  const error = r => {
    const c = r.force_recording.mixed_load_prediction.comparison;
    return Math.abs(c.conditional.seconds - c.observed_s);
  };
  const report = summarizeMixedPredictions([first, second, third, otherFirst, otherSecond, second]);
  expect(report.groups['v1|all'].sessions).toBe(2);
  expect(report.groups['v1|all'].holds).toBe(3);
  expect(report.groups['v1|all'].conditional_mae_s).toBeCloseTo(((error(second) + error(third)) / 2 + error(otherSecond)) / 2, 2);
});

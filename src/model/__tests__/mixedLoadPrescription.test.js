import { mixedReadinessModel, prepareAdaptiveMixedPrediction } from '../mixedLoadPrescription.js';
import { buildMixedLoadModel, mixedHoldTime, mixedStateBefore, summarizeMixedPredictions, completeMixedPrediction } from '../mixedLoadPrediction.js';
import { predForceThreeExp } from '../threeExp.js';

const history = [10, 30, 70, 115, 160, 220].map((t, i) => ({
  id: `old-${i}`, session_id: `old-${i}`, date: `2026-09-${10 + i}`, grip: 'Micro', hand: 'L',
  rep_num: 1, actual_time_s: t, avg_force_kg: predForceThreeExp([18, 15, 25], t),
  load_provenance: 'measured_force', failure_valid: true,
  force_recording: { version: 3, basis: 'target_acquired', capacity_eligible: true },
}));
const model = () => buildMixedLoadModel(history, 'Micro', 'L', '2026-09-26');
const rep = (n, time = 220, load = 15, rest = null) => ({ id: `r${n}`, session_id: 'chaos',
  grip: 'Micro', hand: 'L', rep_num: n, actual_time_s: time, avg_force_kg: load,
  load_provenance: 'measured_force', failure_valid: true, end_reason: 'target_force_failure',
  rep_timing: { rest_before_s: rest }, force_recording: {
    basis: 'target_acquired', signal_quality: 'complete', capacity_eligible: n === 1,
    activity: { signal_quality: 'complete', duration_s: time, impulse_kg_s: time * load },
    session_protocol: { id: 'whole_curve_beta', role: n === 1 ? 'opening_hold' : 'fatigued_hold', zone: 'strength' },
  },
});
const prepare = (m, prefix, overrides = {}) => prepareAdaptiveMixedPrediction(m, prefix,
  { baselineKg: 40, targetTime: 115, plannedRestS: 30, ...overrides });

test('an endurance opener lowers the next strength load toward 115s; inverse agrees with forward forecast', () => {
  const m = model(), prefix = [rep(1)];
  const p = prepare(m, prefix);
  expect(p.adjustment.status).toBe('adjusted');
  const state = mixedStateBefore(m, prefix, 30).state;
  expect(mixedHoldTime(m, state, p.adjustment.unrounded_load_kg).seconds).toBeCloseTo(115, 3);
  // Display/recording uses 0.1 kg steps; the saved forecast uses that rounded load.
  expect(Math.abs(p.prediction.seconds - 115)).toBeLessThan(2);
  expect(p.load_kg).toBeLessThan(predForceThreeExp(m.amps, 115, m.curve_taus));
  expect(p.mode).toBe('adaptive_targets');
  expect(p.prior_rep_ids).toEqual(['r1']);
});
test('more measured work lowers the next load and longer planned rest restores it', () => {
  const m = model();
  expect(prepare(m, [rep(1, 220)]).load_kg).toBeLessThan(prepare(m, [rep(1, 30)]).load_kg);
  expect(prepare(m, [rep(1)], { plannedRestS: 90 }).load_kg).toBeGreaterThan(prepare(m, [rep(1)]).load_kg);
  expect(prepare(m, [rep(1), rep(2, 60, 20, 120)]).load_kg)
    .toBeGreaterThan(prepare(m, [rep(1), rep(2, 60, 20, 10)]).load_kg);
});
test('opening load is retained; subsequent loads cannot exceed the original plan', () => {
  expect(prepare(model(), [], { baselineKg: 15 })).toMatchObject({load_kg:15, adjustment:{status:'opening_hold'}});
  expect(prepare(model(), [rep(1)], { baselineKg: 1 })).toMatchObject({load_kg:1, adjustment:{status:'capped_at_original'}});
});
test.each(['interrupted', 'manual', 'missing_rest', 'wrong_hand', 'missing_model', 'outside_range'])('%s explicitly falls back rather than inventing capacity', issue => {
  let m = model(); const prefix = [rep(1), rep(2, 40, 20, 30)];
  const opts = {};
  if (issue === 'interrupted') prefix[0].failure_valid = false;
  if (issue === 'manual') prefix[0].load_provenance = 'nominal_setting';
  if (issue === 'missing_rest') prefix[1].rep_timing.rest_before_s = null;
  if (issue === 'wrong_hand') prefix[0].hand = 'R';
  if (issue === 'missing_model') m = {status:'unavailable', reason:'insufficient_fresh_history'};
  if (issue === 'outside_range') opts.targetTime = 300;
  expect(prepare(m, prefix, opts)).toMatchObject({load_kg:40, adjustment:{status:'unavailable'}});
});
test('readiness is applied once to a copied model and a new workout can start fresh', () => {
  const m = model(), before = JSON.stringify(m), scaled = mixedReadinessModel(m, .8);
  expect(scaled.amps).toEqual(m.amps.map(a => a * .8));
  expect(scaled.readiness_multiplier).toBe(.8);
  expect(JSON.stringify(m)).toBe(before);
  expect(prepare(scaled, [rep(1)]).load_kg).toBeLessThan(prepare(m, [rep(1)]).load_kg);
});
test('adaptive results are reported separately from shadow-only forecasts and current results cannot rewrite the plan', () => {
  const m=model(), first=rep(1), next=rep(2,115,20,30), prepared=prepare(m,[first]);
  const frozen=JSON.stringify(prepared);
  next.avg_force_kg=prepared.load_kg;
  next.force_recording.mixed_load_prediction=completeMixedPrediction(prepared,[first],next);
  expect(JSON.stringify(prepared)).toBe(frozen);
  const report=summarizeMixedPredictions([first,next]);
  expect(report.groups['v1|adaptive_targets|all']).toMatchObject({sessions:1,holds:1});
  expect(report.groups['v1|all']).toBeUndefined();
});

import { firstSessionEvidence, firstTrainingSessionRows } from '../firstSessionEvidence.js';
import { freshFitReps } from '../load.js';
import { prescription, buildFreshLoadMap, loadBounds, estimateRefWeight } from '../prescription.js';
import { buildThreeExpPriors, predForceThreeExp } from '../threeExp.js';
import { computeDensityLadder, resolveDensityLadderLoads } from '../densityLadder.js';
import { buildMixedLoadModel } from '../mixedLoadPrediction.js';

const row = (date = '2026-09-20', session = 'first', hour = '08', extra = {}) => ({
  id: `${date}-${session}`, date, session_id: session, session_started_at: `${date}T${hour}:00:00Z`,
  grip: 'Micro', hand: 'L', rep_num: 1, set_num: 1, target_duration: 160,
  actual_time_s: 160, avg_force_kg: 10, peak_force_kg: 12, failure_valid: true, ...extra,
});
const chaos = (r, opening = true) => ({ ...r, force_recording: { version: 3,
  capacity_eligible: opening, session_protocol: { id: 'whole_curve_beta',
    role: opening ? 'opening_hold' : 'fatigued_hold', position: opening ? 1 : 2 } } });
const series = (date, session, hour, T, count = 4, extra = {}) => Array.from({length: count}, (_, i) =>
  row(date, session, hour, { id: `${session}-${i}`, rep_num: i + 1, target_duration: T,
    actual_time_s: i === 0 ? T : T * .7, avg_force_kg: 10, prescribed_load_kg: 10, rest_s: 30, ...extra }));

test('order is per local training date, grip and hand and is independent of input order', () => {
  const a = row(), b = row(undefined, 'late', '18'), right = {...b, hand:'R'}, crusher = {...b, grip:'Crusher'};
  const h = [b, right, a, crusher];
  expect(firstTrainingSessionRows(h)).toEqual([right, a, crusher]);
  expect(new Set(firstTrainingSessionRows([...h].reverse()))).toEqual(new Set([a, right, crusher]));
  expect(firstSessionEvidence(h)(b)).toBe('later_session');
});

test.each([
  { failure_valid: false }, { set_num: 2 }, { avg_force_kg: 0, peak_force_kg: 0 },
  { actual_time_s: 0, force_recording: {activity: {duration_s: 5}} },
])('earlier work blocks a later session even when it cannot fit the curve: %j', extra => {
  const later = row(undefined, 'later', '18');
  expect(freshFitReps([row(undefined, 'first', '08', extra), later])).not.toContainEqual(later);
});

test('a peak measurement does not consume the daily training opener', () => {
  const p = row(undefined, 'peak', '07', { target_duration:3, actual_time_s:3,
    force_recording:{ session_protocol:{ id:'peak_test', version:2 } } });
  expect(firstSessionEvidence([p, row()])(p)).toBe('peak_measurement');
  expect(freshFitReps([p, row()])).toContainEqual(row());
});

test('unknown ordering is explicit; IDs and upload dates cannot invent an order', () => {
  const a = row(undefined, 'a', '08', { session_started_at:null }), b = row(undefined, 'z', '18');
  for (const h of [[a,b],[b,a]]) {
    expect(firstSessionEvidence(h)(a)).toBe('unknown');
    expect(firstSessionEvidence(h)(b)).toBe('unknown');
    expect(freshFitReps(h)).toEqual([]);
  }
  expect(firstSessionEvidence([a])(a)).toBe('legacy_single_session');
  expect(freshFitReps([a])).toHaveLength(1);
  const tie = {...b, session_started_at:row().session_started_at};
  expect(freshFitReps([row(), tie])).toEqual([]);
});

test('recorded rep start can establish missing session order', () => {
  const a = row(undefined, 'a', '08', {session_started_at:null, rep_timing:{started_at_ms:1000}});
  const b = row(undefined, 'b', '18', {session_started_at:null, rep_timing:{started_at_ms:2000}});
  expect(freshFitReps([b,a])).toEqual([a]);
});

test('only the opening Chaos hold of the first session qualifies', () => {
  const opener = chaos(row());
  const laterHold = chaos(row(undefined, 'first', '08', {rep_num:2}), false);
  const laterSession = row(undefined, 'ordinary', '18', {actual_time_s:80});
  expect(freshFitReps([laterSession,laterHold,opener])).toEqual([opener]);
  expect(freshFitReps([row(),chaos(row(undefined,'second','18'))])).toEqual([row()]);
  expect(freshFitReps([opener,laterSession], {includeLaterSessions:true})).toHaveLength(2);
});

const seed = [30,70,115,160,220].map((t,i) => row(`2026-09-${10+i}`, `seed-${i}`, '08', {
  target_duration:t, actual_time_s:t, avg_force_kg:predForceThreeExp([18,15,25],t), peak_force_kg:60,
}));
const live = h => {
  const priors = buildThreeExpPriors(h), freshMap = buildFreshLoadMap(h);
  return [160,220].map(T => ({
    prediction:prescription(h,'L','Micro',T,{threeExpPriors:priors,freshMap,referenceDate:'2026-09-30'}),
    bounds: (()=>{const {capBase,capValue,wasEnduranceCeiled,...b}=loadBounds(h,'L','Micro',T,{referenceDate:'2026-09-30'});return b;})(),
    fallback:estimateRefWeight(h,'L','Micro',T),
  }));
};

test('later sessions, reps and sets cannot change the live curve, priors, bounds or Chaos source model', () => {
  const h=[...seed,row()];
  const added=[row(undefined,'second','18',{actual_time_s:5,avg_force_kg:1}),
    row(undefined,'first','08',{id:'later-rep',rep_num:2,actual_time_s:7,avg_force_kg:80}),
    row(undefined,'first','08',{id:'later-set',set_num:2,actual_time_s:250,avg_force_kg:80})];
  const full=[...h,...added];
  expect(buildThreeExpPriors(full)).toEqual(buildThreeExpPriors(h));
  expect(live(full)).toEqual(live(h));
  expect(buildMixedLoadModel(full,'Micro','L','2026-09-30')).toEqual(buildMixedLoadModel(h,'Micro','L','2026-09-30'));
});

test('eligible first sets still earn 4 → 5 → 6 → higher load; later work cannot reset the rung', () => {
  for (const n of [4,5,6]) {
    const first=series('2026-09-20','first','08',160,n);
    const later=series('2026-09-20','late','18',160,4,{actual_time_s:5});
    const optional=first.map(r=>({...r,set_num:2,actual_time_s:5}));
    const earned=computeDensityLadder(first,'Micro','strength_endurance',{expectedHands:['L']});
    expect(earned.reps).toBe(n===6?4:n+1);
    expect(earned.decision).toBe(n===6?'step_load':'advance');
    expect(computeDensityLadder([...first,...later,...optional],'Micro','strength_endurance',{expectedHands:['L']})).toEqual(earned);
  }
});

test('same-day failed SE after Chaos cannot create the duplicate SE/endurance correction', () => {
  const se=series('2026-09-18','se','08',160,4);
  const en=series('2026-09-19','en','08',220,4,{avg_force_kg:7,prescribed_load_kg:7});
  const opener=chaos(row('2026-09-20','chaos','08',{target_duration:30,actual_time_s:30,avg_force_kg:15,peak_force_kg:17}));
  const baseline=[...se,...en,opener];
  const fatigued=series('2026-09-20','second','18',160,4,{actual_time_s:100,avg_force_kg:7,prescribed_load_kg:7});
  const full=[...baseline,...fatigued];
  const s=computeDensityLadder(full,'Micro','strength_endurance',{expectedHands:['L']});
  const e=computeDensityLadder(full,'Micro','endurance',{expectedHands:['L']});
  expect(s).toEqual(computeDensityLadder(baseline,'Micro','strength_endurance',{expectedHands:['L']}));
  expect(s.basis.date).toBe('2026-09-18');
  expect(resolveDensityLadderLoads(s,{L:10}).L).toBeGreaterThan(resolveDensityLadderLoads(e,{L:7}).L);
});

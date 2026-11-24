import { buildTrainingPattern } from '../trainingPattern.js';

const start = '2026-11-16', end = '2026-11-22';
const rep = (session, date = start, extra = {}) => ({ id: `${session}-${date}`, session_id: session,
  date, grip: 'Micro', hand: 'L', set_num: 1, rep_num: 1, actual_time_s: 30,
  avg_force_kg: 20, peak_force_kg: 25, target_duration: 40, ...extra });
const pattern = (history, activities = []) => buildTrainingPattern(history, activities, { start, end });

test('three blocks on one day are one training day; hands and extra sets do not become blocks', () => {
  const rows = [rep('micro-1'), rep('micro-2'), rep('crusher', start, { grip: 'Crusher' }),
    rep('micro-1', start, { id: 'right', hand: 'R' }),
    rep('micro-1', start, { id: 'extra-set', set_num: 2 })];
  const result = pattern(rows);
  expect(result.totals).toMatchObject({ trainingDays: 1, blocks: 3, sets: 5, reps: 5, workSeconds: 150 });
  expect(result.byGrip.find(g => g.grip === 'Micro')).toMatchObject({ trainingDays: 1, blocks: 2 });
  expect(result.days).toHaveLength(7);
  expect(result.days[0].blocks).toHaveLength(3);
  expect(result.spacingDays).toEqual([]);
});

test('unknown block identity stays unknown, with spacing based on recorded dates', () => {
  const result = pattern([rep('known'), rep(null, '2026-11-18', { id: 'legacy1' }),
    rep(null, '2026-11-18', { id: 'legacy2', hand: 'R' })]);
  expect(result.totals).toMatchObject({ trainingDays: 2, blocks: 1, unidentifiedReps: 2, sets: 1 });
  expect(result.days[2].blocks[0].identified).toBe(false);
  expect(result.spacingDays).toEqual([2]);
});

test('uses explicit session start when identity is absent and keeps grips separate', () => {
  const result = pattern([rep(null, start, { id: '1', session_started_at: `${start}T12:00:00Z` }),
    rep(null, start, { id: '2', session_started_at: `${start}T13:00:00Z` }),
    rep(null, start, { id: '3', session_started_at: `${start}T13:00:00Z`, grip: 'Prime' })]);
  expect(result.totals.blocks).toBe(3);
});

test('partial session IDs do not split one block; ambiguous shared timestamps stay unknown', () => {
  const started = `${start}T12:00:00Z`;
  const rows = [rep('s', start, { session_started_at: started }),
    rep(null, start, { id: 'partial', session_started_at: `${start}T06:00:00-06:00`, hand: 'R' })];
  expect(pattern(rows).totals).toMatchObject({ blocks: 1, unidentifiedReps: 0, sets: 2 });
  rows.push(rep('another', start, { session_started_at: started }));
  expect(pattern(rows).totals).toMatchObject({ blocks: 2, unidentifiedReps: 1 });
});

test('nominal settings and incomplete sensor activity are not presented as complete measured exposure', () => {
  const result = pattern([rep('nominal', start, { avg_force_kg: null, manual_load_kg: 90, load_provenance: 'nominal_setting' }),
    rep('partial', start, { force_recording: { version: 2, signal_quality: 'incomplete',
      activity: { duration_s: 30, impulse_kg_s: 300 } } })]);
  expect(result.totals).toMatchObject({ measuredKgS: 300, estimatedKgS: 0, unknownLoadSeconds: 30, uncertain: true });
});

test('deduplicates IDs, counts short/disputed effort as work, excludes warmups, assessments, seeds and dates outside the window', () => {
  const valid = rep('a', start, { actual_time_s: 2, failure_valid: false });
  const result = pattern([valid, valid, rep('past', '2026-11-15'), rep('future', '2026-11-23'),
    rep('seed', start, { avg_force_kg: 25 }),
    rep('peak', start, { force_recording: { session_protocol: { id: 'peak_test', version: 2 } } }),
    rep('warmup', start, { force_recording: { session_protocol: { id: 'warmup_potentiation', version: 1 } } }),
    rep('bad', 'invalid')]);
  expect(result.totals).toMatchObject({ trainingDays: 1, blocks: 1, reps: 1, workSeconds: 2 });
});

test('redo activity counts every attempt once; prescribed-only loads never become observed exposure', () => {
  const result = pattern([rep('redo', start, { actual_time_s: 10, avg_force_kg: 20,
    force_recording: { version: 2, activity: { duration_s: 30, impulse_kg_s: 600 },
      last_attempt_activity: { duration_s: 10, impulse_kg_s: 200 },
      redo_attempts: [{ actualTime: 20, avgForce: 20, forceRecording: { activity: { duration_s: 20, impulse_kg_s: 400 } } }] } }),
    rep('unknown', start, { avg_force_kg: null, prescribed_load_kg: 100 })]);
  expect(result.totals).toMatchObject({ reps: 2, attempts: 3, workSeconds: 60, measuredKgS: 600, estimatedKgS: 0, unknownLoadSeconds: 30 });
});

test('manual redo following sensor work preserves both without double counting measured activity', () => {
  const result = pattern([rep('redo', start, { actual_time_s: 10, avg_force_kg: null, manual_load_kg: 15,
    load_provenance: 'known_external_load', force_recording: { version: 2,
      activity: { duration_s: 20, impulse_kg_s: 400 }, last_attempt_activity: null,
      redo_attempts: [{ actualTime: 20, avgForce: 20, forceRecording: { activity: { duration_s: 20, impulse_kg_s: 400 } } }] } })]);
  expect(result.totals).toMatchObject({ attempts: 2, workSeconds: 30, measuredKgS: 400, estimatedKgS: 150 });
});

test('climbing on the same date is context, never assumed to precede fingers or equal one climb per session', () => {
  const result = pattern([rep('a')], [
    { id: 'c1', type: 'climbing', date: start }, { id: 'c2', type: 'climbing', date: start },
    { id: 'c3', type: 'climbing', date: '2026-11-19' }, { id: 'future', type: 'climbing', date: '2026-11-23' }]);
  expect(result).toMatchObject({ climbingDays: 2, sharedClimbingDays: 1 });
  expect(result.days[0].climbingEntries).toBe(2);
  expect(result.totals.trainingDays).toBe(1);
});

test('mixed protocol holds stay in one block; protocol labels use saved metadata', () => {
  const rows = [rep('chaos', start, { force_recording: { session_protocol: { id: 'whole_curve_beta', zone: 'power' } } }),
    rep('chaos', start, { id: 'c2', rep_num: 2, force_recording: { session_protocol: { id: 'whole_curve_beta', zone: 'endurance' } } }),
    rep('volume', start, { force_recording: { volume_beta: { id: 'volume_beta' } } })];
  const result = pattern(rows);
  expect(result.totals.blocks).toBe(2);
  expect(result.byProtocol.map(p => p.protocol).sort()).toEqual(['Chaos Machine', 'Volume Beta']);
  expect(result.byProtocol.find(p => p.protocol === 'Chaos Machine').reps).toBe(2);
});

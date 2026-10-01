import { buildVolumeBaseline, createVolumeExperiment, isValidVolumeExperiment, volumeExperimentStatus,
  volumeSessionPlan, volumeProgress, volumeComparison } from '../volumeExperiment.js';

const row = (date = '2026-09-20', extra = {}) => ({
  id: `${date}-L`, session_id: `${date}-session`, session_started_at: `${date}T08:00:00Z`,
  date, grip: 'Micro', hand: 'L', set_num: 1, rep_num: 1, target_duration: 160,
  avg_force_kg: 10, peak_force_kg: 12, actual_time_s: 150, failure_valid: true,
  end_reason: 'muscular_failure', load_provenance: 'measured_force',
  force_recording: { version: 4, basis: 'target_acquired', capacity_eligible: true,
    failure_policy: { version: 8 }, signal_quality: 'complete' }, ...extra,
});
const create = (history = [], extra = {}) => createVolumeExperiment({ history, grips: ['Micro'],
  startDate: '2026-10-01', id: 'experiment-1', createdAt: '2026-10-01T08:00:00Z', ...extra });
const planFor = (experiment, date = '2026-10-02') => volumeSessionPlan(experiment, 'Micro', date);
const tagged = (experiment, date = '2026-10-02', extra = {}) => {
  const r = row(date, extra);
  return { ...r, force_recording: { ...r.force_recording,
    volume_beta: planFor(experiment, date),
    session_prescription: { version: 1, target_duration_s: 160, reps_per_set: 4,
      rest_s: 20, load_kg: 10, hand_mode: 'Both' } } };
};
const session = (experiment, date = '2026-10-02', hands = ['L', 'R']) => hands.flatMap(hand =>
  [1, 2].flatMap(set_num => [1, 2, 3, 4].map(rep_num => {
    const r = tagged(experiment, date, { id: `${date}-${hand}-${set_num}-${rep_num}`, hand, set_num, rep_num });
    return { ...r, force_recording: { ...r.force_recording, activity: { duration_s: 160, impulse_kg_s: 1600 },
      session_prescription: { ...r.force_recording.session_prescription, hand_mode: hands.length === 2 ? 'Both' : hands[0] } } };
  })));
const baseline = e => e.baseline.byHand.find(h => h.hand === 'L');
const comparison = (e, rows, date = '2026-11-11') => volumeComparison(e, rows, date).byHand.find(h => h.hand === 'L');

test('freezes exactly 42 calendar days and the six-week two-set plan', () => {
  const e = create([], { startDate: '2026-10-18', grips: ['Micro', 'Crusher', 'Micro'] });
  expect(e).toMatchObject({ startDate: '2026-10-18', endDate: '2026-11-28', days: 42, weeks: 6,
    weeklyGoal: 3, goalSessionsPerGrip: 18, sets: 2, restSeconds: 300, status: 'active', grips: ['Micro', 'Crusher'] });
  expect(Object.isFrozen(e)).toBe(true);
  expect(Object.isFrozen(e.baseline.byHand[0].points)).toBe(true);
  expect(isValidVolumeExperiment(e)).toBe(true);
  expect(volumeSessionPlan(e, 'Micro', '2026-10-18')).toEqual({ id: 'volume_beta', version: 1,
    experiment_id: e.id, started_on: '2026-10-18', ends_on: '2026-11-28', sets: 2, rest_s: 300,
    goal_sessions_per_grip: 18 });
});

test('a pause never extends the calendar; final day is included and expiry is next day', () => {
  const e = create(), paused = { ...e, status: 'paused' };
  expect(e.endDate).toBe('2026-11-11');
  expect(volumeExperimentStatus(e, '2026-11-11')).toBe('active');
  expect(volumeExperimentStatus(e, '2026-11-12')).toBe('completed');
  expect(volumeExperimentStatus(paused, '2026-10-10')).toBe('paused');
  expect(volumeExperimentStatus(paused, '2026-11-12')).toBe('completed');
  expect(volumeSessionPlan(paused, 'Micro', '2026-10-10')).toBeNull();
  expect(volumeSessionPlan(e, 'Crusher', '2026-10-10')).toBeNull();
  expect(volumeSessionPlan(e, 'Micro', '2026-09-30')).toBeNull();
  expect(volumeSessionPlan(e, 'Micro', '2026-11-12')).toBeNull();
  expect(volumeExperimentStatus({ ...e, status: 'ended' }, '2026-12-01')).toBe('ended');
});

test('rejects malformed protocol and dates but accepts lifecycle and review extensions', () => {
  const e = create();
  expect(() => create([], { startDate: '2026-02-30' })).toThrow();
  expect(() => create([], { grips: [] })).toThrow();
  for (const changes of [{ restSeconds: 20 }, { days: 43 }, { sets: 1 }, { endDate: '2026-11-12' },
    { grips: ['Micro', 'Micro'] }, { baseline: null }, { status: 'garbage' }, { createdAt: 123 }, { createdAt: {} }]) {
    expect(isValidVolumeExperiment({ ...e, ...changes })).toBe(false);
  }
  expect(isValidVolumeExperiment({ ...e, status: 'paused', pausedAt: '2026-10-10',
    reviews: { 1: { climbingQuality: 'good', fatigue: 'moderate', timeCost: 'manageable' } } })).toBe(true);
});

test('baseline includes only the previous 42 days and is immune to future records or history edits', () => {
  const history = [row('2026-08-19', { avg_force_kg: 30 }), row('2026-08-20'), row('2026-09-20'),
    row('2026-09-30'), row('2026-10-01', { avg_force_kg: 20 }), row('2026-10-02', { avg_force_kg: 30 })];
  const e = create(history);
  expect(e.baseline).toMatchObject({ windowStart: '2026-08-20', windowEnd: '2026-09-30',
    trainingDaysByGrip: { Micro: 3 } });
  expect(baseline(e).points.map(p => p.date)).toEqual(['2026-08-20', '2026-09-20', '2026-09-30']);
  expect(baseline(e).loadKg).toBe(10);
  expect(baseline(e).provisional).toBe(false);
  history[3].avg_force_kg = 30;
  history[3].force_recording.failure_policy.version = 9;
  expect(baseline(e).points.at(-1).forceKg).toBe(10);
  expect(baseline(e).points.at(-1).policy.version).toBe(8);
});

test('benchmark tolerance remains fixed to latest actual force rather than drifting across matches', () => {
  const e = create([row('2026-09-10', { avg_force_kg: 9.5 }), row('2026-09-11', { avg_force_kg: 9.7 }),
    row('2026-09-12', { avg_force_kg: 10.3 }), row('2026-09-20', { avg_force_kg: 10,
      prescribed_load_kg: 5, actual_time_s: 180 })]);
  expect(baseline(e).loadKg).toBe(10);
  expect(baseline(e).points.map(p => p.forceKg)).toEqual([9.7, 10.3, 10]);
  expect(baseline(e).meanTimeS).toBe(160);
});

test('first-session order is established before removing interrupted efforts and optional sets', () => {
  const badFirst = row('2026-09-20', { failure_valid: false });
  const later = row('2026-09-20', { id: 'later', session_id: 'later', session_started_at: '2026-09-20T18:00:00Z' });
  const optional = row('2026-09-21', { set_num: 2 });
  const afterOptional = row('2026-09-21', { id: 'after-set', session_id: 'later',
    session_started_at: '2026-09-21T18:00:00Z' });
  expect(baseline(create([badFirst, later, optional, afterOptional])).points).toEqual([]);
});

test('excludes peaks, later reps, seed artifacts and nominal/prescribed force without losing Chaos openers', () => {
  const chaos = row('2026-09-20');
  chaos.force_recording.session_protocol = { id: 'whole_curve_beta', role: 'opening_hold', position: 1 };
  const fatigued = row('2026-09-21');
  fatigued.force_recording.session_protocol = { id: 'whole_curve_beta', role: 'fatigued_hold', position: 2 };
  const bad = [row('2026-09-22', { target_duration: 3, actual_time_s: 3 }),
    row('2026-09-23', { rep_num: 2 }), row('2026-09-24', { set_num: 2 }),
    row('2026-09-25', { avg_force_kg: 12, peak_force_kg: 12, force_recording: null }),
    row('2026-09-26', { avg_force_kg: null, prescribed_load_kg: 10, weight_kg: 10 }),
    row('2026-09-27', { load_provenance: 'nominal_setting' })];
  expect(baseline(create([chaos, fatigued, ...bad])).points).toHaveLength(1);
  expect(baseline(create([chaos, fatigued, ...bad])).points[0].protocol).toBe('whole_curve_beta');
});

test('known external load can form its own baseline, never paired with measured spring force', () => {
  const manual = row('2026-09-30', { avg_force_kg: null, manual_load_kg: 10,
    load_provenance: 'known_external_load', force_recording: null });
  const e = create([row(), manual]);
  expect(baseline(e)).toMatchObject({ loadKg: 10, source: 'known_external_load', provisional: true });
  expect(baseline(e).points).toHaveLength(1);
  expect(comparison(e, [tagged(e)])).toMatchObject({ points: [], status: 'no_matches' });
});

test('duplicates never create independent baseline dates; conflicting openers are omitted', () => {
  const first = row(), copy = { ...first, id: 'copy' };
  expect(baseline(create([first, copy])).points).toHaveLength(1);
  expect(baseline(create([first, { ...copy, actual_time_s: 200 }])).points).toHaveLength(0);
});

test('two hands and another completed session on the same date count one grip training day', () => {
  const e = create();
  const complete = session(e), again = complete.map(r => ({ ...r, id: `again-${r.id}`, session_id: 'again' }));
  const p = volumeProgress(e, [...complete, ...again], '2026-10-02');
  expect(p).toMatchObject({ status: 'active', week: 1 });
  expect(p.byGrip[0]).toMatchObject({ started: 1, completed: 1, twoSetSessions: 1, goal: 18,
    completedSets: 8, recordedSets: 8, holdCount: 32, workSeconds: 5120, impulseKgS: 51200, estimatedWork: false });
  expect(p.byGrip[0].dates).toEqual(['2026-10-02']);
});

test.each(['missing', 'duplicate', 'interrupted', 'missing-plan', 'changed-plan', 'missing-hand', 'missing-set'])(
  '%s slots preserve started activity but cannot complete the two-set session', defect => {
    const e = create(), reps = session(e);
    if (defect === 'missing') reps.pop();
    if (defect === 'duplicate') reps[15] = { ...reps[14], id: 'duplicate' };
    if (defect === 'interrupted') reps[15] = { ...reps[15], failure_valid: false, end_reason: 'equipment_interruption' };
    if (defect === 'missing-plan') delete reps[15].force_recording.session_prescription;
    if (defect === 'changed-plan') reps[15].force_recording.session_prescription.reps_per_set = 5;
    if (defect === 'missing-hand') reps.splice(8);
    if (defect === 'missing-set') reps.splice(12);
    expect(volumeProgress(e, reps, '2026-10-02').byGrip[0]).toMatchObject({ started: 1, completed: 0, twoSetSessions: 0 });
  });

test('a deliberately single-hand plan can complete; missing the other hand of Both cannot', () => {
  const e = create();
  expect(volumeProgress(e, session(e, '2026-10-02', ['L']), '2026-10-02').byGrip[0])
    .toMatchObject({ started: 1, completed: 1, completedSets: 2 });
});

test('a short valid failure still completes a rep; no performance threshold gates adherence', () => {
  const e = create(), reps = session(e);
  reps[15] = { ...reps[15], actual_time_s: 5, failed: true };
  expect(volumeProgress(e, reps, '2026-10-02').byGrip[0].completed).toBe(1);
});

test.each(['capacity_ineligible', 'user_interruption'])('%s cannot count as a complete two-set session', defect => {
  const e = create(), reps = session(e);
  // A force trace can reach failure but include recovered unloading, so
  // failure_valid alone does not establish a continuous completed hold.
  if (defect === 'capacity_ineligible') reps[15].force_recording.capacity_eligible = false;
  else reps[15].end_reason = 'user_interruption';
  expect(volumeProgress(e, reps, '2026-10-02').byGrip[0]).toMatchObject({
    started: 1, completed: 0, completedSets: 3, recordedSets: 4, holdCount: 16,
  });
});

test('sync copies are deduplicated, invalid work retained, and unknown load is never invented from targets', () => {
  const e = create(), r = tagged(e, '2026-10-02', { actual_time_s: 5, failure_valid: false,
    avg_force_kg: null, prescribed_load_kg: 100 });
  expect(volumeProgress(e, [r, { ...r }], '2026-10-02').byGrip[0]).toMatchObject({ started: 1,
    completed: 0, holdCount: 1, workSeconds: 5, impulseKgS: 0, estimatedWork: true });
});

test('unrelated experiments, future outcomes and untagged work do not enter progress', () => {
  const e = create(), a = session(e), b = session(e, '2026-10-03');
  const other = a.map(r => ({ ...r, id: `other-${r.id}`, force_recording: { ...r.force_recording,
    volume_beta: { ...r.force_recording.volume_beta, experiment_id: 'another' } } }));
  expect(volumeProgress(e, [...a, ...b, ...other, row('2026-10-02')], '2026-10-02').byGrip[0])
    .toMatchObject({ started: 1, completed: 1, holdCount: 16 });
  expect(volumeProgress(e, [], '2026-10-08').week).toBe(2);
  expect(volumeProgress(e, [], '2026-12-01').week).toBe(6);
});

test('comparison uses at most three latest independent matching dates and unchanged baseline', () => {
  const e = create([row('2026-09-10'), row('2026-09-20'), row('2026-09-30')]);
  const rows = ['02', '04', '06', '08'].map((day, i) => tagged(e, `2026-10-${day}`, { actual_time_s: 160 + i * 10 }));
  const c = comparison(e, rows);
  expect(c).toMatchObject({ status: 'descriptive', meanTimeS: 180, changeSeconds: 30,
    changePercent: expect.closeTo(20), provisional: false });
  expect(c.points.map(p => p.date)).toEqual(['2026-10-04', '2026-10-06', '2026-10-08']);
  expect(c.baseline.meanTimeS).toBe(150);
  expect(comparison(e, rows, '2026-10-04').meanTimeS).toBe(165);
});

test.each(['basis', 'recording-version', 'policy', 'setup', 'load'])(
  '%s mismatches stay out of direct comparisons', mismatch => {
    const e = create([row()]), r = tagged(e);
    if (mismatch === 'basis') r.force_recording.basis = 'legacy_elapsed';
    if (mismatch === 'recording-version') r.force_recording.version = 3;
    if (mismatch === 'policy') r.force_recording.failure_policy.version = 9;
    if (mismatch === 'setup') r.setup_id = 'different-edge';
    if (mismatch === 'load') r.avg_force_kg = 10.31;
    expect(comparison(e, [r])).toMatchObject({ points: [], changeSeconds: null, status: 'no_matches' });
  });

test('an earlier non-beta or interrupted workout blocks a later beta comparison', () => {
  const e = create([row()]);
  const earlier = row('2026-10-02', { failure_valid: false });
  const later = tagged(e, '2026-10-02', { id: 'later', session_id: 'later', session_started_at: '2026-10-02T18:00:00Z' });
  expect(comparison(e, [earlier, later]).points).toEqual([]);
});

test('no historical baseline requires no run-in or fabricated improvement', () => {
  const e = create();
  expect(planFor(e)).not.toBeNull();
  expect(comparison(e, [tagged(e)])).toMatchObject({ status: 'baseline_missing', meanTimeS: null,
    changeSeconds: null, changePercent: null, provisional: true });
  expect(buildVolumeBaseline({ history: [], grips: ['Micro'], startDate: '2026-10-01' }).byHand).toHaveLength(2);
});

test('validator rejects baseline leakage or altered means after serialization', () => {
  const e = create([row()]);
  for (const mutate of [b => { b.points[0].date = '2026-10-02'; }, b => { b.meanTimeS = 200; },
    b => { b.points.push({ ...b.points[0] }); }]) {
    const copy = JSON.parse(JSON.stringify(e));
    mutate(copy.baseline.byHand[0]);
    expect(isValidVolumeExperiment(copy)).toBe(false);
  }
  expect(isValidVolumeExperiment(JSON.parse(JSON.stringify(e)))).toBe(true);
});

test('malformed nested cloud baselines return false without throwing', () => {
  const e = create([row()]);
  const point = JSON.parse(JSON.stringify(e));
  point.baseline.byHand[0].points = [null];
  expect(isValidVolumeExperiment(point)).toBe(false);
  const hand = JSON.parse(JSON.stringify(e));
  hand.baseline.byHand[0] = null;
  expect(isValidVolumeExperiment(hand)).toBe(false);
  expect(volumeProgress(e, null, '2026-10-02').byGrip[0].started).toBe(0);
  expect(volumeComparison(e, null, '2026-10-02').byHand[0].status).toBe('no_matches');
});

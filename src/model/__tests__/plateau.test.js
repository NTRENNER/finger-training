import { detectPlateaus, plateauEnrollmentEvidence } from '../plateau.js';
const asOf = '2026-10-01', DAY = 86400000;
const shift = days => new Date(Date.parse(asOf) - days * DAY).toISOString().slice(0, 10);
const row = (date, hand = 'L', extra = {}) => ({ id: `${date}-${hand}`, date, hand, grip: 'Micro',
  session_id: date, session_started_at: `${date}T09:00:00Z`, rep_num: 1, set_num: 1,
  target_duration: 30, actual_time_s: 30, avg_force_kg: 20, peak_force_kg: 22,
  load_provenance: 'measured_force', failure_valid: true, failed: true, session_cooked: 2,
  force_recording: { version: 4, basis: 'target_acquired', signal_quality: 'complete', capacity_eligible: true }, ...extra });
const steady = () => Array.from({ length: 15 }, (_, w) => [1, 4].flatMap(d => ['L', 'R'].map(h => row(shift(w * 7 + d), h)))).flat();
const report = (history = steady(), extra = {}) => detectPlateaus({ history, asOf, ...extra });
const micro = r => r.byGrip[0];

test('a persistent bilateral plateau with consistent history offers an optional experiment', () => {
  const r = report(), g = micro(r);
  expect(g.eligibility.eligible).toBe(true);
  expect(g.recommendation).toBe('consider_volume_beta');
  expect(g.plateauZones).toEqual(['power']);
  expect(g.cells.filter(c => c.status === 'plateau')).toHaveLength(2);
  expect(g.cells.find(c => c.status === 'plateau').current).toMatchObject({ earlyS: 30, recentS: 30, changePct: 0 });
  expect(g.cells.find(c => c.status === 'plateau').current.earlyIds.length).toBeLessThanOrEqual(6);
});
test('a plateau in a new grip cannot use another grip to qualify for the beta invitation', () => {
  const prime = steady().filter(r => r.date >= shift(70)).map(r => ({ ...r, grip: 'Prime', id: `prime-${r.id}` }));
  // Historical Micro experience is sufficient on its own, before Prime began.
  const other = steady().map(r => row(new Date(Date.parse(r.date) - 100 * DAY).toISOString().slice(0, 10), r.hand));
  const result = report([...other, ...prime]);
  expect(micro(result).eligibility.eligible).toBe(true);
  const g = result.byGrip.find(g => g.grip === 'Prime');
  expect(g.cells.filter(c => c.status === 'plateau')).toHaveLength(2);
  expect(g.eligibility.hasThreeMonths).toBe(false);
  expect(g.blockers).toContain('beta_ineligible');
  expect(g.recommendation).toBe('continue_observing');
});
test.each([['improving', 1.2, 'progress_continues'], ['declining', 0.8, 'performance_declining']])('%s never prompts more volume', (status, factor, reason) => {
  const r = report(steady().map(r => ({ ...r, actual_time_s: r.date >= shift(28) ? 30 * factor : 30 })));
  expect(micro(r).cells.some(c => c.status === status)).toBe(true);
  expect(micro(r).blockers).toContain(reason);
  expect(micro(r).recommendation).toBe('continue_observing');
});
test('a recent flat patch needs the earlier confirmation window too', () => {
  const r = report(steady().map(r => ({ ...r, actual_time_s: r.date < shift(49) ? 20 : 30 })));
  expect(micro(r).recommendation).toBe('continue_observing');
});
test('reduced attendance, travel gaps and old observations do not diagnose a plateau', () => {
  const r = report(steady().filter(r => r.date < shift(25) || r.date > shift(5)));
  expect(micro(r).blockers).toContain('inconsistent_attendance');
  expect(micro(report(steady().filter(r => r.date < shift(20)))).cells.some(c => c.status === 'stale')).toBe(true);
});
test('large fluctuations remain uncertain rather than averaging to a flat result', () => {
  const r = report(steady().map((r, i) => ({ ...r, actual_time_s: i % 4 < 2 ? 20 : 40 })));
  expect(micro(r).cells.some(c => c.status === 'variable')).toBe(true);
  expect(micro(r).recommendation).toBe('continue_observing');
});
test.each(['basis', 'version', 'setup', 'handOrder', 'force'])('changed %s does not create comparable evidence', change => {
  const rows = steady().map(r => r.date < shift(28) ? r : ({ ...r,
    ...(change === 'setup' ? { setup_id: 'new' } : {}),
    ...(change === 'force' ? { avg_force_kg: 23 } : {}),
    force_recording: { ...r.force_recording, ...(change === 'basis' ? { basis: 'legacy_elapsed' } : {}),
      ...(change === 'version' ? { version: 5 } : {}),
      ...(change === 'handOrder' ? { hand_order: { first_hand: 'R' } } : {}) },
  }));
  expect(micro(report(rows)).recommendation).toBe('continue_observing');
});
test('later sessions across grips, additional sets, incomplete holds and fatigued Chaos reps cannot supply plateau evidence', () => {
  const rows = steady();
  expect(micro(report(rows.map(r => ({ ...r, set_num: 2 })))).recommendation).toBe('continue_observing');
  expect(micro(report(rows.map(r => ({ ...r, failure_valid: false })))).cells.every(c => c.status === 'insufficient')).toBe(true);
  const earlier = rows.map(r => ({ ...r, id: `before-${r.id}`, grip: 'Crusher', session_id: `before-${r.date}`, session_started_at: `${r.date}T08:00:00Z` }));
  const r = report([...rows, ...earlier]);
  expect(r.excluded.afterTraining).toBeGreaterThan(0);
  expect(micro(r).recommendation).toBe('continue_observing');
  const chaos = rows.map(r => ({ ...r, force_recording: { ...r.force_recording,
    session_protocol: { id: 'whole_curve_beta', version: 1, role: 'fatigued_hold', position: 2, zone: 'power' } } }));
  expect(micro(report(chaos)).cells.every(c => c.status === 'insufficient')).toBe(true);
});
test('a unilateral plateau cannot hide progress on the other hand', () => {
  const r = report(steady().map(r => ({ ...r, actual_time_s: r.hand === 'R' && r.date >= shift(28) ? 40 : 30 })));
  expect(micro(r).blockers).toContain('progress_continues');
});
test('fatigue, added sets, climbing increases and an existing experiment block invitations', () => {
  expect(micro(report(steady().map(r => ({ ...r, session_cooked: 7 })))).blockers).toContain('reported_fatigue');
  expect(micro(report([...steady(), row(shift(2), 'L', { id: 'extra', set_num: 2 })])).blockers).toContain('recent_dose_experiment');
  expect(micro(report(steady(), { activities: [{ date: shift(2), type: 'climbing', attempts: 15 }] })).blockers).toContain('climbing_increased');
  expect(micro(report(steady(), { experiments: { e: { startDate: shift(20), endDate: '2026-11-01', status: 'paused' } } })).blockers).toContain('existing_experiment');
});
test('duplicates and future records cannot manufacture confidence or change prior reviews', () => {
  const rows = steady(), expected = report(rows);
  const actual = report([...rows, ...rows, row('2027-01-01')]);
  expect(actual.byGrip).toEqual(expected.byGrip);
  expect(report(rows.map(r => ({ ...r, session_started_at: null }))).excluded.unknownOrder).toBeGreaterThan(0);
});
test('enrollment receipts are bounded and independent of later history', () => {
  const r = report(), receipt = plateauEnrollmentEvidence(r, ['Micro'], 'plateau_prompt');
  expect(receipt).toMatchObject({ version: 1, source: 'plateau_prompt', asOf });
  expect(receipt.byGrip).toHaveLength(1);
  expect(JSON.stringify(receipt).length).toBeLessThan(40000);
  report(steady().map(r => ({ ...r, actual_time_s: 100 })));
  expect(receipt.byGrip[0].cells[0].current.recentS).toBe(30);
});

test('non-failure holds and an invalid earlier session cannot become fresh plateau evidence', () => {
  expect(micro(report(steady().map(r => ({ ...r, failed: false, failure_valid: null })))).recommendation).toBe('continue_observing');
  const rows = steady();
  const earlier = rows.map(r => ({ ...r, id: `early-${r.id}`, session_id: `early-${r.date}`, session_started_at: `${r.date}T08:00:00Z`, failure_valid: false }));
  const conflicts = earlier.map(r => ({ ...r, avg_force_kg: 21 }));
  expect(micro(report([...rows, ...earlier, ...conflicts])).recommendation).toBe('continue_observing');
});

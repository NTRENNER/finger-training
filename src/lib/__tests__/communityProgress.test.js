import { communityComparison, communityProgress, communityPeaks, publicationCandidates, similarStart } from '../communityProgress.js';

const dates = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01'];
const rep = (date, extra = {}) => ({ id: date, grip: 'Crusher', hand: 'L', date, rep_num: 1,
  avg_force_kg: 40, peak_force_kg: 45.123456789, actual_time_s: 50,
  session_started_at: `${date}T12:00:00Z`, ...extra });
function overlay(ratios = [1, 1.02, 1.02, 0.95]) {
  return { baselineDate: dates[0], baselineAmps: [0, 0, 50], baselineMaxHoldS: 240, dates,
    ampsByDate: new Map(dates.map((d, i) => [d, [0, 0, 50 * ratios[i]]])),
    maxHoldByDate: new Map(dates.map(d => [d, 240])) };
}
const history = dates.map(date => rep(date));
test('balanced and six subdomains use existing comparisons; earned stars survive later dips', () => {
  const result = communityProgress(history, { Crusher: overlay() }, dates.at(-1));
  expect(result.current).toHaveLength(7);
  expect(result.stars).toHaveLength(14);
  expect(result.stars.every(s => s.achieved_date === dates[2] && s.prior_date === dates[1])).toBe(true);
  expect(result.current.every(p => Math.abs(p.percent + 5) < 1e-8)).toBe(true);
});
test('one qualifying date or a rounded 0.99% cannot earn a 1% star', () => {
  expect(communityProgress(history.slice(0, 2), { Crusher: overlay() }, dates[1]).stars).toEqual([]);
  expect(communityProgress(history, { Crusher: overlay([1, 1.0099, 1.0099, 1.0099]) }, dates.at(-1)).stars).toEqual([]);
});
test('eligible intervening decline resets confirmation; repeated crossings never duplicate', () => {
  expect(communityProgress(history, { Crusher: overlay([1, 1.02, 1, 1.02]) }, dates.at(-1)).stars).toEqual([]);
  const allHigh = communityProgress(history, { Crusher: overlay([1, 1.02, 1.02, 1.04]) }, dates.at(-1)).stars;
  expect(new Set(allHigh.map(s => s.achievement_key)).size).toBe(allHigh.length);
});
test('interrupted/manual-only dates and future rows cannot confirm improvement', () => {
  const interrupted = [history[0], history[1], rep(dates[2], { failure_valid: false }), rep(dates[3], { avg_force_kg: null })];
  expect(communityProgress(interrupted, { Crusher: overlay() }, dates.at(-1)).stars).toEqual([]);
  expect(communityProgress(history, { Crusher: overlay() }, dates[1]).stars).toEqual([]);
});
test('unsupported domains do not borrow future support or change balanced basis', () => {
  const sparse = { ...overlay(), baselineMaxHoldS: 30,
    maxHoldByDate: new Map([[dates[0], 30], [dates[1], 30], [dates[2], 240], [dates[3], 240]]) };
  expect(communityComparison(sparse, 'endurance', dates[1])).toBeNull();
  expect(communityComparison(sparse, 'endurance', dates[2]).baselineDate).toBe(dates[2]);
  expect(communityComparison(sparse, 'balanced', dates[3]).support).toEqual(['max_strength', 'power']);
  expect(communityProgress(history, { Crusher: sparse }, dates[3]).stars.some(s => s.metric === 'endurance')).toBe(false);
});
test('deleting the confirming evidence retracts its derived star identities', () => {
  expect(communityProgress(history.filter(r => r.date !== dates[2]), { Crusher: overlay() }, dates[3]).stars).toEqual([]);
});
test('publication has no history backfill, skips unknown timestamps and bundles lower stars', () => {
  const stars = communityProgress(history, { Crusher: overlay() }, dates[3]).stars;
  expect(publicationCandidates(stars, '2026-04-01T00:00:00Z')).toEqual([]);
  const selected = publicationCandidates(stars, '2026-02-01T00:00:00Z');
  expect(selected).toHaveLength(7);
  expect(selected.every(s => s.milestone_pct === 2)).toBe(true);
  expect(publicationCandidates(stars.map(s => ({ ...s, occurred_at: null })), dates[0])).toEqual([]);
  expect(publicationCandidates(stars, 'unknown')).toEqual([]);
  expect(publicationCandidates(stars.map(s => ({ ...s, occurred_at: 'unknown' })), dates[0])).toEqual([]);
  expect(publicationCandidates(stars.map(s => ({ ...s, occurred_at: '2026-05-01T00:00:00Z' })), '2026-04-01T00:00:00Z')).toEqual([]);
});
test('floating-point noise at an exact milestone cannot cause the database to reject the card', () => {
  const stars = communityProgress(history, { Crusher: overlay([1, 1.05, 1.05, 1.05]) }, dates[3]).stars;
  expect(stars.some(s => s.milestone_pct === 5)).toBe(true);
  expect(stars.every(s => s.improvement_pct >= s.milestone_pct)).toBe(true);
});
test('similar starts require the same grip/domain/support and a baseline within 25%', () => {
  const current = [{ grip: 'Crusher', metric: 'power', support: ['power'], before: 40 }];
  const card = { grip: 'Crusher', metric: 'power', support_keys: ['power'], baseline_force_kg: 50 };
  expect(similarStart(card, current)).toBe(true);
  for (const patch of [{ grip: 'Prime' }, { support_keys: ['endurance'] }, { baseline_force_kg: 51 }]) expect(similarStart({ ...card, ...patch }, current)).toBe(false);
});
test('peak snapshots preserve precision and separate grip/hand using valid measured evidence', () => {
  const rows = [rep(dates[0]), rep(dates[1], { hand: 'R', peak_force_kg: 50 }),
    rep(dates[1], { grip: 'Prime', peak_force_kg: 60 }),
    rep(dates[2], { failure_valid: false, peak_force_kg: 90 }),
    rep(dates[2], { load_provenance: 'manual', peak_force_kg: 95 }),
    rep('2027-01-01', { peak_force_kg: 100 })];
  expect(communityPeaks(rows, dates[3])).toEqual([
    { grip: 'Crusher', hand: 'L', peak_kg: 45.123456789, measured_date: dates[0] },
    { grip: 'Crusher', hand: 'R', peak_kg: 50, measured_date: dates[1] },
    { grip: 'Prime', hand: 'L', peak_kg: 60, measured_date: dates[1] },
  ]);
});
test('valid Peak Test is eligible despite not being failure evidence; redo/invalid Peak Test is excluded', () => {
  const peak = rep(dates[1], { failure_valid: false, end_reason: 'peak_test_complete', load_provenance: 'measured_force',
    force_recording: { peak_valid: true, session_protocol: { id: 'peak_test', version: 2 } } });
  expect(communityPeaks([peak], dates[3])).toHaveLength(1);
  expect(communityPeaks([{ ...peak, end_reason: 'user_interruption' }], dates[3])).toEqual([]);
});

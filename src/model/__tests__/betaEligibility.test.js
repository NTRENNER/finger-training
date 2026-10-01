import { betaEligibility } from '../betaEligibility.js';
const DAY = 86400000, asOf = '2026-10-01';
const row = (date, extra = {}) => ({ date, grip: 'Micro', hand: 'L', target_duration: 30,
  actual_time_s: 30, avg_force_kg: 20, peak_force_kg: 22, ...extra });
const shift = n => new Date(Date.parse(asOf) - n * DAY).toISOString().slice(0, 10);
const consistent = () => [row('2026-07-01'), ...Array.from({ length: 10 }, (_, w) =>
  [row(shift(w * 7 + 1)), row(shift(w * 7 + 4))]).flat()];

test('requires three calendar months AND ten weeks with two distinct training days', () => {
  expect(betaEligibility(consistent(), asOf)).toMatchObject({ eligible: true, qualifyingWeeks: 10, hasThreeMonths: true });
  expect(betaEligibility(consistent().slice(1), asOf)).toMatchObject({ eligible: false, hasThreeMonths: false });
  expect(betaEligibility([row('2020-01-01')], asOf).eligible).toBe(false);
  expect(betaEligibility(consistent().filter(r => r.date !== shift(1)), asOf)).toMatchObject({ eligible: false, qualifyingWeeks: 9 });
});
test('extra hands, grips, sets and sessions cannot inflate attendance', () => {
  const rows = Array.from({ length: 13 }, (_, i) => row(shift(i * 7 + 1)));
  const duplicates = rows.flatMap(r => ['L', 'R'].flatMap(hand => ['Micro', 'Crusher'].flatMap(grip =>
    [1, 2].map(set_num => ({ ...r, hand, grip, set_num, session_id: `${grip}-${set_num}` })))));
  expect(betaEligibility([row('2026-06-01'), ...duplicates], asOf).qualifyingWeeks).toBe(0);
});
test('attendance includes real interrupted work and manual sessions, unlike curve eligibility', () => {
  const rows = consistent().map(r => ({ ...r, failure_valid: false, force_recording: { signal_quality: 'incomplete' } }));
  expect(betaEligibility(rows, asOf).eligible).toBe(true);
});
test('excludes peak-only, seed, empty, malformed, future and current-day records', () => {
  const rows = consistent();
  for (const transform of [r => ({ ...r, target_duration: 3 }),
    r => ({ ...r, force_recording: { session_protocol: { id: 'peak_test' } } }),
    r => ({ ...r, peak_force_kg: r.avg_force_kg }),
    r => ({ ...r, actual_time_s: 0 }), r => ({ ...r, date: asOf }),
    r => ({ ...r, date: '2026-10-02' }), r => ({ ...r, date: '2026-02-30' }),
    r => ({ ...r, hand: null }), r => ({ ...r, grip: 'Tendon' })]) {
    expect(betaEligibility(rows.map(transform), asOf).eligible).toBe(false);
  }
  expect(betaEligibility([null, {}, ...rows], asOf).eligible).toBe(true);
  expect(betaEligibility(null, 'invalid').eligible).toBe(false);
});
test('three-month anniversary clamps at month end and rolling weeks use dates across DST', () => {
  expect(betaEligibility([row('2026-02-28')], '2026-05-31').hasThreeMonths).toBe(true);
  expect(betaEligibility([row('2026-03-01')], '2026-05-31').hasThreeMonths).toBe(false);
  expect(betaEligibility([row('2026-03-07'), row('2026-03-08')], '2026-03-10').weeklyDays[0]).toBe(2);
});
test('eligibility expires with inactivity; saved experiment metadata cannot substitute for attendance', () => {
  expect(betaEligibility(consistent(), '2027-01-01').eligible).toBe(false);
});

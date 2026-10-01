import { betaEligibility } from '../betaEligibility.js';
const DAY = 86400000, asOf = '2026-10-01';
const row = (date, extra = {}) => ({ date, grip: 'Micro', hand: 'L', target_duration: 30,
  actual_time_s: 30, avg_force_kg: 20, peak_force_kg: 22, ...extra });
const shift = n => new Date(Date.parse(asOf) - n * DAY).toISOString().slice(0, 10);
const consistent = () => [row('2026-07-01'), ...Array.from({ length: 10 }, (_, w) =>
  [row(shift(w * 7 + 1)), row(shift(w * 7 + 4))]).flat()];

test('each grip earns its own attendance and three-month history', () => {
  const history = [...consistent(), row(shift(2), { grip: 'Prime' })];
  expect(betaEligibility(history, asOf, 'Micro').eligible).toBe(true);
  expect(betaEligibility(history, asOf, 'Prime')).toMatchObject({ eligible: false, hasThreeMonths: false, qualifyingWeeks: 0 });
  expect(betaEligibility(history, asOf, 'Crusher').eligible).toBe(false);
  expect(betaEligibility(history, asOf).eligible).toBe(false);
  expect(betaEligibility(history, asOf, 'unknown').eligible).toBe(false);
  const recentPrime = consistent().slice(1).map(r => ({ ...r, grip: 'Prime' }));
  expect(betaEligibility([...consistent(), ...recentPrime], asOf, 'Prime')).toMatchObject({ eligible: false, hasThreeMonths: false });
  expect(betaEligibility(consistent().map(r => ({ ...r, grip: 'Prime' })), asOf, 'Prime').eligible).toBe(true);
});
test('alternating grips on different days cannot pool their weekly attendance', () => {
  const history = consistent().map((r, i) => ({ ...r, grip: i % 2 ? 'Micro' : 'Crusher' }));
  expect(betaEligibility(history, asOf, 'Micro').eligible).toBe(false);
  expect(betaEligibility(history, asOf, 'Crusher').eligible).toBe(false);
});

test('requires three calendar months AND ten weeks with two distinct training days', () => {
  expect(betaEligibility(consistent(), asOf, 'Micro')).toMatchObject({ eligible: true, qualifyingWeeks: 10, hasThreeMonths: true });
  expect(betaEligibility(consistent().slice(1), asOf, 'Micro')).toMatchObject({ eligible: false, hasThreeMonths: false });
  expect(betaEligibility([row('2020-01-01')], asOf, 'Micro').eligible).toBe(false);
  expect(betaEligibility(consistent().filter(r => ![shift(1), shift(4)].includes(r.date)), asOf, 'Micro')).toMatchObject({ eligible: false, qualifyingWeeks: 9 });
});
test('extra hands, grips, sets and sessions cannot inflate attendance', () => {
  const rows = Array.from({ length: 13 }, (_, i) => row(shift(i * 7 + 1)));
  const duplicates = rows.flatMap(r => ['L', 'R'].flatMap(hand => ['Micro', 'Crusher'].flatMap(grip =>
    [1, 2].map(set_num => ({ ...r, hand, grip, set_num, session_id: `${grip}-${set_num}` })))));
  expect(betaEligibility([row('2026-06-01'), ...duplicates], asOf, 'Micro').qualifyingWeeks).toBe(0);
});
test('attendance includes real interrupted work and manual sessions, unlike curve eligibility', () => {
  const rows = consistent().map(r => ({ ...r, failure_valid: false, force_recording: { signal_quality: 'incomplete' } }));
  expect(betaEligibility(rows, asOf, 'Micro').eligible).toBe(true);
});
test('excludes peak-only, seed, empty, malformed, future and current-day records', () => {
  const rows = consistent();
  for (const transform of [r => ({ ...r, target_duration: 3 }),
    r => ({ ...r, force_recording: { session_protocol: { id: 'peak_test' } } }),
    r => ({ ...r, peak_force_kg: r.avg_force_kg }),
    r => ({ ...r, actual_time_s: 0 }), r => ({ ...r, date: asOf }),
    r => ({ ...r, date: '2026-10-02' }), r => ({ ...r, date: '2026-02-30' }),
    r => ({ ...r, hand: null }), r => ({ ...r, grip: 'Tendon' })]) {
    expect(betaEligibility(rows.map(transform), asOf, 'Micro').eligible).toBe(false);
  }
  expect(betaEligibility([null, {}, ...rows], asOf, 'Micro').eligible).toBe(true);
  expect(betaEligibility(null, 'invalid', 'Micro').eligible).toBe(false);
});
test('three-month anniversary clamps at month end and rolling weeks use dates across DST', () => {
  expect(betaEligibility([row('2026-02-28')], '2026-05-31', 'Micro').hasThreeMonths).toBe(true);
  expect(betaEligibility([row('2026-03-01')], '2026-05-31', 'Micro').hasThreeMonths).toBe(false);
  expect(betaEligibility([row('2026-03-07'), row('2026-03-08')], '2026-03-10', 'Micro').weeklyDays[0]).toBe(2);
});
test('earned eligibility survives travel, reduced frequency and a long break', () => {
  for (const date of ['2026-11-01', '2027-01-01', '2030-01-01']) {
    expect(betaEligibility(consistent(), date, 'Micro')).toMatchObject({ eligible: true, qualifyingWeeks: 10 });
  }
  expect(betaEligibility(consistent(), '2027-01-01', 'Micro').recentQualifyingWeeks).toBe(0);
});
test('account changes and deleted history cannot inherit an earned unlock', () => {
  expect(betaEligibility(consistent(), asOf, 'Micro').eligible).toBe(true);
  expect(betaEligibility([], asOf, 'Micro').eligible).toBe(false);
  expect(betaEligibility(consistent().filter(r => ![shift(1), shift(4)].includes(r.date)), asOf, 'Micro').eligible).toBe(false);
});
test('sporadic weeks spread over years cannot add up to a consistent 13-week period', () => {
  const rows = Array.from({ length: 12 }, (_, month) =>
    [row(`2025-${String(month + 1).padStart(2, '0')}-01`), row(`2025-${String(month + 1).padStart(2, '0')}-03`)]).flat();
  expect(betaEligibility(rows, asOf, 'Micro').eligible).toBe(false);
});
test('historical window search matches daily replay across arbitrary week boundaries', () => {
  const rows = Array.from({ length: 180 }, (_, n) => n).filter(n => n % 11 < 3 || n % 17 === 0).map(n => row(shift(n + 1)));
  const dates = [...new Set(rows.map(r => Date.parse(r.date)))];
  let best = 0;
  for (let end = Math.min(...dates) + DAY; end <= Date.parse(asOf); end += DAY) {
    const weeks = Array.from({ length: 13 }, (_, w) =>
      dates.filter(d => d >= end - (w + 1) * 7 * DAY && d < end - w * 7 * DAY).length);
    best = Math.max(best, weeks.filter(n => n >= 2).length);
  }
  expect(betaEligibility(rows, asOf, 'Micro').qualifyingWeeks).toBe(best);
});

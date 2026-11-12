import { communityImprovementSnapshots, communityBaselineBand, communityGroupKey } from '../communityRankings.js';
import { communityComparison } from '../communityProgress.js';

const dates = ['2026-01-01', '2026-11-09', '2026-11-11'];
const history = dates.map(date => ({ id: date, date, grip: 'Crusher', hand: 'L', rep_num: 1,
  avg_force_kg: 40, peak_force_kg: 45, actual_time_s: 50 }));
const overlay = (ratios = [1, 1.02, 1.05]) => ({
  baselineDate: dates[0], baselineAmps: [0, 0, 50], baselineMaxHoldS: 240, dates,
  ampsByDate: new Map(dates.map((date, i) => [date, [0, 0, ratios[i] * 50]])),
  maxHoldByDate: new Map(dates.map(date => [date, 240])),
});
test('uses original baseline and latest day, with no weekly or eight-week cutoff', () => {
  const source = overlay();
  const rows = communityImprovementSnapshots(history, { Crusher: source }, dates[2]);
  expect(rows).toHaveLength(7);
  for (const row of rows) {
    expect(row.baseline_date).toBe(dates[0]);
    expect(row.measured_date).toBe(dates[2]);
    expect(row.improvement_pct).toBeCloseTo(5, 8);
    expect(row.milestone_pct).toBe(2);
    expect(row.baseline_force_kg).toBeCloseTo(communityComparison(source, row.metric, dates[2]).before, 8);
  }
  expect(source.baselineAmps).toEqual([0, 0, 50]);
});
test('new eligible estimate changes ranks without awarding an unconfirmed higher star', () => {
  const rows = communityImprovementSnapshots(history, { Crusher: overlay([1, 1.02, 1.15]) }, dates[2]);
  expect(rows.every(r => Math.abs(r.improvement_pct - 15) < 1e-8 && r.milestone_pct === 2)).toBe(true);
});
test('drops disputed, future and single-date gains rather than preserving a stale high score', () => {
  expect(communityImprovementSnapshots(history, { Crusher: overlay() }, dates[1])).toEqual([]);
  expect(communityImprovementSnapshots(history.map(r => r.date === dates[2] ? { ...r, failure_valid: false } : r), { Crusher: overlay() }, dates[2])).toEqual([]);
  expect(communityImprovementSnapshots(history, { Crusher: overlay([1, 1.02, 0.9]) }, dates[2])).toEqual([]);
  expect(communityImprovementSnapshots(history.slice(0, 2), { Crusher: overlay() }, dates[2])).toEqual([]);
});
test('unsupported zones stay out; cohort basis remains the supported balanced baseline', () => {
  const sparse = { ...overlay(), baselineMaxHoldS: 30, maxHoldByDate: new Map(dates.map(d => [d, 30])) };
  const rows = communityImprovementSnapshots(history, { Crusher: sparse }, dates[2]);
  expect(rows.map(r => r.metric)).toEqual(['balanced', 'max_strength', 'power']);
  expect(rows.every(r => r.support_keys.join(',') === 'max_strength,power')).toBe(true);
});
test('later-supported domains must confirm against their own baseline on two subsequent dates', () => {
  const sparse = { ...overlay(), baselineMaxHoldS: 30, maxHoldByDate: new Map([[dates[0], 30], [dates[1], 240], [dates[2], 240]]) };
  expect(communityImprovementSnapshots(history, { Crusher: sparse }, dates[2]).some(r => r.metric === 'endurance')).toBe(false);
});
test('unrounded 0.99% is not a 1% milestone and malformed curves never publish', () => {
  expect(communityImprovementSnapshots(history, { Crusher: overlay([1, 1.0099, 1.0099]) }, dates[2])).toEqual([]);
  expect(communityImprovementSnapshots(history, { Crusher: overlay([1, 1.05, NaN]) }, dates[2])).toEqual([]);
});
test('cohorts preserve physical units and distinguish duration coverage', () => {
  expect(communityBaselineBand(39.99)).toBe(30);
  expect(communityBaselineBand(40)).toBe(40);
  expect(communityBaselineBand(30 - Number.EPSILON * 10)).toBe(30);
  expect(communityGroupKey({ baseline_band: 30, support_keys: ['max_strength', 'power'] })).not.toBe(
    communityGroupKey({ baseline_band: 30, support_keys: ['max_strength'] }));
});

import {
  backgroundComparison, fixedLoadRepeats, frozenYardstick, openerResiduals, pilotReport, pilotWindows,
  trainingExposure, trendChange, weeklyBackground,
} from '../pilotAnalysis.js';

// A synthetic athlete on a known curve. Before the pilot every opener sits on
// it; during the long-end block, long holds climb 1% per session.
const F = T => 30 * Math.exp(-T / 10) + 12 * Math.exp(-T / 30) + 6 * Math.exp(-T / 480);
const opener = (date, hand, T, scale = 1, extra = {}) => ({
  id: `${date}-${hand}-${T}`, session_id: `${date}-${T}`, date, grip: 'Micro', hand, set_num: 1, rep_num: 1,
  target_duration: T, actual_time_s: T, avg_force_kg: F(T) * scale, prescribed_load_kg: Math.round(F(T) * 10) / 10,
  load_provenance: 'measured_force', failure_valid: true, ...extra,
});
const before = ['2026-09-12', '2026-09-20', '2026-09-28', '2026-10-06', '2026-10-14', '2026-10-22', '2026-10-30']
  .flatMap((date, i) => ['L', 'R'].map(hand => opener(date, hand, [20, 70, 115, 160, 220, 30, 115][i])));
const blockDays = ['2026-11-03', '2026-11-07', '2026-11-11', '2026-11-15', '2026-11-19', '2026-11-23'];
const during = blockDays.flatMap((date, i) => ['L', 'R'].map(hand => opener(date, hand, [115, 160, 220][i % 3], 1 + 0.01 * i)));
const reps = [...before, ...during];

test('windows: two coverage-rotation windows, then the pilot blocks', () => {
  expect(pilotWindows().map(w => [w.id, w.start, w.end])).toEqual([
    ['coverage-1', '2026-09-10', '2026-10-07'], ['coverage-2', '2026-10-08', '2026-11-01'],
    ['block-B', '2026-11-02', '2026-11-29'], ['block-A', '2026-11-30', '2026-12-27'],
    ['block-R', '2026-12-28', '2027-01-24'],
  ]);
});

test('the yardstick is fitted only on openers before the pilot and fits them closely', () => {
  const yardstick = frozenYardstick(reps, '2026-11-02');
  expect(yardstick.curves.Micro.L).toMatchObject({ n: 7, days: 7 });
  const residuals = openerResiduals(before, yardstick);
  expect(Math.max(...residuals.map(r => Math.abs(r.pct)))).toBeLessThan(0.03);
  // Adding pilot data does not move it.
  expect(frozenYardstick(before, '2026-11-02')).toEqual(yardstick);
});

test('openers carry their end of the curve, days since the grip trained, and same-day climbing', () => {
  const yardstick = frozenYardstick(reps, '2026-11-02');
  const climbs = [{ type: 'climbing', date: '2026-11-07', rpe: 7 }, { type: 'climbing', date: '2026-11-07', rpe: 6 }];
  const rows = openerResiduals(reps, yardstick, { activities: climbs }).filter(r => r.date >= '2026-11-03');
  expect(rows.find(r => r.date === '2026-11-07')).toMatchObject({ end: 'long', days_since_grip: 4 });
  expect(rows.find(r => r.date === '2026-11-07').climbing_score).toBeGreaterThan(0);
  expect(rows.find(r => r.date === '2026-11-03').climbing_score).toBe(0);
  expect(rows.at(-1).pct).toBeGreaterThan(0.03);
});

test('the long end rises across the block and the trend needs at least three days', () => {
  const report = pilotReport({ reps }, { asOf: '2026-11-29' });
  const long = report.ends['block-B'].long.all;
  expect(long.change).toBeGreaterThan(0.03);
  expect(long.low).toBeLessThanOrEqual(long.change);
  expect(long.high).toBeGreaterThanOrEqual(long.change);
  expect(report.ends['block-B'].short.all.change).toBeNull();
  const twoDays = trendChange(report.openers.filter(r => r.date <= '2026-11-07'), report.windows[2]);
  expect(twoDays.change).toBeNull();
  expect(report.balanced['block-B'].change).toBeGreaterThan(0);
  expect(Math.abs(report.balanced['coverage-1'].change)).toBeLessThan(0.03);
});

test('same-load repeats compare first-rep hold time directly', () => {
  const repeat = [opener('2026-11-03', 'L', 115), { ...opener('2026-11-17', 'L', 115), actual_time_s: 127 }];
  expect(fixedLoadRepeats(repeat, pilotWindows())).toEqual([expect.objectContaining({
    window: 'block-B', grip: 'Micro', hand: 'L', target_s: 115, first: { date: '2026-11-03', t_s: 115 },
    last: { date: '2026-11-17', t_s: 127 }, change: 0.104 })]);
});

test('exposure counts every qualifying hold, later reps included, and skips Peak Tests', () => {
  const later = { ...opener('2026-11-03', 'L', 160), rep_num: 2, actual_time_s: 90 };
  const peak = { ...opener('2026-11-03', 'L', 3), force_recording: { session_protocol: { id: 'peak_test', version: 2 } } };
  const exposure = trainingExposure([...during, later, peak], pilotWindows())['block-B'].Micro;
  expect(exposure).toMatchObject({ sessions: 6, holds: 13, long_end_holds: 13 });
  expect(exposure.by_domain).toMatchObject({ strength: 4, strength_endurance: 5, endurance: 4 });
});

test('weekly background load is compared between blocks and a large difference is flagged', () => {
  const climbs = [
    ...['2026-11-02', '2026-11-04', '2026-11-09', '2026-11-11'].map(date => ({ type: 'climbing', date, rpe: 7 })),
    ...['2026-12-01'].map(date => ({ type: 'climbing', date, rpe: 7 })),
  ];
  const weeks = weeklyBackground(during, climbs, [{ date: '2026-11-05', workout: 'A' }], { start: '2026-11-02', end: '2026-12-13' });
  expect(weeks[0]).toMatchObject({ start: '2026-11-02', end: '2026-11-08', climbing_days: 2, support_workouts: 1, finger_sessions: 2 });
  const blocks = pilotWindows().filter(w => w.id.startsWith('block-'));
  expect(backgroundComparison(weeks, blocks).mismatched).toContain('climbing_days');
});

test('a peak test is the best of its pulls; a slipped pull does not move the trend', () => {
  const { peakChanges } = require('../pilotAnalysis.js');
  const pull = (date, kg) => ({ date, grip: 'Crusher', hand: 'R', peak_force_kg: kg, end_reason: 'peak_test_complete',
    force_recording: { session_protocol: { id: 'peak_test', version: 2 }, peak_valid: true } });
  const steady = ['2026-11-03', '2026-11-10', '2026-11-17', '2026-11-24'].flatMap(d => [pull(d, 70), pull(d, 71)]);
  const window = pilotWindows().find(w => w.id === 'block-B');
  expect(peakChanges([...steady, pull('2026-11-24', 8.1)], [window])['block-B'].all.change)
    .toBeCloseTo(peakChanges(steady, [window])['block-B'].all.change, 6);
  expect(Math.abs(peakChanges(steady, [window])['block-B'].all.change)).toBeLessThan(0.01);
});

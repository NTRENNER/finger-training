import { averagedAnchorAmps, evaluateCapacityTrends, fitEstablishedTrend, pairedDayInterval,
  trendDuration, trendPoints } from '../capacityTrendExperiment.js';
import { predForceThreeExp } from '../threeExp.js';
import { recoveryRows, RECOVERY_ROW_SHAPES } from '../../testHelpers/recoveryRows.js';

const history = () => Array.from({ length: 8 }, (_, i) => recoveryRows('legacy', {
  date: `2026-08-${String(i + 1).padStart(2, '0')}`, sessionId: `day-${i}`,
})).flat();

test('all forecasts use strictly earlier days, including priors and recent trend', () => {
  const base = history();
  const before = evaluateCapacityTrends(base);
  const extra = ['2026-08-08', '2026-09-20'].flatMap(date => recoveryRows('measured', { date, sessionId: `extra-${date}` })
    .map(r => ({ ...r, avg_force_kg: 90, actual_time_s: 160 })));
  const after = evaluateCapacityTrends([...base, ...extra]);
  expect(before.observations.length).toBe(3);
  expect(after.observations.filter(r => r.session.startsWith('day-'))).toEqual(before.observations);
  expect(fitEstablishedTrend([...base, ...extra], 'L', 'Crusher', '2026-08-08'))
    .toEqual(fitEstablishedTrend(base, 'L', 'Crusher', '2026-08-08'));
});

test('held-out force changes scores, not coefficients or predicted force at its unchanged duration', () => {
  const base = history();
  const a = evaluateCapacityTrends(base).observations.filter(r => r.date === '2026-08-08');
  const b = evaluateCapacityTrends(base.map(r => r.date === '2026-08-08'
    ? { ...r, avg_force_kg: 25, peak_force_kg: 27 } : r)).observations.filter(r => r.date === '2026-08-08');
  expect(b[0].actual).not.toBe(a[0].actual);
  expect(b.map(r => r.predictions)).toEqual(a.map(r => r.predictions));
  expect(b.map(r => r.plannedTimePredictions)).toEqual(a.map(r => r.plannedTimePredictions));
});

test.each(RECOVERY_ROW_SHAPES)('storage shape %s is not normalized into false measurement evidence', shape => {
  const rows = recoveryRows(shape, { date: '2026-08-09', sessionId: 'test-shape' });
  const result = evaluateCapacityTrends([...history(), ...rows]);
  expect(result.observations.filter(r => r.session === 'test-shape').length)
    .toBe(['manual', 'interrupted'].includes(shape) ? 0 : 1);
});

test('duplicates cannot alter results, and repeated identical sessions on one day add no fit weight', () => {
  const base = history();
  expect(evaluateCapacityTrends([...base, ...base]).observations).toEqual(evaluateCapacityTrends(base).observations);
  const reps = base.filter(r => r.rep_num === 1);
  const points = trendPoints(reps, 90);
  const copies = trendPoints([...reps, ...reps], 90);
  expect(copies.reduce((s, p) => s + p.w, 0)).toBeCloseTo(points.reduce((s, p) => s + p.w, 0));
});

test('interval changes align from prior history; missing acquisition cannot be scored', () => {
  const newer = recoveryRows('measured', { date: '2026-08-09', sessionId: 'newer' }).map(r => ({ ...r,
    end_reason: 'target_force_failure',
    force_recording: { ...r.force_recording, basis: 'target_acquired', acquisition_s: 0.8 } }));
  const a = evaluateCapacityTrends([...history(), ...newer]);
  expect(a.observations.find(r => r.session === 'newer').duration).toBe(40.8);
  const b = evaluateCapacityTrends([...history(), ...newer.map(r => ({ ...r,
    force_recording: { ...r.force_recording, acquisition_s: null } }))]);
  expect(b.observations.find(r => r.session === 'newer')).toBeUndefined();
});

test('curves stay positive and monotone and no new workout means no artificial capacity decay', () => {
  const a = fitEstablishedTrend(history(), 'L', 'Crusher', '2026-08-09');
  const b = fitEstablishedTrend(history(), 'L', 'Crusher', '2027-01-01');
  expect(a).toEqual(b);
  for (const amps of [a.established, a.establishedRecent, a.recent]) {
    let prev = Infinity;
    for (const t of [0, 3, 30, 70, 115, 160, 220, 600]) {
      const force = predForceThreeExp(amps, t);
      expect(force).toBeGreaterThan(0);
      expect(force).toBeLessThanOrEqual(prev);
      prev = force;
    }
  }
});

test('a single dip has smaller influence than repeated decline, and gains are admitted', () => {
  const base = history();
  const newDays = force => Array.from({ length: 8 }, (_, i) => recoveryRows('measured', {
    date: `2026-08-${String(i + 10).padStart(2, '0')}`, sessionId: `shift-${i}`,
  }).map(r => ({ ...r, avg_force_kg: force, peak_force_kg: force + 2 }))).flat();
  const force = rows => predForceThreeExp(fitEstablishedTrend(rows, 'L', 'Crusher', '2026-09-01').established, 40);
  const initial = force(base);
  const once = force([...base, ...newDays(20).slice(0, 4)]);
  const sustained = force([...base, ...newDays(20)]);
  expect(initial - once).toBeLessThan(initial - sustained);
  expect(sustained).toBeLessThan(initial * 0.85);
  expect(force([...base, ...newDays(40)])).toBeGreaterThan(initial);
});

test('time inversion marks out-of-range values; fits are not made to win', () => {
  const amps = [20, 30, 10];
  expect(trendDuration(amps, predForceThreeExp(amps, 60)).seconds).toBeCloseTo(60, 8);
  expect(trendDuration(amps, 100).status).toBe('above_curve');
  expect(trendDuration(amps, 0.1).status).toBe('beyond_600s');
  const rs = [{ date: '2026-08-01', actual: 10, predictions: { current: 10, m: 15 } },
    { date: '2026-08-02', actual: 10, predictions: { current: 10, m: 15 } }];
  expect(pairedDayInterval(rs, 'm')).toMatchObject({ deltaMae: 5, interval95: [5, 5] });
  expect(averagedAnchorAmps(amps, [])).toEqual(amps);
  expect(evaluateCapacityTrends([]).standard.curves.matchedObservations).toBe(0);
});

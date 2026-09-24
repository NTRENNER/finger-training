import { selectRecentSessions, fitEstablishedTrend } from '../capacityTrendFit.js';
import { evaluateCapacityWindows } from '../capacityWindowExperiment.js';
const rows = Array.from({ length: 36 }, (_, i) => ['L', 'R'].map(hand => ({
  id: `${i}-${hand}`, session_id: `s${i}`, date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10),
  grip: 'Micro', hand, rep_num: 1, set_num: 1, target_duration: [30, 70, 115, 160, 220][i % 5],
  actual_time_s: [30, 70, 115, 160, 220][i % 5], avg_force_kg: 40 - (i % 5) * 5,
  prescribed_load_kg: 40 - (i % 5) * 5,
}))).flat();
test('a 30-session window retains both hands and ignores input order', () => {
  const selected = selectRecentSessions(rows, 30);
  expect(selected).toHaveLength(60);
  expect(new Set(selected.map(r => r.session_id)).size).toBe(30);
  expect(selected.some(r => r.session_id === 's5')).toBe(false);
  expect(new Set(selectRecentSessions([...rows].reverse(), 30).map(r => r.id)))
    .toEqual(new Set(selected.map(r => r.id)));
});
test('both fits ignore same-day and future outcomes, with independent-day minimum', () => {
  for (const options of [{}, { sessionWindow: 30 }]) {
    const fit = fitEstablishedTrend(rows, 'L', 'Micro', '2026-02-01', options);
    const mutated = rows.map(r => r.date >= '2026-02-01' ? { ...r, avg_force_kg: 900 } : r);
    expect(fitEstablishedTrend(mutated, 'L', 'Micro', '2026-02-01', options)).toEqual(fit);
    expect(fitEstablishedTrend(rows.map(r => ({ ...r, date: '2026-01-01' })), 'L', 'Micro', '2026-02-01', options)).toBeNull();
  }
});
test('comparison reports matched observations with strict cutoffs and duplicate immunity', () => {
  const report = evaluateCapacityWindows(rows);
  expect(report.observations.length).toBeGreaterThan(0);
  expect(report.observations.every(r => r.newestPriorDate < r.date)).toBe(true);
  expect(report.overall.curve.metrics.current.observations).toBe(report.overall.curve.metrics.last30.observations);
  expect(evaluateCapacityWindows([...rows, ...rows]).overall).toEqual(report.overall);
});

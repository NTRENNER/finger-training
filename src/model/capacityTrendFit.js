// Shared experimental fit; used by offline evaluation and frozen shadow forecasts only.
import { freshFitReps, sane } from './load.js';
import { loadProvenance } from './forceRecording.js';
import { fitThreeExpAmps } from './threeExp.js';
import { prepareEvaluationRows } from './evaluationRows.js';

export const TREND_EXPERIMENT = Object.freeze({ version: 1, longHalfLifeDays: 90,
  recentHalfLifeDays: 14, anchorHalfLifeDays: 42, recentRidge: 3, recentBlend: 0.25,
  minPriorDays: 5, legacyWeight: 0.5 });
const grouped = (rows, key) => {
  const out = new Map();
  for (const row of rows) {
    const k = key(row);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(row);
  }
  return out;
};
const measured = r => sane(r.avg_force_kg) != null && r.actual_time_s > 0 && r.actual_time_s <= 600
  && ['legacy_measured', 'measured_force'].includes(loadProvenance(r));
const weightQuality = r => loadProvenance(r) === 'legacy_measured' ? TREND_EXPERIMENT.legacyWeight : 1;

// One day's repetitions cannot manufacture extra confidence. Within each day,
// average the rows' contributions; quality never increases the weight above 1.
export function trendPoints(rows, halfLifeDays, quality = true) {
  const days = [...grouped(rows, r => r.date).entries()].sort(([a], [b]) => a.localeCompare(b));
  if (!days.length) return [];
  const latest = Date.parse(days.at(-1)[0]);
  return days.flatMap(([date, rs]) => {
    const recency = 2 ** (-(latest - Date.parse(date)) / 86400000 / halfLifeDays);
    return rs.map(r => ({ T: r.actual_time_s, F: r.avg_force_kg,
      w: recency * (quality ? weightQuality(r) : 1) / rs.length }));
  });
}
const sumWeight = pts => pts.reduce((s, p) => s + p.w, 0);

export function selectRecentSessions(rows, count) {
  if (!Number.isInteger(count) || count <= 0) throw new Error('Session count must be a positive integer');
  const key = r => `${r.date}|${r.session_id || r.date}`;
  const sessions = [...grouped(rows, key)].sort(([ka, a], [kb, b]) =>
    a[0].date.localeCompare(b[0].date)
    || String(a[0].session_started_at || '').localeCompare(String(b[0].session_started_at || ''))
    || ka.localeCompare(kb));
  return sessions.slice(-count).flatMap(([, rs]) => rs);
}

export function fitEstablishedTrend(history, hand, grip, referenceDate, { sessionWindow = null } = {}) {
  // Enforce the cutoff here too, so direct callers cannot leak the test date.
  const clean = prepareEvaluationRows(history).rows.filter(r => r.date < referenceDate);
  const eligible = freshFitReps(clean).filter(r => r.grip === grip && measured(r));
  const all = sessionWindow == null ? eligible : selectRecentSessions(eligible, sessionWindow);
  const own = all.filter(r => r.hand === hand);
  const days = new Set(own.map(r => r.date)).size;
  if (days < TREND_EXPERIMENT.minPriorDays) return null;
  const points = trendPoints(own, sessionWindow == null ? TREND_EXPERIMENT.longHalfLifeDays : Infinity);
  const pooled = trendPoints(all, sessionWindow == null ? TREND_EXPERIMENT.longHalfLifeDays : Infinity);
  const prior = fitThreeExpAmps(pooled);
  const effectiveDays = sumWeight(points);
  const established = fitThreeExpAmps(points, { prior, lambda: 100 / effectiveDays });
  const recent = fitThreeExpAmps(trendPoints(own, TREND_EXPERIMENT.recentHalfLifeDays),
    { prior: established, lambda: TREND_EXPERIMENT.recentRidge });
  const blend = TREND_EXPERIMENT.recentBlend;
  return { days, effectiveDays, maxDuration: Math.max(...own.map(r => r.actual_time_s)),
    established, establishedRecent: established.map((a, i) => (1 - blend) * a + blend * recent[i]),
    recent, lastDate: own.map(r => r.date).sort().at(-1) };
}

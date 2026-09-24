// Offline comparison only. No live prescription or automatic model promotion.
import { prepareEvaluationRows } from './evaluationRows.js';
import { freshFitReps, prescribedLoad } from './load.js';
import { fitEstablishedTrend } from './capacityTrendFit.js';
import { predForceThreeExp } from './threeExp.js';
import { summarizeTrendRows, trendDuration } from './capacityTrendExperiment.js';
import { zoneOf } from './zones.js';
import { comparableCapacityHistory, loadProvenance } from './forceRecording.js';
import { loadBounds, EXTRAP_FLOOR_MULT } from './prescription.js';

export function evaluateCapacityWindows(input) {
  const { rows, excluded } = prepareEvaluationRows(input);
  const observations = [];
  const cache = new Map();
  for (const rep of freshFitReps(rows)) {
    if (!(rep.target_duration >= 12 && rep.actual_time_s > 0 && rep.actual_time_s <= 600 && rep.avg_force_kg > 0)
      || !['legacy_measured', 'measured_force'].includes(loadProvenance(rep))) continue;
    const key = `${rep.date}|${rep.grip}|${rep.hand}`;
    if (!cache.has(key)) {
      const prior = rows.filter(r => r.date < rep.date);
      cache.set(key, { prior,
        current: fitEstablishedTrend(prior, rep.hand, rep.grip, rep.date),
        last30: fitEstablishedTrend(prior, rep.hand, rep.grip, rep.date, { sessionWindow: 30 }) });
    }
    const ctx = cache.get(key);
    if (!ctx.current || !ctx.last30) continue;
    const bounds = loadBounds(comparableCapacityHistory(ctx.prior), rep.hand, rep.grip, rep.actual_time_s, { referenceDate: rep.date });
    const predictions = {}, bounded = {}, times = {};
    const planned = prescribedLoad(rep);
    for (const name of ['current', 'last30']) {
      const model = ctx[name];
      predictions[name] = predForceThreeExp(model.established, rep.actual_time_s);
      bounded[name] = bounds.capValue(Math.round(predForceThreeExp(model.established,
        Math.min(rep.actual_time_s, model.maxDuration * EXTRAP_FLOOR_MULT)) * 10) / 10);
      times[name] = trendDuration(model.established, planned);
    }
    observations.push({ id: rep.id, date: rep.date, grip: rep.grip, hand: rep.hand,
      domain: zoneOf(rep.target_duration), evidence: loadProvenance(rep),
      actual: rep.avg_force_kg, duration: rep.actual_time_s,
      priorDays: ctx.current.days, windowDays: ctx.last30.days,
      newestPriorDate: ctx.last30.lastDate, predictions, bounded, times,
      comparableTime: planned > 0 && Math.abs(rep.avg_force_kg / planned - 1) <= .05 });
  }
  const models = ['current', 'last30'];
  const summarize = rs => ({ curve: summarizeTrendRows(rs, models),
    bounded: summarizeTrendRows(rs.map(r => ({ ...r, predictions: r.bounded })), models),
    time: summarizeTrendRows(rs.filter(r => r.comparableTime).map(r => ({ ...r, actual: r.duration,
      predictions: Object.fromEntries(models.map(m => [m, r.times[m].seconds])) })), models) });
  const by = key => Object.fromEntries([...new Set(observations.map(r => r[key]))].map(value =>
    [value, summarize(observations.filter(r => r[key] === value))]));
  return { experiment: 'capacity-window-v1', method: {
    current: 'Established curve with 90-day half-life; not the production prescription',
    last30: 'Last 30 eligible grip sessions, both hands retained, no time decay within window',
    shared: 'Same eligible opening evidence, quality weights, equal day weighting, fitting method, bounds and strictly earlier-date cutoff',
    limitations: 'One-user retrospective comparison, reused development history. Counts refer to eligible sessions, not all activity. No physiological or readiness claims. No live changes.',
  }, excluded, overall: summarize(observations), byGrip: by('grip'), byDomain: by('domain'),
    byHand: by('hand'), byEvidence: by('evidence'), observations };
}

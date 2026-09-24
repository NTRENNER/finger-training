// Offline hypothesis only. Never imported by the live recommender or charts.
import { freshFitReps, isFirstSetRep, sane, prescribedLoad } from './load.js';
import { comparableCapacityHistory, loadProvenance } from './forceRecording.js';
import { predForceThreeExp, buildThreeExpPriors } from './threeExp.js';
import { buildFreshLoadMap, fitDoseK, prescription, loadBounds, EXTRAP_FLOOR_MULT } from './prescription.js';
import { computePersonalRecoveryTaus } from './recoveryFit.js';
import { PHYS_MODEL_DEFAULT } from './fatigue.js';
import { evaluateForward, prepareEvaluationRows, evaluationMetrics } from './forwardEvaluation.js';

import { TREND_EXPERIMENT, trendPoints, fitEstablishedTrend } from './capacityTrendFit.js';
export { TREND_EXPERIMENT, trendPoints, fitEstablishedTrend } from './capacityTrendFit.js';

const MODELS = ['current', 'averagedAnchor', 'established', 'establishedRecent'];
const mean = xs => xs.reduce((s, x) => s + x, 0) / xs.length;
const round = x => Number.isFinite(x) ? Number(x.toFixed(4)) : null;
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
const sumWeight = pts => pts.reduce((s, p) => s + p.w, 0);

export function averagedAnchorAmps(amps, openers) {
  const pts = trendPoints(openers, TREND_EXPERIMENT.anchorHalfLifeDays, false);
  const w = sumWeight(pts);
  if (!w) return [...amps];
  const logRatio = pts.reduce((sum, p) => sum + p.w * Math.log(p.F / predForceThreeExp(amps, p.T)), 0) / w;
  const scale = Math.exp(logRatio);
  return amps.map(a => a * scale);
}

// Binary inversion has explicit censored states instead of a fake 0s/600s score.
export function trendDuration(amps, force) {
  if (!(force > 0) || !amps) return { status: 'unavailable', seconds: null };
  if (force > predForceThreeExp(amps, 0)) return { status: 'above_curve', seconds: null };
  if (force < predForceThreeExp(amps, 600)) return { status: 'beyond_600s', seconds: null };
  let lo = 0, hi = 600;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (predForceThreeExp(amps, mid) > force) lo = mid;
    else hi = mid;
  }
  return { status: 'estimated', seconds: (lo + hi) / 2 };
}

function metrics(rows, model) {
  const result = evaluationMetrics(rows, model);
  const valid = rows.filter(r => r.actual > 0 && Number.isFinite(r.predictions[model]));
  const days = [...grouped(valid, r => r.date).values()];
  return { ...result,
    largeOverpredictionPct: days.length ? round(100 * mean(days.map(rs => mean(rs.map(r =>
      Number(r.predictions[model] > r.actual * 1.25)))))) : null };
}

// Sampling paired dates preserves correlated left/right and same-day grips.
export function pairedDayInterval(rows, model, draws = 2000) {
  const paired = rows.filter(r => r.actual > 0 && Number.isFinite(r.predictions.current)
    && Number.isFinite(r.predictions[model]));
  const deltas = [...grouped(paired, r => r.date).values()].map(rs => mean(rs.map(r =>
    Math.abs(r.predictions[model] - r.actual) - Math.abs(r.predictions.current - r.actual))));
  if (deltas.length < 2) return { days: deltas.length, deltaMae: deltas.length ? round(deltas[0]) : null, interval95: null };
  let state = 9242026;
  const random = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
  const samples = Array.from({ length: draws }, () => mean(deltas.map(() => deltas[Math.floor(random() * deltas.length)]))).sort((a, b) => a - b);
  return { days: deltas.length, deltaMae: round(mean(deltas)),
    interval95: [round(samples[Math.floor(draws * 0.025)]), round(samples[Math.floor(draws * 0.975)])] };
}

export function summarizeTrendRows(rows, models = MODELS) {
  // All four must exist for the primary comparison. Missing is never zero.
  const matched = rows.filter(r => models.every(m => Number.isFinite(r.predictions[m])));
  return { matchedObservations: matched.length, metrics: Object.fromEntries(models.map(m => [m, metrics(matched, m)])),
    pairedDifferences: Object.fromEntries(models.filter(m => m !== 'current').map(m => [m, pairedDayInterval(matched, m)])) };
}
const summary = rows => summarizeTrendRows(rows);

export function evaluateCapacityTrends(input) {
  const { rows } = prepareEvaluationRows(input);
  const forward = evaluateForward(rows, { minPriorDays: TREND_EXPERIMENT.minPriorDays });
  const observations = [], dateCache = new Map();
  for (const r of forward.observations.force) {
    if (!dateCache.has(r.date)) {
      const prior = rows.filter(p => p.date < r.date && isFirstSetRep(p));
      dateCache.set(r.date, { prior, threeExpPriors: buildThreeExpPriors(prior),
        freshMap: buildFreshLoadMap(prior, { doseK: fitDoseK(prior) ?? PHYS_MODEL_DEFAULT.doseK,
          personalTausByGrip: computePersonalRecoveryTaus(prior) }), trends: new Map() });
    }
    const ctx = dateCache.get(r.date);
    const key = `${r.grip}|${r.hand}`;
    if (!ctx.trends.has(key)) ctx.trends.set(key, fitEstablishedTrend(ctx.prior, r.hand, r.grip, r.date));
    const trend = ctx.trends.get(key);
    const rx = prescription(ctx.prior, r.hand, r.grip, r.duration,
      { freshMap: ctx.freshMap, threeExpPriors: ctx.threeExpPriors, referenceDate: r.date, captureCurve: true });
    if (!trend || !rx?.curveSnapshot) continue;
    const snap = rx.curveSnapshot;
    const openers = freshFitReps(ctx.prior).filter(p => p.grip === r.grip && p.hand === r.hand && measured(p));
    const amps = { current: snap.amps.map(a => a * snap.scale),
      averagedAnchor: averagedAnchorAmps(snap.amps, openers),
      established: trend.established, establishedRecent: trend.establishedRecent };
    const predictions = {}, bounded = {};
    const bounds = loadBounds(comparableCapacityHistory(ctx.prior), r.hand, r.grip, r.duration, { referenceDate: r.date });
    for (const m of MODELS) {
      predictions[m] = predForceThreeExp(amps[m], r.duration);
      const maxT = ['current', 'averagedAnchor'].includes(m) ? snap.max_duration_s : trend.maxDuration;
      const floorT = Math.min(r.duration, maxT * EXTRAP_FLOOR_MULT);
      bounded[m] = bounds.capValue(Math.round(predForceThreeExp(amps[m], floorT) * 10) / 10);
    }
    // Fail loudly if this evaluation drifts from the live model safeguards.
    if (Math.abs(bounded.current - rx.value) > 1e-8) throw new Error('Trend baseline bounds differ from prescription');
    const stored = rows.find(p => p.date === r.date && p.session_id === r.session && p.hand === r.hand
      && p.grip === r.grip && (p.rep_num ?? 1) === (r.rep ?? 1) && isFirstSetRep(p));
    const planned = stored ? prescribedLoad(stored) : 0;
    const times = Object.fromEntries(MODELS.map(m => [m, trendDuration(amps[m], planned)]));
    observations.push({ ...r, predictions, bounded, priorDays: trend.days, effectiveDays: round(trend.effectiveDays),
      plannedForceKg: planned || null, plannedTimePredictions: times,
      comparablePlannedForce: planned > 0 && Math.abs(r.actual / planned - 1) <= 0.05,
      recentDeviationPct: round(100 * (predictions.establishedRecent / predictions.established - 1)) });
  }
  const standard = observations.filter(r => r.targetDuration >= 12);
  const summarizeSet = rs => ({ curves: summary(rs), bounded: summary(rs.map(r => ({ ...r, predictions: r.bounded }))) });
  const breakdown = field => Object.fromEntries([...grouped(standard, r => r[field])].map(([key, rs]) => [key, summarizeSet(rs)]));
  const dates = [...new Set(standard.map(r => r.date))].sort();
  const splitDate = dates[Math.floor(dates.length / 2)] ?? null;
  const timeRows = standard.filter(r => r.comparablePlannedForce);
  const timeScores = timeRows.map(r => ({ ...r, actual: r.duration,
    predictions: Object.fromEntries(MODELS.map(m => [m, r.plannedTimePredictions[m].seconds])) }));
  return { experiment: TREND_EXPERIMENT, inventory: forward.inventory,
    method: { cutoff: 'strictly earlier dates, all dependencies', noLiveChanges: true,
      primary: 'standard openers (planned target >=12s), force at observed duration, equal day weight',
      caveat: 'One-user retrospective experiment. Constants fixed before run, but history used in prior development. No independent validation or proof of physiological fitness/readiness separation.',
      units: 'force kg; planned-load time seconds; paired differences candidate minus current (negative favors candidate)',
      time: 'Frozen curve at saved planned force; score only within 5% actual force, and only jointly invertible 0–600s. Still affected by load mismatch and legacy release behavior.',
      split: 'chronological halves for stability inspection, not an untouched holdout' },
    standard: summarizeSet(standard), allOpeners: summarizeSet(observations),
    byGrip: breakdown('grip'), byHand: breakdown('hand'), byPlannedDomain: breakdown('domain'),
    byObservedDomain: breakdown('observedDomain'), byEvidence: breakdown('evidence'),
    byPriorDays: Object.fromEntries([[5, 9], [10, 19], [20, Infinity]].map(([lo, hi]) =>
      [`${lo}-${Number.isFinite(hi) ? hi : 'plus'}`, summarizeSet(standard.filter(r => r.priorDays >= lo && r.priorDays <= hi))])),
    chronology: { splitDate, early: summarizeSet(standard.filter(r => r.date < splitDate)),
      late: summarizeSet(standard.filter(r => r.date >= splitDate)) },
    plannedLoadTime: { eligible: timeRows.length, matched: summary(timeScores),
      statuses: Object.fromEntries(MODELS.map(m => [m, Object.fromEntries([...grouped(timeRows, r => r.plannedTimePredictions[m].status)]
        .map(([status, rs]) => [status, rs.length]))])) },
    observations };
}

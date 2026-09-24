// Read-only comparison on exactly the v1 observations. Nothing is promoted.
import { evaluateCapacityTrends, summarizeTrendRows } from './capacityTrendExperiment.js';
import { prepareEvaluationRows } from './forwardEvaluation.js';
import { comparableCapacityHistory } from './forceRecording.js';
import { loadBounds, EXTRAP_FLOOR_MULT } from './prescription.js';
import { buildAdaptiveCapacity, adaptiveFloorReplay, applyAdaptiveBounds,
  adaptiveDuration, ADAPTIVE_EXPERIMENT } from './adaptiveCapacityExperiment.js';

const MODELS = ['current', 'averagedAnchor', 'established', 'adaptive', 'adaptiveFloor'];
const datesOf = rows => [...new Set(rows.map(r => r.date))].sort();
export function evaluateAdaptiveCapacity(input) {
  const { rows } = prepareEvaluationRows(input);
  const v1 = evaluateCapacityTrends(rows);
  const snapshots = new Map(), replayCaches = new Map(), observations = [];
  for (const row of v1.observations) {
    const key = `${row.date}|${row.grip}|${row.hand}`;
    if (!snapshots.has(key)) {
      const prior = rows.filter(r => r.date < row.date);
      snapshots.set(key, { prior, model: buildAdaptiveCapacity(prior, row.hand, row.grip, row.date) });
    }
    const { prior, model } = snapshots.get(key);
    if (!model) continue;
    const scope = `${row.grip}|${row.hand}|${model.openers.at(-1)?.setup_id ?? ''}`;
    if (!replayCaches.has(scope)) replayCaches.set(scope, new Map());
    const bounds = loadBounds(comparableCapacityHistory(prior), row.hand, row.grip, row.duration, { referenceDate: row.date });
    const revision = adaptiveFloorReplay(prior, row.hand, row.grip, row.duration, row.date, bounds.floorKg, replayCaches.get(scope));
    const raw = model.forceAt(row.duration);
    const limitedT = Math.min(row.duration, model.maxDuration * EXTRAP_FLOOR_MULT);
    const rounded = Math.round(model.forceAt(limitedT) * 10) / 10;
    const time = adaptiveDuration(model, row.plannedForceKg);
    observations.push({ ...row, predictions: { ...row.predictions, adaptive: raw, adaptiveFloor: raw },
      bounded: { ...row.bounded, adaptive: applyAdaptiveBounds(rounded, bounds),
        adaptiveFloor: applyAdaptiveBounds(rounded, bounds, revision.floor) },
      plannedTimePredictions: { ...row.plannedTimePredictions, adaptive: time, adaptiveFloor: time },
      adaptiveEvidence: model.evidenceAt(row.duration), floorRevision: revision,
      originalFloorKg: bounds.floorKg, projectionMaxChangePct: model.projectionMaxChangePct });
  }
  const standard = observations.filter(r => r.targetDuration >= 12);
  const summarize = rs => ({ curves: summarizeTrendRows(rs, MODELS),
    bounded: summarizeTrendRows(rs.map(r => ({ ...r, predictions: r.bounded })), MODELS) });
  const breakdown = field => Object.fromEntries([...new Set(standard.map(r => r[field]))]
    .map(key => [key, summarize(standard.filter(r => r[field] === key))]));
  const timeRows = standard.filter(r => r.comparablePlannedForce);
  const timeScores = timeRows.map(r => ({ ...r, actual: r.duration,
    predictions: Object.fromEntries(MODELS.map(m => [m, r.plannedTimePredictions[m].seconds])) }));
  return { experiment: ADAPTIVE_EXPERIMENT, method: { ...v1.method,
    interpretation: 'Exploratory v2 built after inspecting v1. Adaptive and adaptiveFloor share one raw curve; they differ only in load-floor policy. Time inversions are raw-curve diagnostics, not bounded policy forecasts.' },
    inventory: v1.inventory, v1Observations: v1.observations.length, evaluatedObservations: observations.length,
    standard: summarize(standard), allOpeners: summarize(observations),
    byGrip: breakdown('grip'), byHand: breakdown('hand'), byPlannedDomain: breakdown('domain'),
    byObservedDomain: breakdown('observedDomain'), byEvidence: breakdown('evidence'),
    chronology: { splitDate: v1.chronology.splitDate,
      early: summarize(standard.filter(r => r.date < v1.chronology.splitDate)),
      late: summarize(standard.filter(r => r.date >= v1.chronology.splitDate)) },
    activity: { adjustedHolds: standard.filter(r => r.adaptiveEvidence.influence > 0).length,
      relaxedFloorHolds: standard.filter(r => r.floorRevision.floor < r.originalFloorKg - 1e-8).length,
      maxProjectionChangePct: Math.max(0, ...standard.map(r => r.projectionMaxChangePct)) },
    plannedLoadTime: { eligible: timeRows.length, days: datesOf(timeRows).length,
      matched: summarizeTrendRows(timeScores, MODELS),
      statuses: Object.fromEntries(MODELS.map(m => [m, Object.fromEntries([...new Set(timeRows.map(r => r.plannedTimePredictions[m].status))]
        .map(status => [status, timeRows.filter(r => r.plannedTimePredictions[m].status === status).length]))])) }, observations };
}

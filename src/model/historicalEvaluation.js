import { evaluateForward, prepareEvaluationRows } from './forwardEvaluation.js';
import { freshFitReps, sane } from './load.js';
import { loadProvenance } from './forceRecording.js';
import { classifyZone6 } from './zones.js';

const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const groups = (rows, field) => Object.fromEntries([...new Set(rows.map(r => r[field]))]
  .map(k => [k, rows.filter(r => r[field] === k)]));

function attainment(rows) {
  const matched = rows.filter(r => r.loadMatch);
  const days = Object.values(groups(matched, 'date'));
  const dayMean = fn => mean(days.map(rs => mean(rs.map(fn))));
  const matchedSummary = {
    holds: matched.length, days: days.length,
    meanSecondsBeyondTarget: dayMean(r => r.actualSeconds - r.targetSeconds),
    meanPercentBeyondTarget: dayMean(r => 100 * (r.actualSeconds / r.targetSeconds - 1)),
    below80Percent: matched.filter(r => r.actualSeconds < .8 * r.targetSeconds).length,
    within20Percent: matched.filter(r => r.actualSeconds >= .8 * r.targetSeconds && r.actualSeconds <= 1.2 * r.targetSeconds).length,
    above120Percent: matched.filter(r => r.actualSeconds > 1.2 * r.targetSeconds).length,
    dayWeightedBelow80Percent: dayMean(r => r.actualSeconds < .8 * r.targetSeconds ? 100 : 0),
    dayWeightedAbove120Percent: dayMean(r => r.actualSeconds > 1.2 * r.targetSeconds ? 100 : 0),
  };
  return { measuredOpeners: rows.length, matched: matchedSummary,
    higherForce: rows.filter(r => r.actualKg > 1.1 * r.prescribedKg).length,
    higherForceAndAtLeastTargetTime: rows.filter(r => r.actualKg > 1.1 * r.prescribedKg && r.actualSeconds >= r.targetSeconds).length,
    lowerForce: rows.filter(r => r.actualKg < .9 * r.prescribedKg).length };
}

// Descriptive attainment of the RECORDED target; it is not the prediction error
// of any single model version. A ladder pin or load adjustment is also a plan.
export function evaluateRecordedPrescriptions(input) {
  const { rows, excluded: inputExcluded } = prepareEvaluationRows(input);
  const openers = freshFitReps(rows.map(r => ({ ...r, original: r })), { preserveAllBases: true });
  const observations = [], shortTargets = [], excluded = {};
  const skip = reason => { excluded[reason] = (excluded[reason] || 0) + 1; };
  for (const r of openers.map(r => r.original)) {
    if (r.force_recording?.session_protocol) { skip('special_protocol'); continue; }
    const provenance = loadProvenance(r);
    if (!['measured_force', 'legacy_measured'].includes(provenance) || !sane(r.avg_force_kg)) {
      skip('no_measured_force'); continue;
    }
    if (r.force_recording?.signal_quality && r.force_recording.signal_quality !== 'complete') {
      skip('incomplete_signal'); continue;
    }
    if (r.end_reason && !['muscular_failure', 'target_force_failure'].includes(r.end_reason)) { skip('not_failure'); continue; }
    const stored = sane(r.prescribed_load_kg), fallback = sane(r.weight_kg);
    const prescribed = stored ?? fallback;
    if (!prescribed || !(r.target_duration > 0) || !(r.actual_time_s > 0)) { skip('missing_plan_or_duration'); continue; }
    const observation = { id: r.id, date: r.date, grip: r.grip, hand: r.hand, session: r.session_id,
      domain: classifyZone6(r.target_duration)?.key || 'unknown',
      evidence: provenance === 'measured_force' && r.failure_valid === true && stored
        ? 'explicit_measured_failure' : 'legacy_or_uncertain',
      prescriptionSource: stored ? 'prescribed_load_kg' : 'legacy_weight_kg',
      basis: r.force_recording?.basis || 'legacy_interval',
      prescribedKg: prescribed, targetSeconds: r.target_duration,
      actualKg: r.avg_force_kg, actualSeconds: r.actual_time_s,
      loadMatch: Math.abs(r.avg_force_kg / prescribed - 1) <= .10 + 1e-10 };
    // Historical 3–5s tests may end by countdown/release. Keep them visible
    // without treating their duration as a measured failure-time error.
    (r.target_duration < 12 ? shortTargets : observations).push(observation);
  }
  return { method: 'Recorded target attainment, not model prediction error. Same-day means receive equal weight.',
    tolerance: { forceFraction: .10, durationFraction: .20 },
    inputExcluded, excluded, all: attainment(observations),
    byGrip: Object.fromEntries(Object.entries(groups(observations, 'grip')).map(([k, rs]) => [k, attainment(rs)])),
    byDomain: Object.fromEntries(Object.entries(groups(observations, 'domain')).map(([k, rs]) => [k, attainment(rs)])),
    byEvidence: Object.fromEntries(Object.entries(groups(observations, 'evidence')).map(([k, rs]) => [k, attainment(rs)])),
    byPrescriptionSource: Object.fromEntries(Object.entries(groups(observations, 'prescriptionSource')).map(([k, rs]) => [k, attainment(rs)])),
    shortTargets: { count: shortTargets.length, observations: shortTargets }, observations };
}

export function evaluateHistorical(input) {
  return { version: 1, generatedAt: new Date().toISOString(),
    recorded: evaluateRecordedPrescriptions(input), replay: evaluateForward(input),
    caution: 'Historical analysis, not independent prospective validation. Original model versions, history edits and all past inputs cannot be reconstructed exactly.' };
}

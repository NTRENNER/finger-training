// Offline only. Never imported by the app or used to tune live recommendations.
import { freshFitReps, isFirstSetRep, sane } from './load.js';
import { isCapacityEvidenceRep, legacyIntervalRep, loadProvenance } from './forceRecording.js';
import { buildFreshLoadMap, fitDoseK, prescription } from './prescription.js';
import { buildThreeExpPriors, fitThreeExpAmps, predForceThreeExp, THREE_EXP_LAMBDA_DEFAULT } from './threeExp.js';
import { computePersonalRecoveryTaus } from './recoveryFit.js';
import { recoveryEvidence } from './recoveryEvidence.js';
import { PHYS_MODEL_DEFAULT, predictRepTimes } from './fatigue.js';
import { summarizeMixedPredictions } from './mixedLoadPrediction.js';
import { classifyZone6 } from './zones.js';
import { tracePrescription } from './prescriptionDiagnostics.js';

const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const round = n => n == null ? null : Number(n.toFixed(3));
const positive = n => Number.isFinite(n) && n > 0;
const dayCount = rows => new Set(rows.map(r => r.date)).size;
const group = (rows, key) => {
  const out = new Map();
  for (const row of rows) {
    const k = key(row);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(row);
  }
  return out;
};

// A duplicated export must not provide extra training or test observations.
// Conflicting copies of the same ID cannot be resolved without edit history.
export function prepareEvaluationRows(input) {
  const rows = [], excluded = {}, seen = new Set(), ids = new Map();
  const reject = reason => { excluded[reason] = (excluded[reason] || 0) + 1; };
  const canonical = value => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
    return value;
  };
  for (const r of input) if (r?.id) {
    const contents = JSON.stringify(canonical(r));
    if (!ids.has(r.id)) ids.set(r.id, new Set());
    ids.get(r.id).add(contents);
  }
  for (const r of input) {
    if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(r.date || '') || !Number.isFinite(Date.parse(r.date))) { reject('invalid_date'); continue; }
    if (!['L', 'R'].includes(r.hand) || !r.grip) { reject('unknown_hand_or_grip'); continue; }
    if (r.id && ids.get(r.id).size > 1) { reject('conflicting_id'); continue; }
    const key = r.id || JSON.stringify(canonical(r));
    if (seen.has(key)) { reject('duplicate'); continue; }
    seen.add(key); rows.push(r);
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || String(a.session_id).localeCompare(String(b.session_id))
    || a.hand.localeCompare(b.hand) || (a.set_num || 1) - (b.set_num || 1) || (a.rep_num || 1) - (b.rep_num || 1)
    || String(a.id).localeCompare(String(b.id)));
  return { rows, excluded };
}

// Express ONLY the test interval on the basis already chosen by past evidence.
// Never insert the held-out rep into a fit just to harmonize its interval.
export function evaluationInterval(rep, prior) {
  const previous = prior.filter(r => r.grip === rep.grip && isCapacityEvidenceRep(r));
  const historicalBasis = previous.some(r => r.force_recording?.basis !== 'target_acquired');
  if (historicalBasis) {
    if (rep.force_recording?.basis === 'target_acquired'
        && !Number.isFinite(rep.force_recording.acquisition_s)) return null;
    return legacyIntervalRep(rep);
  }
  return rep.force_recording?.basis === 'target_acquired' ? rep : null;
}

// Equal weight per training day, averaging both hands, grips and reps within
// that day. Pairwise comparisons always use exactly the same observations.
export function evaluationMetrics(rows, model) {
  const valid = rows.filter(r => positive(r.actual) && Number.isFinite(r.predictions[model]));
  if (!valid.length) return { observations: 0, trainingDays: 0, mae: null, rmse: null, bias: null, mapePct: null };
  const days = [...group(valid, r => r.date).values()];
  const dayMean = fn => mean(days.map(rs => mean(rs.map(fn))));
  return { observations: valid.length, trainingDays: days.length,
    mae: round(dayMean(r => Math.abs(r.predictions[model] - r.actual))),
    rmse: round(Math.sqrt(dayMean(r => (r.predictions[model] - r.actual) ** 2))),
    bias: round(dayMean(r => r.predictions[model] - r.actual)),
    mapePct: round(100 * dayMean(r => Math.abs(r.predictions[model] - r.actual) / r.actual)) };
}

function summarize(rows, primary, alternatives) {
  const one = rs => ({
    available: Object.fromEntries([primary, ...alternatives].map(m => [m, evaluationMetrics(rs, m)])),
    matched: Object.fromEntries(alternatives.map(m => {
      const both = rs.filter(r => Number.isFinite(r.predictions[primary]) && Number.isFinite(r.predictions[m]));
      return [m, { [primary]: evaluationMetrics(both, primary), [m]: evaluationMetrics(both, m) }];
    })),
  });
  return { all: one(rows),
    byGrip: Object.fromEntries([...group(rows, r => r.grip)].map(([key, rs]) => [key, one(rs)])),
    byHand: Object.fromEntries([...group(rows, r => r.hand)].map(([key, rs]) => [key, one(rs)])),
    byEvidence: Object.fromEntries([...group(rows, r => r.evidence)].map(([key, rs]) => [key, one(rs)])),
    // Keep the historical key for consumers; name its meaning in the report.
    byDomain: Object.fromEntries([...group(rows, r => r.domain)].map(([key, rs]) => [key, one(rs)])),
    byObservedDurationDomain: Object.fromEntries([...group(rows, r => r.observedDomain || 'unknown')].map(([key, rs]) => [key, one(rs)])) };
}

const measuredOpener = r => sane(r.avg_force_kg) != null && positive(r.actual_time_s)
  && r.actual_time_s <= 600 && ['legacy_measured', 'measured_force'].includes(loadProvenance(r));
const seriesKey = r => `${r.date}|${r.session_id}|${r.grip}|${r.hand}|${r.set_num ?? 1}`;

export function evaluateForward(input, { minPriorDays = 5, diagnostics = false } = {}) {
  if (!Array.isArray(input)) throw new Error('Expected a JSON array of rep rows');
  if (!Number.isInteger(minPriorDays) || minPriorDays < 1) throw new Error('minPriorDays must be a positive integer');
  const { rows, excluded } = prepareEvaluationRows(input);
  const forceRows = [], recoveryRows = [], forceExcluded = {}, recoveryExcluded = {};
  const count = (out, key) => { out[key] = (out[key] || 0) + 1; };
  const dates = [...new Set(rows.map(r => r.date))];
  for (const date of dates) {
    // This cutoff applies to EVERY dependency: priors, fatigue dose, recovery,
    // anchors, ceilings and floors. Same-day sessions never train one another.
    const prior = rows.filter(r => r.date < date && isFirstSetRep(r));
    const today = rows.filter(r => r.date === date && isFirstSetRep(r));
    const taus = computePersonalRecoveryTaus(prior);
    const priors = buildThreeExpPriors(prior);
    const fresh = freshFitReps(prior).filter(measuredOpener);
    let freshMap;
    for (const raw of freshFitReps(today.map(r => ({ ...r, evaluationOriginal: r })), { preserveAllBases: true })) {
      if (!measuredOpener(raw)) { count(forceExcluded, 'no_measured_failure_force'); continue; }
      const past = fresh.filter(r => r.hand === raw.hand && r.grip === raw.grip);
      if (dayCount(past) < minPriorDays) { count(forceExcluded, 'insufficient_prior_days'); continue; }
      // Get the original interval: freshFitReps(today) may have harmonized a
      // mixed-basis day; scoring must convert from the stored value only once.
      const stored = raw.evaluationOriginal;
      const r = evaluationInterval(stored, prior);
      if (!r) { count(forceExcluded, 'incompatible_interval'); continue; }
      if (!freshMap) freshMap = buildFreshLoadMap(prior, {
        doseK: fitDoseK(prior) ?? PHYS_MODEL_DEFAULT.doseK, personalTausByGrip: taus,
      });
      const fitted = fitThreeExpAmps(past.map(p => ({ T: p.actual_time_s, F: p.avg_force_kg })),
        { prior: priors.get(r.grip), lambda: THREE_EXP_LAMBDA_DEFAULT / past.length });
      // Simple benchmark: the most recent comparable-duration fresh hold,
      // within 10% of this duration and no more than 90 days old. No scaling.
      const comparable = past.filter(p => Math.max(p.actual_time_s, r.actual_time_s) / Math.min(p.actual_time_s, r.actual_time_s) <= 1.10
        && (Date.parse(date) - Date.parse(p.date)) / 86400000 <= 90).at(-1);
      const rx = prescription(prior, r.hand, r.grip, r.actual_time_s, { freshMap, threeExpPriors: priors, referenceDate: date });
      const trace = diagnostics ? tracePrescription(prior, r.hand, r.grip, r.actual_time_s,
        { freshMap, threeExpPriors: priors, referenceDate: date }, rx) : null;
      forceRows.push({ date, grip: r.grip, hand: r.hand, session: r.session_id, rep: r.rep_num,
        domain: classifyZone6(r.target_duration)?.key || 'unknown',
        observedDomain: classifyZone6(r.actual_time_s)?.key || 'unknown',
        targetDuration: r.target_duration,
        evidence: `${loadProvenance(stored)}:${stored.force_recording?.basis || 'legacy_interval'}`,
        actual: r.avg_force_kg, duration: r.actual_time_s,
        predictions: { prescription: rx?.value ?? null, freshCurve: fitted ? predForceThreeExp(fitted, r.actual_time_s) : null,
          recentComparable: comparable?.avg_force_kg ?? null, ...(trace?.predictions || {}) },
        ...(trace ? { diagnostics: trace.details } : {}) });
    }

    for (const set of group(today.filter(r => r.session_id), seriesKey).values()) {
      const evidence = recoveryEvidence(set);
      if (!evidence.eligible) { count(recoveryExcluded, evidence.reason || 'no_comparable_prefix'); continue; }
      const opener = evidence.reps[0];
      const pastSets = [...group(prior.filter(r => r.session_id && r.grip === opener.grip), seriesKey).values()]
        .map(rs => recoveryEvidence(rs)).filter(e => e.reps.length >= 3);
      if (dayCount(pastSets.map(e => e.reps[0])) < minPriorDays) { count(recoveryExcluded, 'insufficient_prior_days'); continue; }
      const tau = taus.get(opener.grip);
      if (!tau) { count(recoveryExcluded, 'no_personal_fit'); continue; }
      // All forecasts are conditional on the observed first hold. Measured
      // actual rest is a diagnostic scenario, NOT information known upfront.
      const options = { numReps: evidence.reps.length, firstRepTime: opener.actual_time_s, roundTo: null };
      const personal = { ...PHYS_MODEL_DEFAULT, tauR: tau };
      const conditional = predictRepTimes({ ...options, restIntervals: evidence.rests, physModel: personal });
      const population = predictRepTimes({ ...options, restIntervals: evidence.rests, physModel: PHYS_MODEL_DEFAULT });
      const plannedRest = Number.isFinite(opener.rest_s) && opener.rest_s >= 0 ? opener.rest_s : null;
      const plannedPersonal = plannedRest == null ? null : predictRepTimes({ ...options, restSeconds: plannedRest, physModel: personal });
      const plannedPopulation = plannedRest == null ? null : predictRepTimes({ ...options, restSeconds: plannedRest, physModel: PHYS_MODEL_DEFAULT });
      if (evidence.reason) count(recoveryExcluded, `tail:${evidence.reason}`);
      for (let i = 1; i < evidence.reps.length; i++) {
        const r = evidence.reps[i];
        recoveryRows.push({ date, grip: r.grip, hand: r.hand, session: r.session_id, rep: r.rep_num,
          domain: classifyZone6(opener.target_duration)?.key || 'unknown', evidence: evidence.confidence,
          observedDomain: classifyZone6(opener.actual_time_s)?.key || 'unknown',
          actual: r.actual_time_s, predictions: { personal: conditional[i], population: population[i],
            plannedPersonal: plannedPersonal?.[i] ?? null, plannedPopulation: plannedPopulation?.[i] ?? null } });
      }
    }
  }
  return { version: 2,
    method: { cutoff: 'strictly earlier calendar days', minPriorDays, weighting: 'equal training-day weight; hands and reps averaged within day',
      domains: 'byDomain groups by planned target; byObservedDurationDomain groups by scored hold duration (opener duration for recovery). Neither establishes a physiological stimulus.',
      force: 'Conditional force-at-observed-duration calibration in kg; not a pre-rep forecast or an exact replay of the ladder.',
      recovery: 'Later-hold seconds conditional on observed opener. Actual-rest diagnostic and constant planned-rest scenario reported separately.',
      caveat: 'One-user retrospective check. Historical edits and model development on this history prevent treating this as independent prospective validation.' },
    inventory: { inputRows: input.length, retainedRows: rows.length, trainingDays: dates.length, sessions: new Set(rows.map(r => r.session_id).filter(Boolean)).size,
      firstDate: dates[0] || null, lastDate: dates.at(-1) || null, excluded },
    force: { excluded: forceExcluded, ...summarize(forceRows, 'prescription', ['freshCurve', 'recentComparable']),
      ...(diagnostics ? { stages: summarize(forceRows.filter(r => r.diagnostics), 'prescription',
        ['freshCurve', 'rawCurve', 'fatigueCurve', 'anchoredCurve', 'extrapolatedCurve', 'sameDomainAnchor']) } : {}) },
    recovery: { excluded: recoveryExcluded,
      actualRestDiagnostic: summarize(recoveryRows, 'personal', ['population']),
      plannedRestScenario: summarize(recoveryRows, 'plannedPersonal', ['plannedPopulation']) },
    mixedSavedPredictions: summarizeMixedPredictions(rows),
    observations: { force: forceRows, recovery: recoveryRows } };
}

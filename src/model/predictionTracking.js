// Prospective, versioned experiments. This module never supplies a training
// recommendation. Models are frozen at session start, predictions before holds.
import { prescription, buildFreshLoadMap, repKey } from './prescription.js';
import { freshFitReps } from './load.js';
import { THREE_EXP_TAUS, predForceThreeExp } from './threeExp.js';
import { buildPhysModel } from './repCurveData.js';
import { PHYS_MODEL_DEFAULT, predictRepTimes } from './fatigue.js';
import { zoneOf } from './zones.js';
import { ymdLocal } from '../util.js';
import { buildAdaptiveShadow, adaptiveShadowForce, adaptiveShadowTime,
  ADAPTIVE_PREDICTION_EXPERIMENT } from './adaptivePrediction.js';

export const PREDICTION_EXPERIMENT = 'fresh-openers-v1';
export const REVIEW_DAYS = 10;
const KEY = 'prediction_check';
const positive = n => Number.isFinite(n) && n > 0;
const copy = x => JSON.parse(JSON.stringify(x));
const unavailable = reason => ({ status: 'unavailable', reason });

// JSONB may reorder object keys. Fingerprints must survive that round trip.
function canonical(x) {
  if (Array.isArray(x)) return x.map(canonical);
  if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).sort()
    .filter(k => x[k] !== undefined).map(k => [k, canonical(x[k])]));
  return x;
}
export function predictionFingerprint(r) {
  const force = { ...r.force_recording }; delete force[KEY];
  return JSON.stringify(canonical({ id: r.id, date: r.date, grip: r.grip, hand: r.hand,
    session: r.session_id, set: r.set_num, rep: r.rep_num, target: r.target_duration,
    load: r.prescribed_load_kg, actual: r.actual_time_s, force: r.avg_force_kg,
    provenance: r.load_provenance, valid: r.failure_valid, ending: r.end_reason,
    timing: r.rep_timing ?? null, recording: force, adjustment: r.session_adjustment ?? null }));
}

function curve(result) {
  const c = result?.curveSnapshot;
  if (!c || c.source_days < 5 || !c.amps.every(n => Number.isFinite(n) && n >= 0)
    || !positive(c.scale)) return unavailable('needs_five_prior_days_and_curve');
  return { status: 'ready', ...c, taus: [...THREE_EXP_TAUS],
    planned_recommendation_kg: result.value, source: result.source };
}

// Same pre-session history/prior/anchor/bounds; only the candidate's fit points
// change. No evaluation outcome enters either fit. Clone to detach mutable refs.
export function buildPredictionModels(history, grip, hand, target, options = {}) {
  try {
    const freshMap = options.freshMap || buildFreshLoadMap(history);
    const keys = new Set(freshFitReps(history).map(repKey));
    const candidateMap = new Map([...freshMap].map(([key, value]) => [key,
      { ...value, capacityEligible: value.capacityEligible !== false && keys.has(key) }]));
    const opts = { ...options, freshMap, captureCurve: true };
    const current = curve(prescription(history, hand, grip, target, opts));
    const candidate = curve(prescription(history, hand, grip, target, { ...opts, freshMap: candidateMap }));
    const personal = buildPhysModel(history, hand, grip);
    const adaptive = buildAdaptiveShadow(history, hand, grip, target,
      options.shadowReferenceDate || options.referenceDate || ymdLocal());
    return copy({ experiment: PREDICTION_EXPERIMENT, grip, hand, current, candidate,
      adaptive,
      recovery: { current: personal, population: { ...personal, tauR: { ...PHYS_MODEL_DEFAULT.tauR } } } });
  } catch (_) {
    // Evaluation must never prevent recording a workout.
    return { experiment: PREDICTION_EXPERIMENT, grip, hand, current: unavailable('model_unavailable'),
      candidate: unavailable('model_unavailable') };
  }
}

function forceAt(model, seconds) {
  return model?.status === 'ready' ? predForceThreeExp(model.amps, seconds, model.taus) * model.scale : null;
}
function timeAt(model, load) {
  if (model?.status !== 'ready' || !positive(load)) return null;
  if (forceAt(model, 0) <= load || forceAt(model, 600) >= load) return null;
  let lo = 0, hi = 600;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (forceAt(model, mid) > load) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
function validMeasured(r) {
  return r.failure_valid === true && ['muscular_failure', 'target_force_failure'].includes(r.end_reason)
    && r.load_provenance === 'measured_force' && positive(r.avg_force_kg)
    && positive(r.actual_time_s) && r.force_recording?.signal_quality === 'complete'
    && r.force_recording?.capacity_eligible === true;
}
function sameLoad(a, b) { return positive(a) && positive(b) && Math.abs(a / b - 1) <= .10; }
function validPrefix(prefix, model) {
  return prefix.every((r, i) => validMeasured(r) && r.hand === model?.hand && r.grip === model?.grip
    && r.set_num === 1 && r.rep_num === i + 1 && r.session_id === prefix[0].session_id
    && r.force_recording.basis === prefix[0].force_recording.basis
    && sameLoad(r.avg_force_kg, prefix[0].avg_force_kg)
    && (!i || (Number.isFinite(r.rep_timing?.rest_before_s) && r.rep_timing.rest_before_s >= 0)));
}
function recoveryTimes(models, prefix, nextRest) {
  if (!models?.recovery || !prefix.length || !validPrefix(prefix, models)
    || !Number.isFinite(nextRest) || nextRest < 0) return null;
  const restIntervals = [...prefix.slice(1).map(r => r.rep_timing.rest_before_s), nextRest];
  return Object.fromEntries(Object.entries(models.recovery).map(([key, physModel]) => [key,
    predictRepTimes({ numReps: prefix.length + 1, firstRepTime: prefix[0].actual_time_s,
      restIntervals, physModel, roundTo: null }).at(-1)]));
}

// Pre-session scenario uses no observed opener or measured rests. It is stored
// separately from the existing forecasts updated after the opening hold.
function preSessionTimes(models, loadKg, rest, count) {
  const first = timeAt(models?.current, loadKg);
  if (!positive(first) || !models?.recovery || !Number.isFinite(rest) || rest < 0) return null;
  return Object.fromEntries(Object.entries(models.recovery).map(([key, physModel]) => [key,
    predictRepTimes({ numReps: count, firstRepTime: first, restSeconds: rest, physModel, roundTo: null }).at(-1)]));
}

export function preparePrediction(models, prefix, { loadKg, target, rest, preparedAt }) {
  if (!models) return null;
  return copy({ version: 1, experiment: PREDICTION_EXPERIMENT, mode: 'shadow',
    build: process.env.REACT_APP_BUILD_SHA || 'local', prepared_at: preparedAt,
    // Store the additional grid once on the opening hold, not on every rep.
    models: prefix.length ? { ...models, adaptive: undefined } : models,
    ...(!prefix.length ? { adaptive_planned: { current: timeAt(models.current, loadKg),
      candidate: adaptiveShadowTime(models.adaptive, loadKg) } } : {}),
    planned_load_kg: loadKg, target_s: target, planned_rest_s: rest,
    ...(prefix.length ? { pre_session: preSessionTimes(models, loadKg, rest, prefix.length + 1) } : {}),
    prior: prefix.map(r => ({ id: r.id, fingerprint: predictionFingerprint(r) })),
    planned: prefix.length ? recoveryTimes(models, prefix, rest) : {
      current: timeAt(models.current, loadKg), candidate: timeAt(models.candidate, loadKg) },
    kind: prefix.length ? 'recovery' : 'capacity' });
}

function observedInterval(rep, model) {
  if (model?.status !== 'ready') return null;
  if (model.duration_basis === 'target_acquired') {
    return rep.force_recording.basis === 'target_acquired' ? rep.actual_time_s : null;
  }
  if (rep.force_recording.basis !== 'target_acquired') return rep.actual_time_s;
  const ramp = rep.force_recording.acquisition_s;
  return Number.isFinite(ramp) && ramp >= 0 ? rep.actual_time_s + ramp : null;
}

export function completePrediction(prepared, prefix, rep) {
  if (!prepared) return null;
  const result = { ...prepared, outcome_fingerprint: predictionFingerprint(rep) };
  if (rep.hand !== prepared.models.hand || rep.grip !== prepared.models.grip || rep.set_num !== 1
    || rep.rep_num !== prefix.length + 1 || rep.force_recording?.session_protocol) {
    return { ...result, comparison: unavailable('different_protocol_or_sequence') };
  }
  if (!validMeasured(rep)) return { ...result, comparison: unavailable('unmeasured_or_interrupted') };
  if (prepared.kind === 'capacity') {
    const currentT = observedInterval(rep, prepared.models.current);
    const candidateT = observedInterval(rep, prepared.models.candidate);
    if (!positive(currentT) || currentT !== candidateT) {
      return { ...result, comparison: unavailable('missing_or_incompatible_curve') };
    }
    const adaptiveT = observedInterval(rep, prepared.models.adaptive);
    const adaptiveForce = adaptiveT === currentT ? adaptiveShadowForce(prepared.models.adaptive, adaptiveT) : null;
    const adaptiveComparison = Number.isFinite(adaptiveForce) ? {
      status: 'recorded', experiment: ADAPTIVE_PREDICTION_EXPERIMENT,
      kind: 'force_at_observed_duration', actual: rep.avg_force_kg, observed_s: currentT,
      current: forceAt(prepared.models.current, currentT), candidate: adaptiveForce,
      established: predForceThreeExp(prepared.models.adaptive.established_amps, currentT),
      planned_matches: positive(prepared.planned_load_kg) && Math.abs(rep.avg_force_kg / prepared.planned_load_kg - 1) <= .05,
    } : unavailable('adaptive_missing_or_incompatible_curve');
    return { ...result, adaptive_comparison: adaptiveComparison,
      comparison: { status: 'recorded', actual: rep.avg_force_kg,
      observed_s: currentT, current: forceAt(prepared.models.current, currentT),
      candidate: forceAt(prepared.models.candidate, currentT),
      // At-eventual-duration is a conditional check, not an advance forecast.
      kind: 'force_at_observed_duration',
      planned_matches: sameLoad(rep.avg_force_kg, prepared.planned_load_kg) } };
  }
  const rest = rep.rep_timing?.rest_before_s;
  if (!validPrefix([...prefix, rep], prepared.models)) {
    return { ...result, comparison: unavailable('incomparable_recovery_sequence') };
  }
  const conditional = recoveryTimes(prepared.models, prefix, rest);
  if (!conditional) return { ...result, comparison: unavailable('missing_actual_rest') };
  return { ...result, comparison: { status: 'recorded', kind: 'time_at_actual_rest',
    actual: rep.actual_time_s, current: conditional.current, candidate: conditional.population,
    pre_session_matches: [...prefix, rep].every((r, i) =>
      sameLoad(r.avg_force_kg, prepared.planned_load_kg)
      && (!i || Math.abs(r.rep_timing.rest_before_s - prepared.planned_rest_s) <= 2)
      && (r.force_recording.basis === 'target_acquired') === (prepared.models.current.duration_basis === 'target_acquired')),
    planned_matches: sameLoad(rep.avg_force_kg, prepared.planned_load_kg)
      && Math.abs(rest - prepared.planned_rest_s) <= 2 } };
}

const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
// Each training day gets equal weight, regardless of reps, hands or sessions.
export function predictionMetrics(rows, model) {
  const byDay = new Map();
  for (const r of rows) {
    if (!positive(r.actual) || !Number.isFinite(r[model])) continue;
    if (!byDay.has(r.date)) byDay.set(r.date, []);
    byDay.get(r.date).push(r[model] - r.actual);
  }
  const days = [...byDay.values()];
  return { days: days.length, observations: days.reduce((n, rs) => n + rs.length, 0),
    mae: mean(days.map(rs => mean(rs.map(Math.abs)))),
    rmse: days.length ? Math.sqrt(mean(days.map(rs => mean(rs.map(e => e * e))))) : null,
    bias: mean(days.map(rs => mean(rs))),
    worst: days.length ? Math.max(...days.flat().map(Math.abs)) : null };
}

const scores = rows => ({ current: predictionMetrics(rows, 'current'), candidate: predictionMetrics(rows, 'candidate') });
export function summarizePredictions(history) {
  const exclusions = {}, force = [], recovery = [], plannedForce = [], plannedRecovery = [];
  const adaptiveForce = [], adaptivePlanned = [], preSessionRecovery = [], prescriptionStages = [];
  const skip = key => { exclusions[key] = (exclusions[key] || 0) + 1; };
  const byId = new Map(), conflicts = new Set();
  for (const r of history || []) {
    if (byId.has(r.id) && JSON.stringify(canonical(byId.get(r.id))) !== JSON.stringify(canonical(r))) conflicts.add(r.id);
    byId.set(r.id, r);
  }
  const locations = new Map();
  const location = r => `${r.session_id}|${r.hand}|${r.set_num}|${r.rep_num}`;
  for (const r of byId.values()) {
    if (!r.force_recording?.[KEY]) continue;
    const key = location(r);
    if (!locations.has(key)) locations.set(key, []);
    locations.get(key).push(r.id);
  }
  for (const ids of locations.values()) if (ids.length > 1) ids.forEach(id => conflicts.add(id));
  for (const r of byId.values()) {
    const p = r.force_recording?.[KEY];
    if (!p) continue;
    if (conflicts.has(r.id)) { skip('conflicting_copy'); continue; }
    if (p.version !== 1 || p.experiment !== PREDICTION_EXPERIMENT) { skip('different_experiment'); continue; }
    if (r.set_num !== 1 || r.force_recording?.session_protocol || !r.date || !['capacity', 'recovery'].includes(p.kind)) {
      skip('different_protocol'); continue;
    }
    if (p.outcome_fingerprint !== predictionFingerprint(r) || p.prior?.some(x =>
      conflicts.has(x.id) || !byId.has(x.id) || predictionFingerprint(byId.get(x.id)) !== x.fingerprint)) {
      skip('edited_or_missing_record'); continue;
    }
    const c = p.comparison;
    if (c?.status !== 'recorded' || !Number.isFinite(c.current) || !Number.isFinite(c.candidate)) {
      skip(c?.reason || 'unavailable'); continue;
    }
    const row = { id: r.id, date: r.date, grip: r.grip, hand: r.hand, domain: zoneOf(r.target_duration),
      observedDomain: zoneOf(r.actual_time_s), rep: r.rep_num,
      restSeconds: r.rep_timing?.rest_before_s ?? null,
      restBand: r.rep_timing?.rest_before_s == null ? 'unknown' : r.rep_timing.rest_before_s < 30 ? 'under_30s' : r.rep_timing.rest_before_s < 60 ? '30_to_59s' : '60s_plus',
      basis: r.force_recording?.basis || 'legacy_elapsed',
      priorDays: p.models?.current?.source_days ?? null,
      priorDaysBand: p.models?.current?.source_days == null ? 'unknown' : p.models.current.source_days < 10 ? '5–9' : p.models.current.source_days < 20 ? '10–19' : p.models.current.source_days < 50 ? '20–49' : '50+',
      cooked: r.session_adjustment?.reported_cooked ?? null,
      actual: c.actual, current: c.current, candidate: c.candidate };
    (p.kind === 'capacity' ? force : recovery).push(row);
    if (p.kind === 'capacity') {
      const adaptive = p.models?.adaptive;
      const established = adaptive?.status === 'ready' && Array.isArray(adaptive.established_amps)
        ? predForceThreeExp(adaptive.established_amps, p.target_s) : null;
      const adjusted = adaptiveShadowForce(adaptive, p.target_s);
      prescriptionStages.push({ id: r.id, date: r.date, grip: r.grip, hand: r.hand,
        targetSeconds: p.target_s, establishedKg: established, adjustedKg: adjusted,
        recentChangeKg: established != null && adjusted != null ? adjusted - established : null,
        candidateBoundedKg: adaptive?.planned_recommendation_kg ?? null,
        currentCurveKg: forceAt(p.models.current, p.target_s), finalPlannedKg: p.planned_load_kg,
        reportedCooked: r.session_adjustment?.reported_cooked ?? null,
        adjustment: r.session_adjustment ?? null });
    }
    if (p.kind === 'recovery' && c.pre_session_matches
      && Number.isFinite(p.pre_session?.current) && Number.isFinite(p.pre_session?.population)) {
      preSessionRecovery.push({ ...row, actual: c.actual,
        current: p.pre_session.current, candidate: p.pre_session.population });
    }
    const a = p.adaptive_comparison;
    if (p.kind === 'capacity' && a?.status === 'recorded'
      && a.experiment === ADAPTIVE_PREDICTION_EXPERIMENT
      && p.models?.adaptive?.experiment === ADAPTIVE_PREDICTION_EXPERIMENT
      && p.models.adaptive.version === 2 && r.target_duration >= 12
      && Number.isFinite(a.current) && Number.isFinite(a.candidate)) {
      const adaptiveRow = { ...row, actual: a.actual, current: a.current, candidate: a.candidate, established: a.established };
      adaptiveForce.push(adaptiveRow);
      if (a.planned_matches && Number.isFinite(p.adaptive_planned?.current) && Number.isFinite(p.adaptive_planned?.candidate))
        adaptivePlanned.push({ ...adaptiveRow, actual: a.observed_s, ...p.adaptive_planned });
    }
    const candidate = p.kind === 'capacity' ? p.planned?.candidate : p.planned?.population;
    if (c.planned_matches && Number.isFinite(p.planned?.current) && Number.isFinite(candidate)) {
      (p.kind === 'capacity' ? plannedForce : plannedRecovery).push({ ...row,
        actual: c.observed_s ?? c.actual, current: p.planned.current, candidate });
    }
  }
  const dates = [...new Set(force.map(r => r.date))].sort();
  const by = key => Object.fromEntries([...new Set(force.map(r => r[key]))].map(value => [value, scores(force.filter(r => r[key] === value))]));
  const adaptiveDates = [...new Set(adaptiveForce.map(r => r.date))].sort();
  const adaptiveBy = key => Object.fromEntries([...new Set(adaptiveForce.map(r => r[key]))]
    .map(value => [value, scores(adaptiveForce.filter(r => r[key] === value))]));
  const breakdown = rows => Object.fromEntries(['grip', 'hand', 'domain', 'rep', 'restBand', 'basis', 'priorDaysBand']
    .map(key => [key, Object.fromEntries([...new Set(rows.map(r => r[key]))].map(value =>
      [value, scores(rows.filter(r => r[key] === value))]))]));
  return { experiment: PREDICTION_EXPERIMENT, status: 'review_required_before_any_model_change',
    dates, days: dates.length, checkpoints: Math.floor(dates.length / REVIEW_DAYS),
    daysToNextCheckpoint: REVIEW_DAYS - dates.length % REVIEW_DAYS,
    diagnostics: { force: breakdown(force), recovery: breakdown(recovery),
      plannedRecovery: breakdown(plannedRecovery), preSessionRecovery: breakdown(preSessionRecovery) },
    prescriptionStages,
    preSessionRecovery: scores(preSessionRecovery),
    force: scores(force), recovery: scores(recovery), plannedForce: scores(plannedForce), plannedRecovery: scores(plannedRecovery),
    lastTenDays: scores(force.filter(r => dates.slice(-REVIEW_DAYS).includes(r.date))),
    byGrip: by('grip'), byHand: by('hand'), byDomain: by('domain'), byObservedDomain: by('observedDomain'),
    adaptive: { experiment: ADAPTIVE_PREDICTION_EXPERIMENT, days: adaptiveDates.length, dates: adaptiveDates,
      checkpoints: Math.floor(adaptiveDates.length / REVIEW_DAYS),
      daysToNextCheckpoint: REVIEW_DAYS - adaptiveDates.length % REVIEW_DAYS,
      force: scores(adaptiveForce), established: predictionMetrics(adaptiveForce, 'established'),
      plannedForce: scores(adaptivePlanned), byGrip: adaptiveBy('grip'), byHand: adaptiveBy('hand'),
      byDomain: adaptiveBy('domain'), byObservedDomain: adaptiveBy('observedDomain'),
      observations: { force: adaptiveForce, plannedForce: adaptivePlanned } },
    exclusions, observations: { force, recovery, plannedForce, plannedRecovery, preSessionRecovery } };
}

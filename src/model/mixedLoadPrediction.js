// Shadow experiment only. Nothing in this module changes prescribed loads,
// failure detection, capacity eligibility or the regular ladder.
import { freshFitReps } from './load.js';
import { fitThreeExpAmps, predForceThreeExp, THREE_EXP_TAUS } from './threeExp.js';
import { PHYS_MODEL_DEFAULT } from './fatigue.js';
import { computePersonalRecoveryTausForGrip } from './recoveryFit.js';
import { isMixedDomainRep } from './mixedDomain.js';

export const MIXED_PREDICTION_VERSION = 1;
const KEYS = ['fast', 'medium', 'slow'];
const finitePositive = x => Number.isFinite(x) && x > 0;
const validLoad = x => finitePositive(x) && x < 200;
const round = x => Math.round(x * 1000) / 1000;
const fingerprint = r => JSON.stringify([r.hand, r.grip, r.rep_num, r.session_id, r.actual_time_s,
  r.avg_force_kg, r.failure_valid, r.end_reason, r.load_provenance, r.rep_timing,
  Object.fromEntries(Object.entries(r.force_recording || {}).filter(([k]) => k !== 'mixed_load_prediction'))]);
const sessionKey = r => r.session_id || r.session_started_at || r.date;
const unavailable = reason => ({ status: 'unavailable', reason });

// One session gets one vote. The current session is never included: callers
// construct this snapshot at Start Session, before any new rep is recorded.
export function buildMixedLoadModel(history, grip, hand, asOf) {
  const cutoff = Date.parse(asOf);
  const prior = (history || []).filter(r => r.grip === grip && r.hand === hand
    && Date.parse(r.date) <= cutoff && cutoff - Date.parse(r.date) <= 90 * 86400000);
  const rows = freshFitReps(prior).filter(r => validLoad(r.avg_force_kg)
    && finitePositive(r.actual_time_s) && r.actual_time_s <= 600);
  const sessions = new Set(rows.map(sessionKey));
  const durations = rows.map(r => r.actual_time_s);
  if (sessions.size < 5 || Math.max(...durations) / Math.min(...durations) < 3) {
    return unavailable('insufficient_fresh_history');
  }
  const counts = new Map();
  rows.forEach(r => counts.set(sessionKey(r), (counts.get(sessionKey(r)) || 0) + 1));
  const amps = fitThreeExpAmps(rows.map(r => ({ T: r.actual_time_s, F: r.avg_force_kg,
    w: 1 / counts.get(sessionKey(r)) })));
  if (!amps?.every(x => Number.isFinite(x) && x >= 0) || !validLoad(amps.reduce((s, x) => s + x, 0))) {
    return unavailable('invalid_fresh_curve');
  }
  const recovery = computePersonalRecoveryTausForGrip(prior, grip);
  return { status: 'ready', version: MIXED_PREDICTION_VERSION, as_of: asOf, grip, hand,
    amps, curve_taus: [...THREE_EXP_TAUS],
    duration_basis: rows.every(r => r.force_recording?.basis === 'target_acquired'
      && !r.force_recording?.interval_basis_applied) ? 'target_acquired' : 'legacy_elapsed',
    source_sessions: sessions.size, min_duration_s: Math.min(...durations), max_duration_s: Math.max(...durations),
    last_evidence_date: rows.map(r => r.date).sort().at(-1),
    depletion_taus: KEYS.map(k => PHYS_MODEL_DEFAULT.tauD[k]),
    recovery_taus: KEYS.map(k => (recovery || PHYS_MODEL_DEFAULT.tauR)[k]),
    recovery_source: recovery ? 'historical_constant_load_fit' : 'population_prior',
    weights: KEYS.map(k => PHYS_MODEL_DEFAULT.weights[k]) };
}

// Empirical candidate: load × time depletes three mathematical states;
// measured rest restores them. Their weighted availability scales the fresh
// force-duration envelope. The fresh envelope already describes fatigue
// during the upcoming hold, so we do not apply depletion twice in that root.
// These states are NOT measurements of tissue or energy systems.
export function consumeMixedHold(model, state, impulseKgS) {
  const maximum = model.amps.reduce((s, x) => s + x, 0);
  return state.map((v, i) => v * Math.exp(-impulseKgS / maximum / model.depletion_taus[i]));
}
export function recoverMixedState(model, state, seconds) {
  return state.map((v, i) => 1 - (1 - v) * Math.exp(-seconds / model.recovery_taus[i]));
}
export function mixedHoldTime(model, state, loadKg) {
  if (model?.status !== 'ready' || !validLoad(loadKg)) return unavailable('invalid_load_or_model');
  const availability = state.reduce((sum, v, i) => sum + v * model.weights[i], 0);
  const force = t => availability * predForceThreeExp(model.amps, t, model.curve_taus);
  if (force(0) <= loadKg) return { status: 'above_available_force', seconds: 0 };
  if (force(600) >= loadKg) return { status: 'beyond_horizon', seconds: null };
  let lo = 0, hi = 600;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (force(mid) > loadKg) lo = mid; else hi = mid;
  }
  return { status: 'estimated', seconds: round((lo + hi) / 2) };
}

function usableActivity(rep) {
  const f = rep.force_recording;
  // capacity_eligible is deliberately false on beta holds 2–5. Check the
  // actual signal/ending instead, and never substitute prescribed load.
  if (rep.failure_valid !== true || !['muscular_failure', 'target_force_failure'].includes(rep.end_reason)) return null;
  if (rep.load_provenance !== 'measured_force' || !validLoad(rep.avg_force_kg)
    || f?.signal_quality !== 'complete' || !finitePositive(rep.actual_time_s)) return null;
  const activity = f.activity || f;
  if (activity.signal_quality !== 'complete' || !finitePositive(activity.duration_s)
    || !finitePositive(activity.impulse_kg_s)) return null;
  return activity;
}

// Prefix consists ONLY of completed holds from this hand/session. Missing
// rest or interrupted effort stops the chain; it never silently becomes fresh.
export function mixedStateBefore(model, prefix, restBeforeS) {
  if (model?.status !== 'ready') return unavailable(model?.reason || 'no_model');
  let state = [1, 1, 1];
  for (let i = 0; i < prefix.length; i++) {
    const r = prefix[i];
    if (!isMixedDomainRep(r) || r.hand !== model.hand || r.grip !== model.grip
      || r.session_id !== prefix[0].session_id || r.rep_num !== i + 1) return unavailable('invalid_sequence');
    if (i) {
      const rest = r.rep_timing?.rest_before_s;
      if (!Number.isFinite(rest) || rest < 0) return unavailable('missing_actual_rest');
      state = recoverMixedState(model, state, rest);
    }
    const activity = usableActivity(r);
    if (!activity) return unavailable('unmeasured_or_interrupted_prefix');
    state = consumeMixedHold(model, state, activity.impulse_kg_s);
  }
  if (prefix.length) {
    if (!Number.isFinite(restBeforeS) || restBeforeS < 0) return unavailable('missing_actual_rest');
    state = recoverMixedState(model, state, restBeforeS);
  }
  return { status: 'ready', state };
}

// Created while preparing the hold. Uses the planned rest before this hold;
// the prefix has the actual force, duration and rest already recorded.
export function prepareMixedPrediction(model, prefix, loadKg, plannedRestS) {
  const before = mixedStateBefore(model, prefix, plannedRestS);
  return { version: MIXED_PREDICTION_VERSION, mode: 'shadow', model,
    prior_rep_ids: prefix.map(r => r.id), prior_fingerprints: prefix.map(fingerprint), load_kg: loadKg,
    rest_s: prefix.length ? plannedRestS : 0, rest_basis: 'planned_next_rest',
    prediction: before.status === 'ready' ? mixedHoldTime(model, before.state, loadKg) : before,
    fresh_only: mixedHoldTime(model, [1, 1, 1], loadKg) };
}

// Separate diagnostic, reconstructed at completion using actual mean load and
// actual rest. Never call this a prospective forecast or use this rep to fit
// its own model. Overshoots remain usable; they change the load being evaluated.
export function completeMixedPrediction(prepared, prefix, rep) {
  const result = { ...prepared, observation: {
    actual_time_s: rep.actual_time_s, avg_force_kg: rep.avg_force_kg,
    rest_before_s: rep.rep_timing?.rest_before_s, failure_valid: rep.failure_valid,
    end_reason: rep.end_reason, load_provenance: rep.load_provenance, force_recording: { ...rep.force_recording },
  } };
  if (!usableActivity(rep)) return { ...result, comparison: unavailable('unmeasured_or_interrupted_hold') };
  const model = prepared.model;
  const before = mixedStateBefore(model, prefix, rep.rep_timing?.rest_before_s);
  if (before.status !== 'ready') return { ...result, comparison: before };
  let observed = rep.actual_time_s;
  if (model.duration_basis === 'legacy_elapsed' && rep.force_recording?.basis === 'target_acquired') {
    const acquisition = rep.force_recording.acquisition_s;
    if (!Number.isFinite(acquisition) || acquisition < 0) return { ...result, comparison: unavailable('incompatible_duration_basis') };
    observed += acquisition;
  } else if (model.duration_basis === 'target_acquired' && rep.force_recording?.basis !== 'target_acquired') {
    return { ...result, comparison: unavailable('incompatible_duration_basis') };
  }
  const conditional = mixedHoldTime(model, before.state, rep.avg_force_kg);
  const fresh = mixedHoldTime(model, [1, 1, 1], rep.avg_force_kg);
  return { ...result, comparison: { status: 'recorded', kind: 'actual_load_and_rest_diagnostic',
    observed_s: observed, conditional, fresh_only: fresh,
    // Loose matching is only for reporting the original planned scenario.
    // All valid measured overshoots still enter the separate conditional check.
    planned_scenario_matches: Math.abs(rep.avg_force_kg / prepared.load_kg - 1) <= .10
      && (!prefix.length || Math.abs(rep.rep_timing.rest_before_s - prepared.rest_s) <= 2) } };
}

// Session means first: ten holds from one workout cannot masquerade as ten
// independent validations. Report versions separately; skip edited records.
export function summarizeMixedPredictions(history) {
  const groups = new Map(), excluded = {};
  const exclude = reason => { excluded[reason] = (excluded[reason] || 0) + 1; };
  const seen = new Set();
  const byId = new Map((history || []).map(r => [r.id, r]));
  for (const r of history || []) {
    const p = r.force_recording?.mixed_load_prediction;
    if (!p || !isMixedDomainRep(r)) continue;
    const key = `${r.session_id}|${r.hand}|${r.rep_num}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (p.prior_rep_ids?.some((id, i) => !byId.has(id) || fingerprint(byId.get(id)) !== p.prior_fingerprints?.[i])) {
      exclude('edited_or_missing_prefix'); continue;
    }
    const o = p.observation;
    const f = { ...r.force_recording }; delete f.mixed_load_prediction;
    if (!o || o.actual_time_s !== r.actual_time_s || o.avg_force_kg !== r.avg_force_kg
      || o.rest_before_s !== r.rep_timing?.rest_before_s || o.failure_valid !== r.failure_valid
      || o.end_reason !== r.end_reason || o.load_provenance !== r.load_provenance || JSON.stringify(o.force_recording) !== JSON.stringify(f)) {
      exclude('edited_since_prediction'); continue;
    }
    const c = p.comparison;
    if (c?.status !== 'recorded') { exclude(c?.reason || 'unavailable'); continue; }
    // An opener does not test mixed-load fatigue; report later holds only.
    if (r.rep_num === 1) { exclude('opening_hold'); continue; }
    if (!Number.isFinite(c.conditional.seconds) || !Number.isFinite(c.fresh_only.seconds)) {
      exclude('out_of_range'); continue;
    }
    for (const category of ['all', `domain:${r.force_recording.session_protocol.zone}`, `position:${r.rep_num}`]) {
      const groupKey = `v${p.version}|${category}`;
      if (!groups.has(groupKey)) groups.set(groupKey, new Map());
      const sessions = groups.get(groupKey);
      const sid = r.session_id || r.session_started_at || r.date;
      if (!sessions.has(sid)) sessions.set(sid, []);
      sessions.get(sid).push({ error: Math.abs(c.conditional.seconds - c.observed_s),
        baseline: Math.abs(c.fresh_only.seconds - c.observed_s),
        planned: c.planned_scenario_matches && Number.isFinite(p.prediction.seconds)
          ? Math.abs(p.prediction.seconds - c.observed_s) : null });
    }
  }
  const mean = xs => xs.length ? round(xs.reduce((s, x) => s + x, 0) / xs.length) : null;
  return { status: 'experimental_not_validated', excluded, groups: Object.fromEntries([...groups].map(([key, sessions]) => {
    const values = [...sessions.values()];
    const planned = values.map(rs => mean(rs.map(r => r.planned).filter(x => x != null))).filter(x => x != null);
    return [key, { sessions: sessions.size, holds: values.reduce((s, rs) => s + rs.length, 0),
      conditional_mae_s: mean(values.map(rs => mean(rs.map(r => r.error)))),
      fresh_only_mae_s: mean(values.map(rs => mean(rs.map(r => r.baseline)))),
      planned_scenario_sessions: planned.length, planned_scenario_mae_s: mean(planned) }];
  })) };
}

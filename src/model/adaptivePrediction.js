// Prospective snapshots only. These values never select a workout load.
import { buildAdaptiveCapacity, adaptiveFloorReplay, applyAdaptiveBounds } from './adaptiveCapacityExperiment.js';
import { comparableCapacityHistory } from './forceRecording.js';
import { loadBounds, EXTRAP_FLOOR_MULT } from './prescription.js';

export const ADAPTIVE_PREDICTION_EXPERIMENT = 'established-recent-v2';
export function buildAdaptiveShadow(history, hand, grip, target, referenceDate) {
  try {
    if (!(target >= 12 && target <= 600)) return { status: 'unavailable', reason: 'not_standard_duration' };
    const prior = history.filter(r => r.date < referenceDate);
    const model = buildAdaptiveCapacity(prior, hand, grip, referenceDate);
    if (!model) return { status: 'unavailable', reason: 'needs_five_prior_days' };
    const bounds = loadBounds(comparableCapacityHistory(prior), hand, grip, target, { referenceDate });
    const revision = adaptiveFloorReplay(prior, hand, grip, target, referenceDate, bounds.floorKg);
    const raw = Math.round(model.forceAt(Math.min(target, model.maxDuration * EXTRAP_FLOOR_MULT)) * 10) / 10;
    return { status: 'ready', experiment: ADAPTIVE_PREDICTION_EXPERIMENT, version: 2,
      history_before: referenceDate, source_days: model.days,
      last_evidence_date: model.lastDate, evidence_age_days: model.evidenceAgeDays,
      duration_basis: model.openers.every(r => r.force_recording?.basis === 'target_acquired'
        && !r.force_recording?.interval_basis_applied) ? 'target_acquired' : 'legacy_elapsed',
      times: [...model.times], forces: [...model.forces], established_amps: [...model.established],
      target_s: target, planned_recommendation_kg: applyAdaptiveBounds(raw, bounds, revision.floor),
      original_floor_kg: bounds.floorKg, revised_floor_kg: revision.floor,
      evidence: model.evidenceAt(target), floor_events: revision.events };
  } catch (_) {
    // A research calculation must never prevent someone recording a workout.
    return { status: 'unavailable', reason: 'adaptive_model_unavailable' };
  }
}

export function adaptiveShadowForce(model, duration) {
  if (model?.status !== 'ready' || !(duration >= 0 && duration <= 600)) return null;
  const hi = model.times.findIndex(t => t >= duration);
  if (hi < 0) return null;
  if (!hi || model.times[hi] === duration) return model.forces[hi];
  const fraction = (duration - model.times[hi - 1]) / (model.times[hi] - model.times[hi - 1]);
  return Math.exp(Math.log(model.forces[hi - 1]) * (1 - fraction) + Math.log(model.forces[hi]) * fraction);
}
export function adaptiveShadowTime(model, force) {
  if (!(force > 0) || model?.status !== 'ready') return null;
  if (force > adaptiveShadowForce(model, 0) || force < adaptiveShadowForce(model, 600)) return null;
  let lo = 0, hi = 600;
  for (let i = 0; i < 50; i++) {
    const t = (lo + hi) / 2;
    if (adaptiveShadowForce(model, t) > force) lo = t; else hi = t;
  }
  return (lo + hi) / 2;
}

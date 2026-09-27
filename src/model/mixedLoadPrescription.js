import { predForceThreeExp } from './threeExp.js';
import { mixedStateBefore, prepareMixedPrediction } from './mixedLoadPrediction.js';

// Experimental prescription layer over the frozen mixed-load forecast.
// Apply the user's elected readiness reduction once to the model as well as
// the existing reference-load ceiling. Never fit on this session's outcomes.
export function mixedReadinessModel(model, multiplier = 1) {
  if (model?.status !== 'ready') return model;
  const scale = Number.isFinite(multiplier) && multiplier > 0 && multiplier <= 1 ? multiplier : 1;
  return { ...model, amps: model.amps.map(a => a * scale), readiness_multiplier: scale };
}

export function prepareAdaptiveMixedPrediction(model, prefix, { baselineKg, targetTime, plannedRestS }) {
  const baseline = Math.round(baselineKg * 10) / 10;
  let load = baseline;
  const adjustment = { version: 1, status: 'opening_hold', target_s: targetTime,
    original_load_kg: baseline, rest_basis: 'planned_next_rest' };
  if (prefix.length) {
    const before = mixedStateBefore(model, prefix, plannedRestS);
    let reason = before.status !== 'ready' ? before.reason : null;
    if (!reason && (!Number.isFinite(targetTime) || targetTime < model.min_duration_s
      || targetTime > model.max_duration_s)) reason = 'outside_measured_duration_range';
    if (!reason) {
      const availability = before.state.reduce((sum, v, i) => sum + v * model.weights[i], 0);
      const candidate = availability * predForceThreeExp(model.amps, targetTime, model.curve_taus);
      if (!Number.isFinite(candidate) || candidate < 0.1 || !(baseline > 0)) {
        reason = 'unusable_load_estimate';
      } else {
        // Do not increase a planned load based on an unvalidated fatigue model.
        load = Math.min(baseline, Math.round(candidate * 10) / 10);
        adjustment.status = candidate > baseline ? 'capped_at_original' : 'adjusted';
        adjustment.unrounded_load_kg = candidate;
      }
    }
    if (reason) Object.assign(adjustment, { status: 'unavailable', reason });
  }
  adjustment.selected_load_kg = load;
  return { ...prepareMixedPrediction(model, prefix, load, plannedRestS),
    mode: 'adaptive_targets', adjustment };
}

export function mixedAdjustmentText(adjustment) {
  if (!adjustment || adjustment.status === 'opening_hold') return null;
  if (adjustment.status === 'unavailable') return 'Adjustment unavailable for this hold. Using the original load; change it if needed.';
  if (adjustment.status === 'capped_at_original') return `Keeping the original load. You may hold longer than ${adjustment.target_s}s.`;
  return `Load adjusted to aim for about ${adjustment.target_s}s after the planned rest. Hold until failure; the time is an estimate.`;
}

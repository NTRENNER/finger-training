import { predForceThreeExp } from './threeExp.js';
import { buildMixedLoadModel, mixedStateBefore, prepareMixedPrediction } from './mixedLoadPrediction.js';

// Shared by setup and the runner: a fitted model alone does not establish
// support for every duration. Setup cannot predict future recording quality.
export function mixedTargetReadiness(model, targetTime) {
  if (model?.status !== 'ready') return { status: 'unavailable', reason: model?.reason || 'insufficient_fresh_history' };
  if (!Number.isFinite(targetTime) || targetTime < model.min_duration_s || targetTime > model.max_duration_s) {
    return { status: 'unavailable', reason: 'outside_measured_duration_range' };
  }
  return { status: 'ready' };
}

export function mixedPlanReadiness(history, grip, hands, plan, asOf) {
  const byHand = Object.fromEntries(hands.map(hand => {
    const model = buildMixedLoadModel(history, grip, hand, asOf);
    return [hand, plan.steps.map((step, i) => i === 0 ? { status: 'opening_hold' }
      : mixedTargetReadiness(model, step.targetTime))];
  }));
  const later = Object.values(byHand).flat().filter(s => s.status !== 'opening_hold');
  const ready = later.filter(s => s.status === 'ready').length;
  return { byHand, status: ready === later.length ? 'ready' : ready ? 'partial' : 'unavailable' };
}

// Keep requested policy separate from the actual decision for this hold.
export function mixedLoadProtocolFields(requested, adjustment, position) {
  const status = !requested ? 'not_requested' : position === 1 ? 'opening_hold' : adjustment?.status || 'unavailable';
  const applied = ['adjusted', 'capped_at_original'].includes(status);
  return {
    requested_load_mode: requested ? 'adaptive_targets' : 'fixed_references',
    load_mode: !requested ? 'fixed_references' : position === 1 ? 'opening_reference'
      : applied ? 'adaptive_targets' : 'reference_fallback',
    duration_reference: applied ? 'approximate_hold_target' : 'fresh_load_reference',
    adjustment_status: status,
    ...(requested && position > 1 && !applied ? { adjustment_reason: adjustment?.reason || 'unavailable' } : {}),
  };
}

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
    if (!reason) reason = mixedTargetReadiness(model, targetTime).reason;
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
  if (adjustment.status === 'unavailable') {
    const reason = {
      unmeasured_or_interrupted_prefix: 'An earlier hold has incomplete measurements or was recorded as interrupted.',
      missing_actual_rest: 'The rest between earlier holds was not fully measured.',
      outside_measured_duration_range: 'This target time is outside the durations measured for this hand.',
      insufficient_fresh_history: 'There is not enough measured history for this hand yet.',
      invalid_sequence: 'The earlier holds could not be matched to this sequence.',
    }[adjustment.reason] || 'The available measurements do not support an updated target yet.';
    return `${reason} Automatic target adjustment is unavailable. Showing the original target weight; it may not match the target time after earlier holds.`;
  }
  if (adjustment.status === 'capped_at_original') return `Target weight unchanged. You may hold longer than ${adjustment.target_s}s.`;
  return `New target weight aims for about ${adjustment.target_s}s after the planned rest. Pull steadily at this target until failure; the time is an estimate.`;
}

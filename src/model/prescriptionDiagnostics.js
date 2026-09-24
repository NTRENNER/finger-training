// Offline stage trace for the forward evaluator. No live recommendation caller.
import { comparableCapacityHistory, isCapacityEvidenceRep } from './forceRecording.js';
import { effectiveLoad, isFirstSetRep, isSeedArtifactRep } from './load.js';
import { EXTRAP_FLOOR_MULT, freshLoadFor, prescription, repKey } from './prescription.js';
import { fitThreeExpAmps, predForceThreeExp, THREE_EXP_LAMBDA_DEFAULT } from './threeExp.js';

// Dependencies must come from the evaluator's same strictly-earlier history.
// Reconstruct the fit to isolate raw-load vs fatigue-adjusted inputs, then
// verify against the production result so a future implementation change fails
// loudly rather than leaving a silently stale analysis.
export function tracePrescription(history, hand, grip, duration, options, result) {
  if (!['anchored-curve', 'unanchored-curve'].includes(result?.source)) return null;
  const { freshMap, threeExpPriors, referenceDate } = options;
  const points = comparableCapacityHistory(history.filter(r => isFirstSetRep(r) && r.date < referenceDate))
    .filter(r => isCapacityEvidenceRep(r) && freshMap.get(repKey(r))?.capacityEligible !== false
      && r.hand === hand && r.grip === grip && r.actual_time_s > 0 && effectiveLoad(r) > 0 && !isSeedArtifactRep(r));
  const fitOptions = { prior: threeExpPriors.get(grip), lambda: THREE_EXP_LAMBDA_DEFAULT / Math.max(1, points.length) };
  const amps = fitThreeExpAmps(points.map(r => ({ T: r.actual_time_s, F: freshLoadFor(r, freshMap) })), fitOptions);
  const rawAmps = fitThreeExpAmps(points.map(r => ({ T: r.actual_time_s, F: effectiveLoad(r) })), fitOptions);
  const fatigueCurve = predForceThreeExp(amps, duration);
  if (!Number.isFinite(fatigueCurve) || Math.abs(fatigueCurve - result.potential) > 0.050001) {
    throw new Error('Prescription diagnostic no longer matches the production fit');
  }
  const anchoredCurve = fatigueCurve * result.scale;
  const rounded = Math.round(anchoredCurve * 10) / 10;
  const longest = Math.max(...points.map(r => r.actual_time_s));
  const extrapolatedCurve = duration > longest * EXTRAP_FLOOR_MULT
    ? Math.max(rounded, Math.round(predForceThreeExp(amps, longest * EXTRAP_FLOOR_MULT) * result.scale * 10) / 10)
    : rounded;
  const sameDomainAnchor = prescription(history, hand, grip, duration, { ...options, zoneAnchor: true });
  return {
    predictions: { rawCurve: predForceThreeExp(rawAmps, duration), fatigueCurve, anchoredCurve,
      extrapolatedCurve, sameDomainAnchor: sameDomainAnchor?.value ?? null },
    details: { fitPoints: points.length, anchor: result.anchor, scale: result.scale,
      extrapolationChangeKg: extrapolatedCurve - rounded,
      boundsChangeKg: result.value - extrapolatedCurve,
      capacityFloorKg: result.capacityFloorKg, peakCapKg: result.peakCapKg,
      enduranceCeilKg: result.enduranceCeilKg, enduranceCeiled: result.enduranceCeiled,
      capacityFloored: result.capacityFloored, extrapFloored: result.extrapFloored },
  };
}

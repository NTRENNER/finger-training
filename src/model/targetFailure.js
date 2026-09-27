// Acquire the prescribed force before detecting failure. Allow small dips
// within the policy tolerance; confirm continuous drops below that boundary.
export const TARGET_FAILURE_POLICY = Object.freeze({
  version: 6, below_target_fraction: 0.93, confirmation_ms: 1000,
  minimum_drop_kg: 0.45359237, // 1 lb, independent of display units
  maximum_drop_fraction: 0.20, // bound the allowance for very light targets
});

// Targeted training can use loads below the legacy 4 kg start / 3 kg
// release thresholds. Keep release well below the failure boundary, so it
// cannot override the tolerance band or re-arm while the athlete still pulls.
// Untargeted pulls and timed warmups retain the legacy thresholds.
export function repDetectionThresholds(targetKg) {
  const target = Number(targetKg);
  if (!(target > 0) || !Number.isFinite(target)) return { startKg: 4, releaseKg: 3 };
  return { startKg: Math.min(4, target * 0.8), releaseKg: Math.min(3, target * 0.5) };
}

export function createTargetFailureDetector(targetKg) {
  const target = Number(targetKg);
  const percentageBoundary = target * TARGET_FAILURE_POLICY.below_target_fraction;
  const absoluteBoundary = target - TARGET_FAILURE_POLICY.minimum_drop_kg;
  const failureBoundary = Math.max(target * (1 - TARGET_FAILURE_POLICY.maximum_drop_fraction),
    Math.min(percentageBoundary, absoluteBoundary));
  let acquired = false, belowSince = null, result = null;
  return ({ ts, kg }) => {
    if (!(target > 0) || !Number.isFinite(target)) return null;
    if (result) return result;
    if (!Number.isFinite(ts) || !Number.isFinite(kg)) return null;
    if (kg >= target) acquired = true;
    if (kg >= failureBoundary) {
      belowSince = null;
    } else if (acquired) {
      if (belowSince === null) belowSince = ts;
      // Confirm a continuous drop, but record its onset rather than counting
      // the confirmation interval as time sustained at the working load.
      if (ts - belowSince >= TARGET_FAILURE_POLICY.confirmation_ms) {
        result = { endTs: belowSince, targetAcquired: true };
      }
    }
    return result;
  };
}

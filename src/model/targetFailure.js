// Acquire the prescribed force before detecting failure. Allow small dips
// within the policy tolerance; confirm continuous drops below that boundary.
export const TARGET_FAILURE_POLICY = Object.freeze({
  version: 5, below_target_fraction: 0.93, confirmation_ms: 1000,
});

export function createTargetFailureDetector(targetKg) {
  const target = Number(targetKg);
  const failureBoundary = target * TARGET_FAILURE_POLICY.below_target_fraction;
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

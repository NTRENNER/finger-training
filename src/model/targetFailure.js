// The prescribed force is the failure boundary. Acquire it before detecting
// a drop so the initial ramp does not end the rep.
export const TARGET_FAILURE_POLICY = Object.freeze({
  version: 3, below_target_fraction: 1, confirmation_ms: 300,
});

export function createTargetFailureDetector(targetKg) {
  const target = Number(targetKg);
  let acquired = false, belowSince = null, result = null;
  return ({ ts, kg }) => {
    if (!(target > 0) || !Number.isFinite(target)) return null;
    if (result) return result;
    if (!Number.isFinite(ts) || !Number.isFinite(kg)) return null;
    if (kg >= target) {
      acquired = true;
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

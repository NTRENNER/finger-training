// The prescribed force is the failure boundary. Acquire it before detecting
// a drop so the initial ramp does not end the rep.
export const TARGET_FAILURE_POLICY = Object.freeze({
  version: 2, below_target_fraction: 1, confirmation_ms: 0,
});

export function createTargetFailureDetector(targetKg) {
  const target = Number(targetKg);
  let acquired = false, result = null;
  return ({ ts, kg }) => {
    if (!(target > 0) || !Number.isFinite(target)) return null;
    if (result) return result;
    if (kg >= target) acquired = true;
    else if (acquired) result = { endTs: ts, targetAcquired: true };
    return result;
  };
}

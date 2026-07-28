import { effectiveLoad } from "./load.js";

// All-grips mode is a comparison, never a pooled cross-grip fit.
// Sparse grips stay in the split view as dots until they have enough
// observations to fit their own curve.
export function buildForceDurationGripScope(
  history,
  { grip = "", hand = "pooled" } = {}
) {
  if (grip) return null;
  const present = new Set();
  for (const rep of history || []) {
    if (!rep?.grip) continue;
    if (hand !== "pooled" && rep.hand !== hand) continue;
    if (!(effectiveLoad(rep) > 0) || !(rep.actual_time_s > 0)) continue;
    present.add(rep.grip);
  }
  if (present.size < 2) return null;
  return Object.fromEntries([...present].map(item => [item, true]));
}

// ─────────────────────────────────────────────────────────────
// TRAINING FOCUS
// ─────────────────────────────────────────────────────────────
// Per-zone score multipliers applied at the end of the coaching
// recommendation pipeline. Lets the user bias recommendations toward
// what they're currently working on without abandoning the other
// compartments — a mild periodization layer on top of the
// "fill-the-curve-gap" math.
//
// Why this exists. The default coaching engine optimises for a
// balanced curve (gap × intensity × recency × external × residual).
// That's the right answer if you want to be a balanced finger
// athlete — but climbing is asymmetric. A boulderer with massive
// Power headroom and weak Endurance gets told "train Endurance"
// when their actual goal is harder boulders. As you get stronger
// at Power, the math gap to Endurance grows, locking the engine
// into an endless Endurance recommendation. That's the failure
// mode this feature avoids.
//
// Design notes:
//   * `balanced` is the default and is a no-op — every weight 1.0.
//     New users (and anyone who never opens Settings) get today's
//     behavior unchanged.
//   * Weights are deliberately mild (max 1.5, min 0.6) — this is
//     periodization, not specialization. A boulderer with a
//     genuinely catastrophic Endurance deficit can still surface
//     it. Bolder values would make the feature too prescriptive.
//   * Keys match the internal zone keys (power / strength /
//     endurance) so applyTrainingFocus is a one-line lookup with no
//     translation surface.
//   * Lives in src/model/ (not src/lib/) because the weights are
//     part of the recommendation engine's math, not infrastructure.

export const TRAINING_FOCUS = {
  balanced: {
    label: "Balanced",
    description: "Keep all three compartments humming.",
    weights: { power: 1.0, strength: 1.0, endurance: 1.0 },
  },
  bouldering: {
    label: "Bouldering",
    description: "Short, max-effort moves.",
    weights: { power: 1.5, strength: 1.0, endurance: 0.6 },
  },
  power_sport: {
    label: "Power-endurance sport",
    description: "Steep, punchy routes with hard cruxes.",
    weights: { power: 1.1, strength: 1.5, endurance: 0.9 },
  },
  endurance_sport: {
    label: "Endurance routes",
    description: "Long sustained climbing — e.g. Red River Gorge.",
    weights: { power: 0.6, strength: 1.0, endurance: 1.5 },
  },
};

export const DEFAULT_TRAINING_FOCUS = "balanced";

// Resolve a focus key to its weights map, falling back to balanced
// (all 1.0) for unknown keys. Defensive against migration breakage:
// if the LS-stored value is from a future version of the app the
// recommendation engine still works, just without the focus bias.
export function focusWeights(focusKey) {
  const focus = TRAINING_FOCUS[focusKey] ?? TRAINING_FOCUS[DEFAULT_TRAINING_FOCUS];
  return focus.weights;
}

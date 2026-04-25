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

// `description` describes the climbing style this focus is for.
// `coachingImpact` describes what the focus DOES to recommendations —
// the per-zone weighting in plain language, so the user can tell at
// a glance whether the bias matches what they want. Both are surfaced
// in the Training Focus picker on Setup and in Settings.
export const TRAINING_FOCUS = {
  balanced: {
    label: "Balanced",
    description: "Keep all three compartments humming.",
    coachingImpact: "No per-zone bias — coaching picks whichever zone has the widest curve gap.",
    weights: { power: 1.0, strength: 1.0, endurance: 1.0 },
  },
  bouldering: {
    label: "Bouldering",
    description: "Short, max-effort moves.",
    coachingImpact: "Power ×1.5, Endurance ×0.6 — the engine favors short max-effort sessions even when your Endurance gap is technically larger.",
    weights: { power: 1.5, strength: 1.0, endurance: 0.6 },
  },
  power_sport: {
    label: "Power-endurance sport",
    description: "Steep, punchy routes with hard cruxes.",
    coachingImpact: "Strength ×1.5, Power ×1.1, Endurance ×0.9 — the engine favors mid-duration max hangs that build the force ceiling steep routes need.",
    weights: { power: 1.1, strength: 1.5, endurance: 0.9 },
  },
  endurance_sport: {
    label: "Endurance routes",
    description: "Long sustained climbing — e.g. Red River Gorge.",
    coachingImpact: "Endurance ×1.5, Power ×0.6 — the engine favors sustained holds even when shorter zones look like bigger curve gaps.",
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

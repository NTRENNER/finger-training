// ─────────────────────────────────────────────────────────────
// ZONE CONSTANTS
// ─────────────────────────────────────────────────────────────
// Boundary durations and target reference times for the three
// training zones. Used by the limiter detector, the recommendation
// engine, the prescription cards, etc.
//
// Kept in the model layer (not GOAL_CONFIG) because GOAL_CONFIG
// also carries UI-specific stuff (emoji, color, copy text) that
// pure model code should not depend on.

// Boundary times (seconds) between zones — used to classify a rep's
// target_duration into a zone bucket.
export const POWER_MAX    = 20;   // [0, 20)        → power
export const STRENGTH_MAX = 120;  // [20, 120)      → strength
                                  // [120, ∞)       → endurance

// Reference target time per zone (seconds) — what the curve gets
// evaluated AT for that zone's prescription.
export const ZONE_REF_T = {
  power:     7,
  strength:  45,
  endurance: 120,
};

// Classify a target_duration into a zone key.
export const zoneOf = (td) =>
  td < POWER_MAX        ? "power"    :
  td < STRENGTH_MAX     ? "strength" :
                          "endurance";

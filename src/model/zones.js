// ─────────────────────────────────────────────────────────────
// ZONE CONSTANTS
// ─────────────────────────────────────────────────────────────
// Boundary durations and target reference times for the six
// training zones. Used by the limiter detector, the recommendation
// engine, the prescription cards, etc.
//
// Migrated May 2026 from a 3-zone (power/strength/endurance) scheme
// to a 6-zone scheme inspired by the Grip Gains community plus an
// added Max Strength zone for near-MVC work. The hybrids (power-
// strength, strength-endurance) are explicit transition zones that
// catch climbers who avoid those specific durations.
//
// Six zones, in order:
//   max_strength       —   5s (near-MVC; fast component dominates)
//   power              —  30s (fast → medium component crossover)
//   power_strength     —  70s (mid-T; medium component dominates)
//   strength           — 115s (medium → slow component crossover)
//   strength_endurance — 160s (long-T; medium + slow components blend)
//   endurance          — 220s (long-T; slow component carries)
//
// Reference times match Grip Gains observed bin centers; max_strength
// added below their shortest reference because we want the lockout
// system to optionally enforce true near-MVC training (relevant for
// hard bouldering and for raising the ceiling all other zones operate
// against).
//
// Kept in the model layer (not GOAL_CONFIG) because GOAL_CONFIG
// also carries UI-specific stuff (emoji, color, copy text) that
// pure model code should not depend on.

import { ymdLocal } from "../util.js";

// Boundary times (seconds) between zones — used by zoneOf() to
// classify a rep's target_duration. Half-open intervals [lo, hi).
export const MAX_STRENGTH_MAX       =  12;  // [0, 12)         → max_strength
export const POWER_MAX              =  50;  // [12, 50)        → power
export const POWER_STRENGTH_MAX     =  90;  // [50, 90)        → power_strength
export const STRENGTH_MAX           = 140;  // [90, 140)       → strength
export const STRENGTH_ENDURANCE_MAX = 180;  // [140, 180)      → strength_endurance
                                            // [180, ∞)        → endurance

// Reference target time per zone (seconds) — what the curve gets
// evaluated AT for that zone's prescription.
export const ZONE_REF_T = {
  max_strength:         5,
  power:               30,
  power_strength:      70,
  strength:           115,
  strength_endurance: 160,
  endurance:          220,
};

// Ordered list of zone keys — used everywhere the model needs to
// iterate over zones in physiological order. Single source of truth
// so consumers don't redeclare the order.
export const ZONE_KEYS = [
  "max_strength",
  "power",
  "power_strength",
  "strength",
  "strength_endurance",
  "endurance",
];

// Selectable target durations for the Setup form, History "add
// session" picker, History rep editor, and the Trends "best load"
// chart filter pills. Derived from ZONE_REF_T so the seconds field
// stays in sync with the model.
export const TARGET_OPTIONS = [
  { label: "Max Strength",       seconds: ZONE_REF_T.max_strength       },
  { label: "Power",              seconds: ZONE_REF_T.power              },
  { label: "Power/Strength",     seconds: ZONE_REF_T.power_strength     },
  { label: "Strength",           seconds: ZONE_REF_T.strength           },
  { label: "Strength/Endurance", seconds: ZONE_REF_T.strength_endurance },
  { label: "Endurance",          seconds: ZONE_REF_T.endurance          },
];

// Classify a target_duration (or actual_time_s) into a zone key.
export const zoneOf = (td) =>
  td < MAX_STRENGTH_MAX       ? "max_strength"       :
  td < POWER_MAX              ? "power"              :
  td < POWER_STRENGTH_MAX     ? "power_strength"     :
  td < STRENGTH_MAX           ? "strength"           :
  td < STRENGTH_ENDURANCE_MAX ? "strength_endurance" :
                                "endurance";

// ─────────────────────────────────────────────────────────────
// 6-ZONE CLASSIFIER
// ─────────────────────────────────────────────────────────────
// Used by the Analysis tab's per-session zone-distribution chart and
// by AnalysisView's intended-vs-landed zone overlay. Boundaries match
// the half-open intervals used by zoneOf so a single rep classified
// by zoneOf and by classifyZone6 always lands in the same bucket.
export const ZONE6 = [
  { key: "max_strength",       label: "Max Strength",       short: "Max",     color: "#c83838", min:   0, max: MAX_STRENGTH_MAX },
  { key: "power",              label: "Power",              short: "Pwr",     color: "#e05560", min: MAX_STRENGTH_MAX,       max: POWER_MAX },
  { key: "power_strength",     label: "Power-Strength",     short: "Pwr-Str", color: "#e68a48", min: POWER_MAX,              max: POWER_STRENGTH_MAX },
  { key: "strength",           label: "Strength",           short: "Str",     color: "#e07a30", min: POWER_STRENGTH_MAX,     max: STRENGTH_MAX },
  { key: "strength_endurance", label: "Strength-Endurance", short: "Str-End", color: "#7aa0d8", min: STRENGTH_MAX,           max: STRENGTH_ENDURANCE_MAX },
  { key: "endurance",          label: "Endurance",          short: "End",     color: "#3b82f6", min: STRENGTH_ENDURANCE_MAX, max: Infinity },
];

// Convert a single rep's duration into a ZONE6 entry. Returns null
// for zero/invalid reps; clamps long-tail durations to the last
// bucket so a 600s rep classifies as Endurance rather than null.
export function classifyZone6(durationSec) {
  if (!durationSec || durationSec <= 0) return null;
  return ZONE6.find(z => durationSec >= z.min && durationSec < z.max) ?? ZONE6[ZONE6.length - 1];
}

// Majority-zone for a set of reps (by count). Returns a ZONE6 entry
// or null if no reps have usable durations.
export function dominantZone6(reps) {
  const counts = Object.fromEntries(ZONE6.map(z => [z.key, 0]));
  for (const r of reps || []) {
    const z = classifyZone6(r.actual_time_s);
    if (z) counts[z.key] += 1;
  }
  const entries = Object.entries(counts).filter(([, n]) => n > 0);
  if (!entries.length) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return ZONE6.find(z => z.key === entries[0][0]);
}

// Map an intended GOAL_CONFIG zone key into a ZONE6 key for
// intended-vs-landed comparison. Identity mapping since the keys
// match across both definitions, but kept as an explicit table so
// future re-naming stays localized.
export const GOAL_TO_ZONE6 = {
  max_strength:       "max_strength",
  power:              "power",
  power_strength:     "power_strength",
  strength:           "strength",
  strength_endurance: "strength_endurance",
  endurance:          "endurance",
};

// Backward-compat aliases — the codebase had a 5-zone classifier with
// these names before the Max Strength zone was added. Kept so existing
// imports continue working during a deprecation window. Prefer the
// ZONE6 / classifyZone6 / dominantZone6 / GOAL_TO_ZONE6 names going
// forward.
export const ZONE5          = ZONE6;
export const classifyZone5  = classifyZone6;
export const dominantZone5  = dominantZone6;
export const GOAL_TO_ZONE5  = GOAL_TO_ZONE6;

// ─────────────────────────────────────────────────────────────
// ZONE COVERAGE (rolling 30-day session counts)
// ─────────────────────────────────────────────────────────────
// Counts grip-training sessions in the last 30 days, bucketed by
// the session's median target_duration. Climbing sessions are
// intentionally NOT credited — the old heuristic (hard→strength,
// easy→capacity, boulder→power) over-counted climbing toward
// finger-specific zones it didn't really stimulate. Legacy 1RM
// activities still count toward Max Strength (the closest 6-zone
// equivalent of pre-protocol max efforts).
//
// `recommended` is left in the return shape because the planner
// uses it as a fallback when there's too little failure data for
// the curve-residual signal. Returns the zone with the lowest
// count, breaking ties by zone order (max_strength first).
export function computeZoneCoverage(history, activities = []) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = ymdLocal(cutoff);

  // Grip-training sessions
  const sessions = {};
  for (const r of history) {
    if ((r.date ?? "") < cutoffStr) continue;
    const sid = r.session_id || r.date;
    if (!sessions[sid]) sessions[sid] = { date: r.date, durations: [] };
    const d = r.target_duration || r.actual_time_s;
    if (d > 0) sessions[sid].durations.push(d);
  }

  const counts = Object.fromEntries(ZONE_KEYS.map(k => [k, 0]));
  for (const s of Object.values(sessions)) {
    if (!s.durations.length) continue;
    const sorted = [...s.durations].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    counts[zoneOf(median)] += 1;
  }

  // Legacy 1RM activities credit Max Strength.
  for (const a of activities) {
    if ((a.date ?? "") < cutoffStr) continue;
    if (a.type === "oneRM") counts.max_strength += 1;
  }

  const total = ZONE_KEYS.reduce((s, k) => s + counts[k], 0);

  // Recommend the least-trained zone. ZONE_KEYS order is the
  // tiebreaker so Max Strength gets recommended ahead of Power when
  // both are at zero, etc.
  let recommended = ZONE_KEYS[0];
  for (const k of ZONE_KEYS) {
    if (counts[k] < counts[recommended]) recommended = k;
  }

  return { ...counts, total, recommended };
}

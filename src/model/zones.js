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

import { ymdLocal } from "../util.js";

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

// ─────────────────────────────────────────────────────────────
// 5-ZONE CLASSIFIER
// ─────────────────────────────────────────────────────────────
// A finer-grained classifier than the 3-zone {power, strength,
// endurance} bucketing. Used by the Analysis tab's per-session
// zone-distribution chart and by AnalysisView's intended-vs-landed
// zone overlay. The 45s boundaries come from 15 × 3s pulse framing;
// we treat them as TUT thresholds.
//
// Boundaries: <45s power, 45–81s pwr-str, 84–129s str,
//             132–177s str-end, 180s+ end.
export const ZONE5 = [
  { key: "power",              label: "Power",              short: "Pwr",     color: "#e05560", min:   0, max:  45 },
  { key: "power_strength",     label: "Power-Strength",     short: "Pwr-Str", color: "#e68a48", min:  45, max:  82 },
  { key: "strength",           label: "Strength",           short: "Str",     color: "#e07a30", min:  82, max: 130 },
  { key: "strength_endurance", label: "Strength-Endurance",  short: "Str-End", color: "#7aa0d8", min: 130, max: 178 },
  { key: "endurance",          label: "Endurance",           short: "End",     color: "#3b82f6", min: 178, max: Infinity },
];

// Convert a single rep's duration into a ZONE5 entry. Returns null
// for zero/invalid reps; clamps long-tail durations to the last
// bucket so a 600s rep classifies as Endurance rather than null.
export function classifyZone5(durationSec) {
  if (!durationSec || durationSec <= 0) return null;
  return ZONE5.find(z => durationSec >= z.min && durationSec < z.max) ?? ZONE5[ZONE5.length - 1];
}

// Majority-zone for a set of reps (by count). Returns a ZONE5 entry
// or null if no reps have usable durations.
export function dominantZone5(reps) {
  const counts = Object.fromEntries(ZONE5.map(z => [z.key, 0]));
  for (const r of reps || []) {
    const z = classifyZone5(r.actual_time_s);
    if (z) counts[z.key] += 1;
  }
  const entries = Object.entries(counts).filter(([, n]) => n > 0);
  if (!entries.length) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return ZONE5.find(z => z.key === entries[0][0]);
}

// Map an intended GOAL_CONFIG zone key into a ZONE5 key for
// intended-vs-landed comparison.
export const GOAL_TO_ZONE5 = { power: "power", strength: "strength", endurance: "endurance" };

// ─────────────────────────────────────────────────────────────
// ZONE COVERAGE (rolling 30-day session counts)
// ─────────────────────────────────────────────────────────────
// Counts grip-training sessions in the last 30 days, bucketed by
// the session's median target_duration. Climbing sessions are
// intentionally NOT credited — the old heuristic (hard→strength,
// easy→capacity, boulder→power) over-counted climbing toward
// finger-specific zones it didn't really stimulate. Legacy 1RM
// activities still count as Power (they were finger-specific max
// efforts before the power protocol was introduced).
//
// `recommended` is left in the return shape because the planner
// uses it as a fallback when there's too little failure data for
// the curve-residual signal. The Zone Workout Summary card just
// doesn't display the recommendation.
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

  let power = 0, strength = 0, endurance = 0;
  for (const s of Object.values(sessions)) {
    if (!s.durations.length) continue;
    const sorted = [...s.durations].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    // Half-open intervals [lo, hi) so boundary values land consistently
    // with computeLimiterZone. A capacity protocol (target 120s) goes to
    // endurance, not strength.
    if (median < POWER_MAX)         power++;     // [0, POWER_MAX)
    else if (median < STRENGTH_MAX) strength++;  // [POWER_MAX, STRENGTH_MAX)
    else                            endurance++; // [STRENGTH_MAX, ∞)
  }

  // Legacy 1RM activities still credit Power.
  for (const a of activities) {
    if ((a.date ?? "") < cutoffStr) continue;
    if (a.type === "oneRM") power++;
  }

  const total = power + strength + endurance;
  const recommended =
    power <= strength && power <= endurance ? "power" :
    strength <= endurance                    ? "strength" : "endurance";

  return { power, strength, endurance, total, recommended };
}

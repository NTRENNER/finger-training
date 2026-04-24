// ─────────────────────────────────────────────────────────────
// LIMITER ZONE DETECTION
// ─────────────────────────────────────────────────────────────
// Picks a single limiting zone (power / strength / endurance) for a
// recommended grip, based on a leave-one-out Monod cross-zone
// residual: fit Monod on two of the three zones' rep-1 failures,
// predict the held-out zone, take the gap. The zone with the largest
// positive (under-the-curve) gap is the limiter.
//
// Per-grip evaluation: force scales aren't comparable across grips
// (FDP pinch vs FDS crush), so we segment by grip and try each grip
// in order of recent volume. The first grip whose curve isn't
// balanced gives us a recommendation; balanced grips are skipped
// rather than degrading to noise.
//
// Falls back to "lowest-failure-count zone within the grip" only when
// the cross-zone CV is impossible (one zone has zero data); a balanced
// curve is NOT a fallback condition — it's the correct answer that the
// grip is on-curve and a different grip should be considered.
//
// Returns { zone, grip } or null. Used by the F-D chart's saturated
// zone-background highlight and the legacy ΔAUC recommendation
// fallback path. The Phase 3 coaching engine in coaching.js uses
// per-zone gap × intensity × recency × external × residual instead;
// computeLimiterZone is kept around for the Analysis chart's visual
// limiter highlight and for the legacy recommendation fallback.

import { POWER_MAX, STRENGTH_MAX } from "./zones.js";
import { fitCF, predForce } from "./monod.js";
import { ymdLocal } from "../util.js";

const LIMITER_WINDOW_DAYS      = 30;
const LIMITER_MIN_FAILURES     = 3;    // total within a grip before we trust the signal
const LIMITER_MIN_PTS_TRAIN    = 2;    // each of the two "training" zones needs this many points
const LIMITER_MIN_PTS_HELDOUT  = 1;    // the held-out zone needs at least this many
const LIMITER_RESIDUAL_KG      = 0.5;  // smallest gap we'll call a limiter — below this the curve is balanced

export function computeLimiterZone(history) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - LIMITER_WINDOW_DAYS);
  const cutoffStr = ymdLocal(cutoff);

  const allFailures = history.filter(r =>
    r.rep_num === 1 && r.failed &&
    r.avg_force_kg > 0 && r.avg_force_kg < 500 &&
    r.actual_time_s > 0 && r.target_duration > 0 &&
    (r.date || "") >= cutoffStr &&
    r.grip   // require known grip — otherwise we can't attribute
  );
  if (allFailures.length < LIMITER_MIN_FAILURES) return null;

  // Segment by grip. Force scales aren't comparable across grips.
  const byGrip = {};
  for (const r of allFailures) (byGrip[r.grip] ||= []).push(r);

  const zoneOf = (td) =>
    td < POWER_MAX        ? "power"    :
    td < STRENGTH_MAX     ? "strength" :
                            "endurance";

  // Try each grip, most-trained-in-30-days first. Return the first
  // grip whose data supports a recommendation. Skipping a grip with
  // a balanced curve is correct — it means that grip is on-curve,
  // and the next-most-trained grip may still have a deficit.
  const rankedGrips = Object.entries(byGrip)
    .sort(([, a], [, b]) => b.length - a.length);

  for (const [grip, failures] of rankedGrips) {
    if (failures.length < LIMITER_MIN_FAILURES) continue;

    const byZone = { power: [], strength: [], endurance: [] };
    for (const r of failures) byZone[zoneOf(r.target_duration)].push(r);

    // ── Primary: Monod cross-zone residual (per grip) ──
    const zones = ["power", "strength", "endurance"];
    const residuals = {};
    let cvWorked = true;
    for (const Z of zones) {
      const heldOut = byZone[Z];
      const others  = zones.filter(z => z !== Z);
      const bothTrainZonesOk = others.every(z => byZone[z].length >= LIMITER_MIN_PTS_TRAIN);
      if (!bothTrainZonesOk || heldOut.length < LIMITER_MIN_PTS_HELDOUT) {
        cvWorked = false;
        break;
      }
      const trainPts = others
        .flatMap(z => byZone[z])
        .map(r => ({ x: 1 / r.actual_time_s, y: r.avg_force_kg }));
      const fit = fitCF(trainPts);
      if (!fit) { cvWorked = false; break; }

      // Average predicted − actual across all held-out rep-1 failures.
      // Positive = actual fell short of the cross-zone prediction.
      const gaps = heldOut.map(r => predForce(fit, r.actual_time_s) - r.avg_force_kg);
      residuals[Z] = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    }

    if (cvWorked) {
      const ranked = Object.entries(residuals).sort(([, a], [, b]) => b - a);
      // Only return a pick if the top gap is meaningfully positive.
      // Below LIMITER_RESIDUAL_KG this grip's curve is balanced — try
      // the next grip rather than falling through to counts (counts
      // would disagree with a balanced curve and pick noise).
      if (ranked[0][1] > LIMITER_RESIDUAL_KG) return { zone: ranked[0][0], grip };
      continue;
    }

    // ── Fallback: failure-count within this grip ──
    const counts = {
      power:     byZone.power.length,
      strength:  byZone.strength.length,
      endurance: byZone.endurance.length,
    };
    const vals = Object.values(counts);
    if (vals.every(v => v === vals[0])) continue;
    const picked = Object.entries(counts).sort(([, a], [, b]) => a - b)[0][0];
    return { zone: picked, grip };
  }
  return null;
}

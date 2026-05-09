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

import { ZONE_KEYS, zoneOf } from "./zones.js";
import { fitCF, predForce } from "./monod.js";
import { ymdLocal } from "../util.js";

const LIMITER_WINDOW_DAYS         = 30;
const LIMITER_MIN_FAILURES        = 3;    // total within a grip before we trust the signal
const LIMITER_MIN_PTS_HELDOUT     = 1;    // the held-out zone needs at least this many
const LIMITER_MIN_TRAIN_ZONES     = 2;    // need at least 2 OTHER zones with data to fit a Monod cross-zone curve
const LIMITER_MIN_PTS_PER_TRAIN   = 1;    // each contributing training zone needs this many points
const LIMITER_RESIDUAL_KG         = 0.5;  // smallest gap we'll call a limiter — below this the curve is balanced

export function computeLimiterZone(history) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - LIMITER_WINDOW_DAYS);
  const cutoffStr = ymdLocal(cutoff);

  // Train-to-failure model: every rep with valid actual_time_s is a
  // (T, F) failure data point. Drop the legacy r.failed filter; keep
  // rep_num === 1 to avoid within-set fatigue contamination.
  const allFailures = history.filter(r =>
    r.rep_num === 1 &&
    r.avg_force_kg > 0 && r.avg_force_kg < 500 &&
    r.actual_time_s > 0 && r.target_duration > 0 &&
    (r.date || "") >= cutoffStr &&
    r.grip   // require known grip — otherwise we can't attribute
  );
  if (allFailures.length < LIMITER_MIN_FAILURES) return null;

  // Segment by grip. Force scales aren't comparable across grips.
  const byGrip = {};
  for (const r of allFailures) (byGrip[r.grip] ||= []).push(r);

  // Try each grip, most-trained-in-30-days first. Return the first
  // grip whose data supports a recommendation. Skipping a grip with
  // a balanced curve is correct — it means that grip is on-curve,
  // and the next-most-trained grip may still have a deficit.
  const rankedGrips = Object.entries(byGrip)
    .sort(([, a], [, b]) => b.length - a.length);

  for (const [grip, failures] of rankedGrips) {
    if (failures.length < LIMITER_MIN_FAILURES) continue;

    // 6-zone bucketing. Some buckets will be empty for most users —
    // that's expected; the CV step requires only ≥2 OTHER zones to
    // have data, not all of them.
    const byZone = Object.fromEntries(ZONE_KEYS.map(k => [k, []]));
    for (const r of failures) {
      const k = zoneOf(r.target_duration);
      if (byZone[k]) byZone[k].push(r);
    }

    // ── Primary: Monod cross-zone residual (per grip) ──
    // For each zone with ≥1 point, fit Monod on the OTHER zones'
    // data and predict the held-out zone. The largest positive gap
    // (held-out actual force fell shortest of the cross-zone fit's
    // prediction) is the limiter.
    const residuals = {};
    let anyResidualComputed = false;
    for (const Z of ZONE_KEYS) {
      const heldOut = byZone[Z];
      if (heldOut.length < LIMITER_MIN_PTS_HELDOUT) continue;
      const others = ZONE_KEYS.filter(z => z !== Z && byZone[z].length >= LIMITER_MIN_PTS_PER_TRAIN);
      if (others.length < LIMITER_MIN_TRAIN_ZONES) continue;
      const trainPts = others
        .flatMap(z => byZone[z])
        .map(r => ({ x: 1 / r.actual_time_s, y: r.avg_force_kg }));
      const fit = fitCF(trainPts);
      if (!fit) continue;

      // Average predicted − actual across all held-out rep-1 failures.
      // Positive = actual fell short of the cross-zone prediction.
      const gaps = heldOut.map(r => predForce(fit, r.actual_time_s) - r.avg_force_kg);
      residuals[Z] = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      anyResidualComputed = true;
    }

    if (anyResidualComputed) {
      const ranked = Object.entries(residuals).sort(([, a], [, b]) => b - a);
      // Only return a pick if the top gap is meaningfully positive.
      // Below LIMITER_RESIDUAL_KG this grip's curve is balanced — try
      // the next grip rather than falling through to counts (counts
      // would disagree with a balanced curve and pick noise).
      if (ranked[0][1] > LIMITER_RESIDUAL_KG) return { zone: ranked[0][0], grip };
      continue;
    }

    // ── Fallback: failure-count within this grip ──
    // Pick the zone with the FEWEST failures (least-trained = recommend).
    // Only when the user's training is unbalanced enough that some zones
    // have data and others don't.
    const counts = Object.fromEntries(ZONE_KEYS.map(k => [k, byZone[k].length]));
    const vals = Object.values(counts);
    if (vals.every(v => v === vals[0])) continue; // perfectly balanced — skip
    const picked = Object.entries(counts).sort(([, a], [, b]) => a - b)[0][0];
    return { zone: picked, grip };
  }
  return null;
}

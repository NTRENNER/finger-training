// ─────────────────────────────────────────────────────────────
// PERSONAL RESPONSE CALIBRATION
// ─────────────────────────────────────────────────────────────
// Per-zone CF / W' response rates, fit from the user's own training
// log and shrunk toward the PROTOCOL_RESPONSE prior with Bayesian
// shrinkage. Used by the recommendation engine in place of the raw
// prior so projected ΔAUC adapts to the climber's actual measured
// response over time.
//
// Early in training (thin data) the returned coefficients equal the
// prior; as training-under-tension accumulates in a given zone, the
// fit pulls toward the observed personal rate. A zone needs at least
// PERSONAL_RESPONSE_MIN_SESSIONS effective session-equivalents before
// any personal signal is blended in.
//
// Attribution: proportional by time-under-tension (TUT), not by rep
// count or dominant zone. A day with 15s of power warm-up + 180s of
// strength work gets 8% / 92% attribution, not all-or-nothing to the
// dominant zone. This correctly handles the common case where a user
// does a short max-effort warm-up (power) before their main training
// block — the warm-up gets its proportional share, the main block
// gets most of it. No user-facing toggle required: if power always
// comes in small TUT doses, its effective-n stays small and its
// personal calibration stays near prior.
//
// Per-day loop: for each calendar day with failures, refit Monod on
// all data up to that day vs. through the previous day. Fractional
// ΔCF and ΔW' are split across zones proportional to that day's TUT
// per zone, then accumulated as weighted observations. Noise in
// single-day deltas averages out over many weighted observations.
// Negative observed rates are floored at zero (likely confounds:
// illness, taper, bad mount) rather than propagated as "training
// hurt me" into a negative coefficient.
//
// Shrinkage: posterior = (k₀·prior + n_eff·weighted_mean) / (k₀ + n_eff).
// With k₀ = PERSONAL_RESPONSE_PRIOR_WEIGHT, a zone needs roughly k₀
// session-equivalents of evidence before personal rates dominate.

import { POWER_MAX, STRENGTH_MAX } from "./zones.js";
import { fitCF } from "./monod.js";

// Per-zone fractional response priors. Each entry maps to {cf, w} —
// expected fractional change in CF and W' per session of that zone.
//
// Power → tiny CF (W' is the proximal target), large W'.
// Strength → CF-dominant via ceiling effect (force ceiling lifts CF).
// Endurance → CF via ratio effect (sub-CF training drags CF up over time),
//            small W' since W' is barely loaded.
//
// These are priors, not truths. computePersonalResponse() fits them
// to the user's own CF/W' trajectory and shrinks toward the observed
// rate as evidence accumulates.
export const PROTOCOL_RESPONSE = {
  power:     { cf: 0.010, w: 0.060 },  // W'-dominant, tiny CF via MVC
  strength:  { cf: 0.045, w: 0.015 },  // CF-dominant via ceiling effect
  endurance: { cf: 0.030, w: 0.008 },  // CF via ratio effect, small W'
};

// Integration window for the "climbing-relevant" AUC — covers power
// through capacity durations. CF is weighted (tMax−tMin) = 110; W' is
// weighted ln(tMax/tMin) ≈ 2.485, so CF dominates AUC by ~44×. This
// matches the climbing-grade literature: sustainable finger force
// (CF) is a stronger predictor of grade than finite reserve (W').
export const AUC_T_MIN = 10;
export const AUC_T_MAX = 120;

// Shrinkage parameters. PRIOR_WEIGHT acts as a pseudo-sample count:
// a zone needs roughly this many session-equivalents of evidence
// before personal rates start dominating the prior in the blend.
// MIN_SESSIONS is a hard gate — below this effective-n we keep the
// prior unchanged rather than blending at all.
export const PERSONAL_RESPONSE_PRIOR_WEIGHT = 10;  // pseudo-sessions
export const PERSONAL_RESPONSE_MIN_SESSIONS = 5;   // hard gate per zone (effective-n)

export function computePersonalResponse(history) {
  const zoneOf = (td) =>
    td < POWER_MAX    ? "power"    :
    td < STRENGTH_MAX ? "strength" :
                        "endurance";

  // Default: everyone starts at the prior with source='prior', n=0.
  const result = {
    power:     { ...PROTOCOL_RESPONSE.power,     n: 0, source: "prior" },
    strength:  { ...PROTOCOL_RESPONSE.strength,  n: 0, source: "prior" },
    endurance: { ...PROTOCOL_RESPONSE.endurance, n: 0, source: "prior" },
  };

  if (!history || history.length < 4) return result;

  const failures = history.filter(r =>
    r.failed &&
    r.avg_force_kg > 0 && r.avg_force_kg < 500 &&
    r.actual_time_s > 0 && r.target_duration > 0 && r.date
  );
  if (failures.length < 4) return result;

  // Sort and bucket by date.
  const sorted = [...failures].sort((a, b) => a.date.localeCompare(b.date));
  const byDate = {};
  for (const r of sorted) (byDate[r.date] ||= []).push(r);
  const dates = Object.keys(byDate).sort();

  // Walk dates; at each date with enough prior data, refit before/after
  // and split the fractional delta across zones by TUT proportion.
  // obs[zone] is an array of { weight, dCF, dW } — weight = TUT fraction.
  const obs = { power: [], strength: [], endurance: [] };

  for (const date of dates) {
    const before = sorted.filter(r => r.date < date);
    const after  = sorted.filter(r => r.date <= date);
    if (before.length < 2) continue;

    const fitBefore = fitCF(before.map(r => ({ x: 1 / r.actual_time_s, y: r.avg_force_kg })));
    const fitAfter  = fitCF(after.map(r  => ({ x: 1 / r.actual_time_s, y: r.avg_force_kg })));
    if (!fitBefore || !fitAfter) continue;
    if (fitBefore.CF <= 0) continue;

    const dCF = (fitAfter.CF - fitBefore.CF) / fitBefore.CF;
    const dW  = fitBefore.W > 0 ? (fitAfter.W - fitBefore.W) / fitBefore.W : 0;

    // TUT per zone for the day — sum actual_time_s bucketed by the zone
    // each rep was *targeting* (target_duration), not the zone the rep
    // fell into. A failed capacity-target rep at 60s still attributes
    // to capacity training. Matches the zone-bucketing convention used
    // everywhere else in the app.
    const tut = { power: 0, strength: 0, endurance: 0 };
    for (const r of byDate[date]) tut[zoneOf(r.target_duration)] += r.actual_time_s;
    const totalTUT = tut.power + tut.strength + tut.endurance;
    if (totalTUT <= 0) continue;

    for (const zone of Object.keys(tut)) {
      const w = tut[zone] / totalTUT;
      if (w > 0) obs[zone].push({ weight: w, dCF, dW });
    }
  }

  // Weighted shrinkage. Effective-n = Σ weights (can be fractional).
  const k0 = PERSONAL_RESPONSE_PRIOR_WEIGHT;
  for (const zone of Object.keys(PROTOCOL_RESPONSE)) {
    const zoneObs = obs[zone];
    const nEff = zoneObs.reduce((s, o) => s + o.weight, 0);

    if (nEff < PERSONAL_RESPONSE_MIN_SESSIONS) {
      result[zone] = { ...PROTOCOL_RESPONSE[zone], n: nEff, source: "prior" };
      continue;
    }

    // Weighted mean of observed fractional deltas. Divides by Σweights
    // so each day's total contribution (across all zones) is 1 unit of
    // evidence, split proportionally by that day's TUT distribution.
    const wMeanCF = zoneObs.reduce((s, o) => s + o.weight * o.dCF, 0) / nEff;
    const wMeanW  = zoneObs.reduce((s, o) => s + o.weight * o.dW,  0) / nEff;
    const prior   = PROTOCOL_RESPONSE[zone];

    // Floor at zero: negative observed rate is almost always confounded
    // (illness, injury, mount variance) rather than true anti-response.
    const cfBlended = Math.max(0, (k0 * prior.cf + nEff * wMeanCF) / (k0 + nEff));
    const wBlended  = Math.max(0, (k0 * prior.w  + nEff * wMeanW)  / (k0 + nEff));

    result[zone] = {
      cf: cfBlended,
      w:  wBlended,
      n:  nEff,
      source: "blended",
    };
  }

  return result;
}

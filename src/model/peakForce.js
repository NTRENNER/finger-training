// ─────────────────────────────────────────────────────────────
// PEAK FORCE TREND — observed ceiling + standardized trajectory
// ─────────────────────────────────────────────────────────────
// The F-D curve is built on SUSTAINED holds, so it underrepresents true
// max strength (its T→0 max is an extrapolation, and a long hold never
// samples peak recruitment). peak_force_kg, captured per rep, is a
// direct measurement of instantaneous force.
//
// The card deliberately carries two different signals:
//   PR line    — every valid measured peak can raise the observed ceiling.
//   Trend line — max-intent protocol peaks only, so routine sub-max work
//                cannot pull the standardized comparison downward.
// A peak set during any workout is still a real neuromuscular observation;
// the workout's target zone is attached to each new-PR marker as context.
// Rep duration is not filtered because peak force is instantaneous. Intent
// comes from target_duration, with targets at or under
// PEAK_MAX_PROTOCOL_T treated as max intent.
//
// Pure functions; no React. Tested in isolation.

import { SANE_MAX_KG, isSeedArtifactRep } from "./load.js";
import { classifyZone6 } from "./zones.js";

export const PEAK_MAX_PROTOCOL_T = 12;    // s — target_duration at/under this = max/power block
const PEAK_MAX_KG = SANE_MAX_KG;          // single sanity ceiling — see load.js (was a stale local 500)

// Build the per-grip peak-force time series.
// Returns:
//   {
//     grips: string[],                         // grips with measured peak data
//     standardizedPending: { [grip]: true },   // no max-intent session yet
//     rows:  [{ date,
//               [grip]: kg,                    // best observed peak that day
//               [grip]_pr: kg,                 // all-session running PR
//               [grip]_newPr: kg,              // present only when PR advances
//               [grip]_prContext: object,      // workout zone for new PR
//               [grip]_trend: kg }],           // max-intent-only smoothed trend
//     best:  { [grip]: { kg, date, context } },// all-time observed peak
//     latest:{ [grip]: { kg, date } },         // most recent session best
//   }
// or null when no grip has usable peak data.
export function buildPeakForceTrend(history, {
  maxProtocolT = PEAK_MAX_PROTOCOL_T,
} = {}) {
  if (!Array.isArray(history) || history.length === 0) return null;

  // grip -> Map<date, { kg, context }>. observedByGrip drives the
  // record line; maxIntentByGrip is its standardized trend subset.
  const observedByGrip = {};
  const maxIntentByGrip = {};
  for (const r of history) {
    if (!r || !r.grip || !r.date) continue;
    // Seed-artifact guard: a seeded/backfilled twin mirrors its (often
    // inflated) load into peak_force_kg too — avg==peak is not a real
    // measurement, so it can't set a PR or a session best.
    if (isSeedArtifactRep(r)) continue;
    const peak = Number(r.peak_force_kg);
    if (!(peak > 0 && peak < PEAK_MAX_KG)) continue;

    const rawTarget = r.target_duration;
    const parsedTarget = rawTarget == null || rawTarget === "" ? null : Number(rawTarget);
    const targetDuration = Number.isFinite(parsedTarget) && parsedTarget > 0 ? parsedTarget : null;
    const maxIntent = targetDuration == null || targetDuration <= maxProtocolT;
    const zone = targetDuration == null ? null : classifyZone6(targetDuration);
    const measurement = {
      kg: peak,
      context: {
        label: zone?.label || "Workout",
        zoneKey: zone?.key || null,
        targetDuration,
        maxIntent,
      },
    };
    const put = (map) => {
      if (!map[r.grip]) map[r.grip] = new Map();
      const cur = map[r.grip].get(r.date);
      if (!cur || peak > cur.kg) map[r.grip].set(r.date, measurement);
    };
    put(observedByGrip);
    if (maxIntent) put(maxIntentByGrip);
  }

  const grips = Object.keys(observedByGrip).filter(g => observedByGrip[g].size > 0).sort();
  if (grips.length === 0) return null;

  const standardizedPending = {};
  for (const g of grips) {
    if (!maxIntentByGrip[g]?.size) standardizedPending[g] = true;
  }

  // First observed session best per grip — the baseline for "% since".
  const firstBest = {};
  for (const g of grips) {
    const earliest = [...observedByGrip[g].keys()].sort()[0];
    firstBest[g] = observedByGrip[g].get(earliest).kg;
  }

  const allDates = [...new Set(grips.flatMap(g => [...observedByGrip[g].keys()]))].sort();
  const best = {};
  const bestRaw = {};
  const latest = {};
  const domain = {};
  const runningPr = Object.fromEntries(grips.map(g => [g, 0]));

  const rows = allDates.map(date => {
    const row = { date };
    for (const g of grips) {
      const measurement = observedByGrip[g].get(date);
      if (measurement) {
        const v = measurement.kg;
        const rounded = Math.round(v * 10) / 10;
        row[g] = rounded;
        if (v > runningPr[g]) {
          runningPr[g] = v;
          row[`${g}_newPr`] = rounded;
          row[`${g}_prContext`] = measurement.context;
        } else {
          row[`${g}_newPr`] = null;
          row[`${g}_prContext`] = null;
        }
        latest[g] = { kg: rounded, date, context: measurement.context };
        if (bestRaw[g] == null || v > bestRaw[g]) {
          bestRaw[g] = v;
          best[g] = { kg: rounded, date, context: measurement.context };
        }
        const d = domain[g] || { min: v, max: v };
        domain[g] = { min: Math.min(d.min, v), max: Math.max(d.max, v) };
      } else {
        row[g] = null;
        row[`${g}_newPr`] = null;
        row[`${g}_prContext`] = null;
      }
      row[`${g}_pr`] = runningPr[g] > 0 ? Math.round(runningPr[g] * 10) / 10 : null;
    }
    return row;
  });

  // Smoothed session-best trend (June 2026): a 3-point centered
  // rolling mean over each grip's max-intent session bests. The PR
  // line can only rise or hold; this standardized trend can fall.
  // Ordinary sub-max workout peaks never enter this series.
  for (const g of grips) {
    const maxDays = maxIntentByGrip[g];
    if (!maxDays) continue;
    const gDates = [...maxDays.keys()].sort();
    if (gDates.length < 3) continue;
    const vals = gDates.map(d => maxDays.get(d).kg);
    const smByDate = new Map(gDates.map((d, i) => {
      const lo = Math.max(0, i - 1);
      const hi = Math.min(vals.length - 1, i + 1);
      let s = 0, n = 0;
      for (let j = lo; j <= hi; j++) { s += vals[j]; n++; }
      return [d, Math.round((s / n) * 10) / 10];
    }));
    for (const row of rows) {
      row[`${g}_trend`] = smByDate.get(row.date) ?? null;
    }
  }

  // % climb in the observed ceiling (best-ever vs first measured
  // session) per grip. The max-intent trend remains the standardized
  // comparison when protocol consistency matters.
  const changePct = {};
  for (const g of grips) {
    changePct[g] = firstBest[g] > 0
      ? Math.round((bestRaw[g] / firstBest[g] - 1) * 100)
      : null;
  }

  return {
    grips,
    standardizedPending,
    rows,
    best,
    latest,
    firstBest,
    changePct,
    domain,
  };
}

// ─────────────────────────────────────────────────────────────
// PEAK TEST CADENCE — periodic max-strength test
// ─────────────────────────────────────────────────────────────
// A dedicated short maximal-pull test so the Peak Force card stays
// populated on a cadence instead of only when a max/power block
// happens to land. The top line is neuromuscular / instantaneous, so
// the test is short and repeatable:
//   MAX_TEST_TARGET_S — 3s target: long enough to ramp to true peak
//     recruitment, short enough to avoid metabolic confound / fatigue.
//   MAX_TEST_ATTEMPTS — best of 3 per hand (one pull is noisy; a
//     ramp-up attempt can out-pull a cold first pull).
// A 3s rep clears both PEAK_MAX_PROTOCOL_T (peak card) and the curve's
// short-end fresh-test gate, so it needs no special protocol tagging.
export const MAX_TEST_TARGET_S = 3;
export const MAX_TEST_ATTEMPTS = 3;
// Cadence. Peak is fairly flat month-to-month, so ~4 weeks between
// tests keeps the reading fresh without over-testing. This is a
// MEASUREMENT-freshness window (when did we last read your max),
// distinct from LOCKOUT_WINDOW_DAYS (detraining).
export const MAX_TEST_STALE_DAYS = 28;

// Days since this grip last produced a real PEAK reading — a Tindeq-
// measured max-effort rep (peak_force_kg present, at a max/power
// target ≤ PEAK_MAX_PROTOCOL_T). Distinct from shortEndFailureStaleness
// (which anchors the CURVE's short end and accepts any short rep,
// including manual entries with no peak): the peak card needs a
// measured peak, so a manual short hold can't clear this. `gripHistory`
// is already grip-filtered (called per grip from the coaching engine).
// Returns { staleDays, lastDate, recommended }:
//   staleDays   — days since last peak reading (null = never)
//   recommended — true when never measured, or staleDays exceeds
//                 MAX_TEST_STALE_DAYS
export function maxTestStaleness(gripHistory, todayStr, {
  maxProtocolT = PEAK_MAX_PROTOCOL_T,
  staleDaysMax = MAX_TEST_STALE_DAYS,
} = {}) {
  let lastDate = null;
  for (const r of gripHistory || []) {
    if (!r || !r.date) continue;
    if (isSeedArtifactRep(r)) continue;  // a fake peak must not silence the cadence
    const peak = Number(r.peak_force_kg);
    if (!(peak > 0 && peak < PEAK_MAX_KG)) continue;
    const tgt = Number(r.target_duration);
    if (Number.isFinite(tgt) && tgt > maxProtocolT) continue;   // max/power intent only
    if (lastDate == null || r.date > lastDate) lastDate = r.date;
  }
  if (lastDate == null) return { staleDays: null, lastDate: null, recommended: true };
  const days = Math.round(
    (new Date(`${todayStr}T00:00:00`).getTime() - new Date(`${lastDate}T00:00:00`).getTime()) / 86400000
  );
  return { staleDays: days, lastDate, recommended: days > staleDaysMax };
}

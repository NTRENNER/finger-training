// ─────────────────────────────────────────────────────────────
// LOCKOUT / TRAINING BALANCE MODEL
// ─────────────────────────────────────────────────────────────
// Tracks per-zone last-trained dates and computes staleness so the
// app can nudge training balance — preventing climbers from skipping
// painful zones (Crusher Endurance, Max Strength) for so long that
// the curve develops persistent gaps.
//
// Design: SOFT lockout for v1. Stale zones get prioritized by the
// recommendation engine (score boost) and surfaced via a banner on
// Setup. We don't HARD-block other zones — too coercive when the
// user is sick / injured / climbing performance days. If users keep
// avoiding zones despite the soft signal, hard lockout becomes a v2
// option to consider.
//
// Per-zone detraining windows: shorter for fast-twitch / neural zones
// (Max Strength, Power) which decondition quickly; longer for aerobic
// zones (Endurance, Strength/Endurance) which are more stable. These
// are calibrated against general resistance-training detraining
// research, not climbing-specific (the literature there is sparse).
// Tune as personal experience dictates.
//
// Climbing sessions DO NOT currently reset zone freshness — only
// finger-training reps do. v2 may add partial resets based on
// climbing style (boulder → resets max_strength + power; multi-pitch
// → resets endurance). Today's quick-log captures discipline + RPE
// as raw inputs for that future logic.

import { ZONE_KEYS, zoneOf } from "./zones.js";

// Per-zone detraining timeline in days. After this many days without
// training the zone, it's "stale" — the recommendation engine boosts
// the score for that zone and the Setup banner surfaces it.
//
// Calibration:
//   max_strength   — neural adaptations decay fast; 2 weeks
//   power          — type IIx fiber + PCr adaptations; 3 weeks
//   power_strength — crossover; ~3.5 weeks
//   strength       — mid-glycolytic; 1 month
//   strength_endurance — crossover; ~1 month
//   endurance      — aerobic / capillarization; most stable
export const LOCKOUT_WINDOW_DAYS = {
  max_strength:        14,
  power:               21,
  power_strength:      25,
  strength:            30,
  strength_endurance:  32,
  endurance:           35,
};

// Annual session goal. ~100 sessions/year ≈ 2/week. The Training
// Balance card displays running progress against this goal so the
// user can see whether they're on pace.
export const ANNUAL_SESSION_GOAL = 100;

// Find the most recent training date per zone. Buckets each rep by
// the ACTUAL time-to-failure (zoneOf(actual_time_s)) — under train-to-
// failure the actual hold IS the duration physiology delivered against,
// which is what "training a zone" should mean. The prescribed
// target_duration is just intent; if you target strength_endurance
// (140s) and hold 222s, you trained endurance, not strength_endurance.
// Falls back to target_duration only when actual is missing (legacy
// rows or manual entries without an actual time recorded).
// Returns { zoneKey: "YYYY-MM-DD" | null }.
export function getLastZoneTrainedDates(history) {
  const out = Object.fromEntries(ZONE_KEYS.map(k => [k, null]));
  for (const r of history || []) {
    if (!r?.date) continue;
    const td = r.actual_time_s > 0 ? r.actual_time_s : r.target_duration;
    if (!(td > 0)) continue;
    const k = zoneOf(td);
    if (!out[k] || r.date > out[k]) out[k] = r.date;
  }
  return out;
}

// Compute staleness state per zone.
//
// Returns { zoneKey: { lastDate, days, status } } where:
//   lastDate — "YYYY-MM-DD" or null (never trained)
//   days     — integer days since last training, or null
//   status   — "never" | "ok" | "warning" | "stale"
//
// Status thresholds:
//   never   — zone has no training data at all
//   ok      — within 70% of the lockout window
//   warning — 70-100% of the window (approaching staleness)
//   stale   — over the full window (lockout active)
export function getZoneStaleness(history, today = new Date()) {
  const lastDates = getLastZoneTrainedDates(history);
  const todayMs = today instanceof Date ? today.getTime() : Date.parse(today);
  const out = {};
  for (const k of ZONE_KEYS) {
    const last = lastDates[k];
    if (!last) {
      out[k] = { lastDate: null, days: null, status: "never" };
      continue;
    }
    const lastMs = Date.parse(last);
    const days = Math.floor((todayMs - lastMs) / (24 * 60 * 60 * 1000));
    const window = LOCKOUT_WINDOW_DAYS[k];
    let status = "ok";
    if (days >= window) status = "stale";
    else if (days >= window * 0.7) status = "warning";
    out[k] = { lastDate: last, days, status };
  }
  return out;
}

// Score multiplier the coaching engine applies to bias toward stale
// zones. Stable for "ok" so most recommendations aren't perturbed;
// modest bump for "warning" to nudge the user before lockout; firm
// 2× for "stale" so the engine genuinely prefers it over balanced
// alternatives. "never" gets the same treatment as "stale" — never-
// trained zones are the strongest candidates for the lockout system
// to surface.
export function stalenessBoost(zoneKey, stalenessMap) {
  const s = stalenessMap?.[zoneKey];
  if (!s) return 1.0;
  switch (s.status) {
    case "stale":   return 2.0;
    case "never":   return 2.0;
    case "warning": return 1.4;
    case "ok":
    default:        return 1.0;
  }
}

// Rolling 365-day session count + pace projection.
//
// We use a rolling window rather than a calendar year so the metric
// doesn't reset to zero on Jan 1, which would wipe late-year
// consistency from the motivation signal — train hard in November and
// you'd lose the credit for it on New Year's Day. With a rolling
// window the count always reflects "what have you actually done in
// the last 12 months," which is what the user cares about.
//
// `current`     = distinct sessions in the last 365 days.
// `paceYearEnd` = projected sessions over the next 365 days at the
//                 current rate. For users with ≥365 days of training
//                 history this equals `current` trivially; for newer
//                 users we extrapolate from the active training
//                 window so the pace projection is meaningful from
//                 month one.
//
// Session identity comes from `session_id` when available, falling
// back to `date` for older reps without a session_id.
export function getRollingSessionPace(history, today = new Date()) {
  const todayMs = today instanceof Date ? today.getTime() : Date.parse(today);
  const ms       = 24 * 60 * 60 * 1000;
  const window   = 365;
  const cutoffMs = todayMs - window * ms;

  const sessions = new Set();
  let firstSessionMs = Infinity;
  for (const r of history || []) {
    if (!r?.date) continue;
    const repMs = Date.parse(r.date);
    if (!isFinite(repMs)) continue;
    if (repMs < firstSessionMs) firstSessionMs = repMs;
    if (repMs < cutoffMs) continue;
    const sid = r.session_id || r.date;
    sessions.add(sid);
  }
  const current = sessions.size;

  let paceYearEnd;
  if (firstSessionMs === Infinity) {
    paceYearEnd = 0;
  } else {
    // Extrapolate from the actual active training window. Capped at
    // `window` so a year+ of history just returns `current` directly
    // (no amplification for mature users).
    const trainingDays = Math.max(1, Math.floor((todayMs - firstSessionMs) / ms));
    const activeDays   = Math.min(window, trainingDays);
    paceYearEnd = Math.round(current * (window / activeDays));
  }

  return {
    current,
    paceYearEnd,
    goal:       ANNUAL_SESSION_GOAL,
    goalGap:    ANNUAL_SESSION_GOAL - current,
    windowDays: window,
  };
}

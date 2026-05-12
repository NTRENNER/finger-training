// ─────────────────────────────────────────────────────────────
// LEVELING / GAMIFICATION MODEL  (curve-trust rewrite, May 2026)
// ─────────────────────────────────────────────────────────────
// Computes per-(hand, grip, zone) baselines and current "level" — the
// gamification surface for level-up prompts on session save.
//
// Baseline = best load from the user's FIRST session that landed any rep
// in this zone. Subsequent sessions earn levels for every LEVEL_STEP
// (5%) improvement over baseline.
//
// Curve-trust rewrite (May 2026): grouping is by zoneOf(actual_time_s)
// instead of exact target_duration match. The continuous engine
// recommends arbitrary T values (92s, 95s, 100s, ...) so the old
// "exact T match" key produced one near-empty level track per T.
// And the 0.98 success gate is gone — under train-to-failure every rep
// IS a failure point at actual_time_s, so an 88s rep on a 92s target is
// real data, not a sandbag. Both changes bring this module into line
// with the rest of the model layer (staleness, prescription anchoring,
// F-D fit) which all use actual_time_s as the primary primitive.
//
// This module is read-only over the rep history. It does not write
// state; useSessionRunner is responsible for diffing pre- vs post-save
// levels to decide whether to show the level-up animation.

import { effectiveLoad } from "./prescription.js";
import { zoneOf } from "./zones.js";

// 5% improvement over baseline = next level. With this geometric
// step, level 5 ≈ 22% over baseline, level 10 ≈ 55%, level 20 ≈
// 2.4× — the curve gets steep enough to reward sustained
// progression without making early gains feel cheap.
export const LEVEL_STEP = 1.05;

// Group reps for a (hand, grip, zone) tuple into sessions, oldest
// first. session_id is the primary grouping key; date is a fallback
// for older rows that don't have one. A rep counts when its
// actual_time_s falls in the target zone (zoneOf is the same
// classifier the F-D fit + staleness use, so the buckets stay in
// lockstep with everywhere else in the app).
//
// Returns [{ key, date, reps[] }] sorted ascending by date.
export function groupSessions(history, hand, grip, zone) {
  if (!zone) return [];
  const matches = history.filter(r =>
    r.hand === hand &&
    (!grip || r.grip === grip) &&
    r.actual_time_s > 0 &&
    zoneOf(r.actual_time_s) === zone &&
    effectiveLoad(r) > 0
  );
  const map = new Map();
  matches.forEach(r => {
    const key = r.session_id || r.date;
    if (!map.has(key)) map.set(key, { key, date: r.date, reps: [] });
    map.get(key).reps.push(r);
  });
  return [...map.values()].sort((a, b) => a.date < b.date ? -1 : 1);
}

// Baseline = best load from the FIRST session that landed any rep in
// this zone. Locking baseline to session 1 means the user can't
// "improve their baseline" by sandbagging session 2 — only true PRs
// count for progression.
export function getBaseline(history, hand, grip, zone) {
  const sessions = groupSessions(history, hand, grip, zone);
  if (sessions.length === 0) return null;
  const firstReps = sessions[0].reps;
  return Math.max(...firstReps.map(r => effectiveLoad(r)));
}

// Best load = best rep from sessions AFTER the first. First session
// always = level 1 regardless of within-session variance, so we
// exclude it from the PR pool.
export function getBestLoad(history, hand, grip, zone) {
  const sessions = groupSessions(history, hand, grip, zone);
  if (sessions.length < 2) return null;
  const laterReps = sessions.slice(1).flatMap(s => s.reps);
  if (laterReps.length === 0) return null;
  return Math.max(...laterReps.map(r => effectiveLoad(r)));
}

// Level = floor(log_{LEVEL_STEP}(best/baseline)) + 1, clamped at 1.
// First session OR no improvement yet → level 1. Every additional
// LEVEL_STEP (5%) over baseline bumps the level by 1.
export function calcLevel(history, hand, grip, zone) {
  const baseline = getBaseline(history, hand, grip, zone);
  if (!baseline || baseline <= 0) return 1;
  const best = getBestLoad(history, hand, grip, zone);
  if (!best || best <= baseline) return 1;
  return Math.max(1, 1 + Math.floor(Math.log(best / baseline) / Math.log(LEVEL_STEP)));
}

// Plain-string title for a numeric level. Kept as a function in
// case we want richer labels (e.g. emoji/medal tier) later.
export function levelTitle(level) {
  return `Level ${level}`;
}

// Next-level threshold = baseline × LEVEL_STEP^(currentLevel).
// Used by any "next level at X" hover label that surfaces the
// progression target in display units.
export function nextLevelTarget(history, hand, grip, zone) {
  const baseline = getBaseline(history, hand, grip, zone);
  if (!baseline) return null;
  const level = calcLevel(history, hand, grip, zone);
  return Math.round(baseline * Math.pow(LEVEL_STEP, level) * 10) / 10;
}

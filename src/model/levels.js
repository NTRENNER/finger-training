// ─────────────────────────────────────────────────────────────
// LEVELING / GAMIFICATION MODEL
// ─────────────────────────────────────────────────────────────
// Computes per-(hand, grip, targetDuration) baselines and current
// "level" — the gamification surface for the Journey tab and for
// SetupView's level-up prompts on session save.
//
// Baseline = best qualifying rep from the user's FIRST session at
// that (hand, grip, target_duration). Subsequent sessions earn
// levels for every LEVEL_STEP (5%) improvement over baseline.
// Failed reps that didn't reach 98% of target_duration don't count
// toward baselines or PRs — see isQualifyingRep below.
//
// This module is read-only over the rep history. It does not write
// state; SetupView is responsible for diffing pre- vs post-save
// levels to decide whether to show the level-up animation.

import { effectiveLoad } from "./prescription.js";

// 5% improvement over baseline = next level. With this geometric
// step, level 5 ≈ 22% over baseline, level 10 ≈ 55%, level 20 ≈
// 2.4× — the curve gets steep enough to reward sustained
// progression without making early gains feel cheap.
export const LEVEL_STEP = 1.05;

// Qualifying rep gate. A bailed rep that only made it 50% of the
// way through doesn't represent a baseline-quality effort, so we
// don't credit it. Reps with no actual_time_s data (manual entries)
// or no targetDuration default to qualifying — we'd rather
// over-count baselines than throw away clean PRs to a missing
// timestamp.
export function isQualifyingRep(r, targetDuration) {
  if (!r.actual_time_s || !targetDuration) return true;
  return r.actual_time_s >= targetDuration * 0.98;
}

// Group qualifying reps for a (hand, grip, targetDuration) tuple
// into sessions, oldest first. session_id is the primary grouping
// key; date is a fallback for older rows that don't have one.
// Returns [{ key, date, reps[] }] sorted ascending by date.
export function groupSessions(history, hand, grip, targetDuration) {
  const matches = history.filter(r =>
    r.hand === hand &&
    (!grip || r.grip === grip) &&
    r.target_duration === targetDuration &&
    effectiveLoad(r) > 0 &&
    isQualifyingRep(r, targetDuration)
  );
  const map = new Map();
  matches.forEach(r => {
    const key = r.session_id || r.date;
    if (!map.has(key)) map.set(key, { key, date: r.date, reps: [] });
    map.get(key).reps.push(r);
  });
  return [...map.values()].sort((a, b) => a.date < b.date ? -1 : 1);
}

// Baseline = best qualifying rep from the FIRST session only.
// Locking baseline to session 1 means the user can't "improve their
// baseline" by sandbagging session 2 — only true PRs count for
// progression.
export function getBaseline(history, hand, grip, targetDuration) {
  const sessions = groupSessions(history, hand, grip, targetDuration);
  if (sessions.length === 0) return null;
  const firstReps = sessions[0].reps;
  return Math.max(...firstReps.map(r => effectiveLoad(r)));
}

// Best load = best qualifying rep from sessions AFTER the first.
// First session always = level 1 regardless of within-session
// variance, so we exclude it from the PR pool.
export function getBestLoad(history, hand, grip, targetDuration) {
  const sessions = groupSessions(history, hand, grip, targetDuration);
  if (sessions.length < 2) return null;
  const laterReps = sessions.slice(1).flatMap(s => s.reps);
  if (laterReps.length === 0) return null;
  return Math.max(...laterReps.map(r => effectiveLoad(r)));
}

// Level = floor(log_{LEVEL_STEP}(best/baseline)) + 1, clamped at 1.
// First session OR no improvement yet → level 1. Every additional
// LEVEL_STEP (5%) over baseline bumps the level by 1.
export function calcLevel(history, hand, grip, targetDuration) {
  const baseline = getBaseline(history, hand, grip, targetDuration);
  if (!baseline || baseline <= 0) return 1;
  const best = getBestLoad(history, hand, grip, targetDuration);
  if (!best || best <= baseline) return 1;
  return Math.max(1, 1 + Math.floor(Math.log(best / baseline) / Math.log(LEVEL_STEP)));
}

// Plain-string title for a numeric level. Kept as a function in
// case we want richer labels (e.g. emoji/medal tier) later.
export function levelTitle(level) {
  return `Level ${level}`;
}

// Next-level threshold = baseline × LEVEL_STEP^(currentLevel).
// Used by the (currently-removed) Setup-page level card; kept here
// for the Journey tab's "next level at X" hover label.
export function nextLevelTarget(history, hand, grip, targetDuration) {
  const baseline = getBaseline(history, hand, grip, targetDuration);
  if (!baseline) return null;
  const level = calcLevel(history, hand, grip, targetDuration);
  return Math.round(baseline * Math.pow(LEVEL_STEP, level) * 10) / 10;
}

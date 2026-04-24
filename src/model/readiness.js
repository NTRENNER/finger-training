// ─────────────────────────────────────────────────────────────
// READINESS / RECOVERY MODEL
// ─────────────────────────────────────────────────────────────
// Computes a 1-10 readiness score from recent training history.
// Uses an exponential decay model with ~24h recovery half-life
// to estimate how much yesterday's (and today's) work is still
// hanging on the user's hands.
//
// Score 10 = fully fresh; 1 = extremely fatigued.
//
// Pure model code: no React, no DOM. The UI-coupled bits
// (FEEL_OPTIONS for the subjective picker, subjToScore for the
// 1-5→1-10 mapping, recoveryLabel for the colored badge) live
// in App.js / SetupView since they carry theme colors and emoji.

import { clamp, today } from "../util.js";
import { effectiveLoad } from "./prescription.js";

export function computeReadiness(history) {
  if (!history || history.length === 0) return 10;
  const todayStr = today();

  // Bucket reps by date so each session is summed once.
  const byDate = {};
  for (const r of history) {
    if (!r.date) continue;
    if (!byDate[r.date]) byDate[r.date] = [];
    byDate[r.date].push(r);
  }

  // Per-session load = sum of normalized rep doses
  // (weight/refW × sqrt(dur/refDur)) — bigger weight or longer
  // hangs cost more, but the sqrt damps the duration term so a
  // 60s capacity rep doesn't dwarf a 7s power rep by 8.5×.
  let totalRemaining = 0;
  for (const [date, reps] of Object.entries(byDate)) {
    const load = reps.reduce((sum, r) => {
      const w = effectiveLoad(r) || r.weight_kg || 10;
      const d = r.actual_time_s || 10;
      return sum + (w / 20) * Math.sqrt(d / 45);
    }, 0);

    // Estimate hours since this session. We don't store time-of-day,
    // so today's session is treated as ~3h ago (a typical morning
    // training slot) and earlier sessions are dated to ~8h before
    // midnight on their date — this avoids the implausible 0h-ago
    // case where a session logged today reports 0% recovery.
    const hoursAgo = date === todayStr
      ? 3
      : (new Date(todayStr) - new Date(date)) / (1000 * 3600 * 24) * 24 + 8;

    // Exponential decay: ~50% load remaining after 24h.
    totalRemaining += load * Math.exp(-hoursAgo / 24);
  }

  // Reference: a heavy session of ~15 baseline-loaded reps → load ≈ 15.
  // 15 units of remaining load saturates at score 1; 0 → 10.
  return Math.max(1, Math.round(10 - clamp(totalRemaining / 15 * 9, 0, 9)));
}

// ──────────────────────────────────────────────────────────────
// OVER-PULL ADHERENCE
// ──────────────────────────────────────────────────────────────
// After a session, flag when the user trained meaningfully HEAVIER
// than what was prescribed. On grips with a small W' (e.g. Micro) this
// is the main reason long holds fail short, and — because the F-D fit
// learns from where you actually fail — over-pulling to an early
// failure gives the model worse data than holding the prescribed load
// to a later failure. The post-session summary surfaces a gentle nudge.

import { effectiveLoad, prescribedLoad } from "./load.js";

// Flag threshold: average load running this many % over prescribed.
export const OVERPULL_ALERT_PCT = 8;

// Average over-pull across a session's reps: mean(effectiveLoad /
// prescribed − 1), in percent. Only reps with a positive prescribed
// load AND a positive effective load count. Returns { pct, isOver, n }.
export function sessionOverpull(reps, thresholdPct = OVERPULL_ALERT_PCT) {
  const ratios = [];
  for (const r of reps || []) {
    const presc = prescribedLoad(r);
    const eff = effectiveLoad(r);
    if (presc > 0 && eff > 0) ratios.push(eff / presc - 1);
  }
  if (ratios.length === 0) return { pct: 0, isOver: false, n: 0 };
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const pct = Math.round(mean * 100);
  return { pct, isOver: pct >= thresholdPct, n: ratios.length };
}

import { predForceThreeExp } from "./threeExp.js";
import { SUPPORT_MIN_HOLD_FRAC } from "./baselines.js";
import { ZONE_REF_T } from "./zones.js";
import { freshFitReps, sane } from "./load.js";

const validAmps = amps => Array.isArray(amps) && amps.length === 3
  && amps.every(n => Number.isFinite(n) && n >= 0) && amps.some(n => n > 0);

// Later-supported zones keep their own baseline. Never borrow one from
// after the selected comparison date when scrubbing through history.
export function zoneReference(overlay, zone, throughDate) {
  const duration = ZONE_REF_T[zone];
  if (!overlay || !duration || (throughDate && overlay.baselineDate > throughDate)) return null;
  if (overlay.baselineMaxHoldS == null || overlay.baselineMaxHoldS >= duration * SUPPORT_MIN_HOLD_FRAC) {
    return validAmps(overlay.baselineAmps)
      ? { amps: overlay.baselineAmps, date: overlay.baselineDate, maxHold: overlay.baselineMaxHoldS }
      : null;
  }
  for (const date of [...(overlay.dates || [])].sort()) {
    if (throughDate && date > throughDate) break;
    const maxHold = overlay.maxHoldByDate?.get(date);
    const amps = overlay.ampsByDate?.get(date);
    if (maxHold >= duration * SUPPORT_MIN_HOLD_FRAC && validAmps(amps)) {
      return { amps, date, maxHold };
    }
  }
  return null;
}

export function forceComparison(overlay, zone, date) {
  const reference = zoneReference(overlay, zone, date);
  const currentAmps = overlay?.ampsByDate?.get(date);
  if (!reference || !validAmps(currentAmps)) return null;
  const duration = ZONE_REF_T[zone];
  const before = predForceThreeExp(reference.amps, duration);
  const now = predForceThreeExp(currentAmps, duration);
  return { before, now, delta: now - before, percent: (now / before - 1) * 100, duration, baselineDate: reference.date };
}

// Invert only inside the duration range supported by actual holds.
// An unreachable load or unsupported long hold is unknown, not zero.
export function holdTimeAtForce(amps, force, maxDuration) {
  if (!validAmps(amps) || !Number.isFinite(force) || !(force > 0)
    || !Number.isFinite(maxDuration) || maxDuration < 5) return null;
  if (force > predForceThreeExp(amps, 5) || force < predForceThreeExp(amps, maxDuration)) return null;
  let low = 5;
  let high = maxDuration;
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2;
    if (predForceThreeExp(amps, mid) > force) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

export function comparisonReps(history, grip, hand = null) {
  return freshFitReps(history).filter(rep => rep.grip === grip
    && (!hand || rep.hand === hand) && rep.date
    && sane(rep.avg_force_kg) != null && Number(rep.actual_time_s) > 0);
}

export function defaultComparisonLoad(overlay, zone, reference, reps) {
  if (!reference) return null;
  const duration = ZONE_REF_T[zone];
  // Restrict the initial choice to the baseline date so future training
  // cannot move the comparison weight. Overshoots remain eligible.
  const candidates = reps.filter(rep => rep.date <= reference.date
    && rep.actual_time_s >= duration / 2 && rep.actual_time_s <= duration * 2
    && holdTimeAtForce(reference.amps, Number(rep.avg_force_kg), reference.maxHold) != null)
    .sort((a, b) => Math.abs(Math.log(a.actual_time_s / duration)) - Math.abs(Math.log(b.actual_time_s / duration))
      || a.date.localeCompare(b.date) || Number(a.avg_force_kg) - Number(b.avg_force_kg));
  return candidates.length ? Number(candidates[0].avg_force_kg)
    : predForceThreeExp(reference.amps, duration);
}

export function holdTimeSeries(overlay, reference, force, throughDate) {
  if (!reference) return [];
  const rows = new Map();
  rows.set(reference.date, { date: reference.date, seconds: holdTimeAtForce(reference.amps, force, reference.maxHold) });
  for (const date of overlay.dates || []) {
    if (date < reference.date || date > throughDate || date === reference.date) continue;
    rows.set(date, { date, seconds: holdTimeAtForce(overlay.ampsByDate.get(date), force, overlay.maxHoldByDate?.get(date)) });
  }
  return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
}


// Track force at one fixed duration, using the same baseline as its tile.
export function forceHistorySeries(overlay, zone, throughDate) {
  const reference = zoneReference(overlay, zone, throughDate);
  if (!reference) return [];
  const duration = ZONE_REF_T[zone];
  const rows = new Map([[reference.date, {
    date: reference.date, force: predForceThreeExp(reference.amps, duration),
  }]]);
  for (const date of overlay.dates || []) {
    if (date < reference.date || date > throughDate || date === reference.date) continue;
    const amps = overlay.ampsByDate?.get(date);
    rows.set(date, { date, force: validAmps(amps) ? predForceThreeExp(amps, duration) : null });
  }
  return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
}

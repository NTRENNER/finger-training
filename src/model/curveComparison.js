import { predForceThreeExp } from "./threeExp.js";
import { SUPPORT_MIN_HOLD_FRAC, baselineWindow } from "./baselines.js";
import { ZONE_REF_T } from "./zones.js";
import { effectiveLoad, freshFitReps, sane } from "./load.js";

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

export function progressForce(overlay,date,t) {
  const points=overlay?.progressPointsByDate?.get(date);
  if(!points?.length || overlay?.continuityByDate?.get(date)?.linked===false) return predForceThreeExp(overlay?.ampsByDate?.get(date),t);
  if(t<=points[0].t) return points[0].f;
  for(let i=1;i<points.length;i++) if(t<=points[i].t) {
    const a=points[i-1], b=points[i]; return a.f+(b.f-a.f)*(t-a.t)/(b.t-a.t);
  }
  return points.at(-1).f;
}

export function progressHoldTime(overlay,date,force) {
  const max=overlay?.maxHoldByDate?.get(date);
  if(!overlay?.progressPointsByDate?.has(date) || overlay?.continuityByDate?.get(date)?.linked===false) return holdTimeAtForce(overlay?.ampsByDate?.get(date),force,max);
  if(!(force>0) || !(max>=5) || force>progressForce(overlay,date,5) || force<progressForce(overlay,date,max)) return null;
  let lo=5,hi=max;
  for(let i=0;i<60;i++) {const mid=(lo+hi)/2; if(progressForce(overlay,date,mid)>force) lo=mid; else hi=mid;}
  return (lo+hi)/2;
}

export function forceComparison(overlay, zone, date) {
  const reference = zoneReference(overlay, zone, date);
  const currentAmps = overlay?.ampsByDate?.get(date);
  if (!reference || !validAmps(currentAmps)) return null;
  const duration = ZONE_REF_T[zone];
  const before = predForceThreeExp(reference.amps, duration);
  const now = progressForce(overlay,date,duration);
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
    rows.set(date, { date, seconds: progressHoldTime(overlay,date,force) });
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
    rows.set(date, { date, force: validAmps(amps) ? progressForce(overlay,date,duration) : null });
  }
  return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// The points under the Curve Improvement curves: each curve-fit rep (see
// curveFitReps) at its measured load. `baseline` marks the reps inside the
// baseline's own window, which both curves rest on; the rest feed only the
// "Now" fit. Sorted like the baseline builders so the window matches.
export function curveEvidence(fitReps, { grip, hand = null, baselineDate = null, forceFor = effectiveLoad } = {}) {
  const reps = fitReps
    .filter(r => r.grip === grip && (!hand || r.hand === hand))
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const window = baselineDate ? baselineWindow(reps.filter(r => (r.date || "") >= baselineDate)) : null;
  const inBaseline = new Set(window || []);
  return reps
    .map(r => ({ t: Number(r.actual_time_s), f: forceFor(r), date: r.date || "", baseline: inBaseline.has(r) }))
    .filter(p => Number.isFinite(p.f) && p.f > 0);
}

// The dots for one slider date. Baseline points always show, like the
// dashed curve; later points appear once "Now" reaches their date. `peak`
// covers every point in range so the y-axis never rescales while scrubbing.
export function curveEvidenceDots(evidence, { nowDate, tMin, tMax, display = f => f }) {
  const shown = evidence.filter(p => p.t >= tMin && p.t <= tMax);
  const dot = p => ({ x: p.t, y: display(p.f), date: p.date });
  return {
    baseline: shown.filter(p => p.baseline).map(dot),
    since: shown.filter(p => !p.baseline && p.date <= nowDate).map(dot),
    peak: shown.reduce((m, p) => Math.max(m, display(p.f)), 0),
  };
}

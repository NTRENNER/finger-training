// Research candidate only: offline evaluation and frozen shadow forecasts.
// Never supplies the athlete's prescribed load.
import { fitEstablishedTrend } from './capacityTrendFit.js';
import { prepareEvaluationRows } from './evaluationRows.js';
import { freshFitReps, sane } from './load.js';
import { loadProvenance } from './forceRecording.js';
import { predForceThreeExp } from './threeExp.js';
import { capLoad, CAPACITY_FLOOR_FULL_CONFIDENCE_DAYS, CAPACITY_FLOOR_EXPIRY_DAYS,
  CAPACITY_FLOOR_MAX_REVISION_DROP } from './prescription.js';

export const ADAPTIVE_EXPERIMENT = Object.freeze({ version: 2, windowDays: 42, maxDays: 6,
  confirmationDays: 3, fullInfluenceDays: 5, minimumDeviation: 0.05, nearbyRatio: 2,
  broadRatio: 3, broadBands: 3 });
const DAY = 86400000;
const median = xs => { const a = [...xs].sort((x, y) => x - y); const i = Math.floor(a.length / 2);
  return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2; };
const average = xs => xs.reduce((s, x) => s + x, 0) / xs.length;
const measured = r => sane(r.avg_force_kg) != null && r.actual_time_s > 0 && r.actual_time_s <= 600
  && ['measured_force', 'legacy_measured'].includes(loadProvenance(r));
const completeFailure = r => r.load_provenance === 'measured_force' && r.failure_valid === true
  && ['muscular_failure', 'target_force_failure'].includes(r.end_reason)
  && r.force_recording?.signal_quality === 'complete' && r.force_recording?.capacity_eligible === true;
const nextDate = date => new Date(Date.parse(date) + DAY).toISOString().slice(0, 10);
const daysOf = rows => [...new Set(rows.map(r => r.date))].sort();

function cleanHistory(history, hand, grip, referenceDate) {
  // Avoid treating an explicitly missing acquisition duration as numeric zero.
  const before = prepareEvaluationRows(history).rows.filter(r => r.date < referenceDate
    && !(r.force_recording?.basis === 'target_acquired'
      && !Number.isFinite(r.force_recording.acquisition_s)));
  const own = freshFitReps(before).filter(r => r.grip === grip && r.hand === hand && measured(r));
  const setup = own.at(-1)?.setup_id ?? null;
  const compatible = before.filter(r => r.grip !== grip || (r.setup_id ?? null) === setup);
  return { history: compatible, own: freshFitReps(compatible).filter(r => r.grip === grip && r.hand === hand && measured(r)) };
}

function confirmation(rows, amps) {
  const dates = daysOf(rows).slice(-ADAPTIVE_EXPERIMENT.maxDays).reverse();
  const run = [];
  let direction = 0;
  const threshold = Math.log(1 + ADAPTIVE_EXPERIMENT.minimumDeviation);
  for (const date of dates) {
    const rs = rows.filter(r => r.date === date);
    const logRatio = median(rs.map(r => Math.log(r.avg_force_kg / predForceThreeExp(amps, r.actual_time_s))));
    const sign = Math.abs(logRatio) > threshold ? Math.sign(logRatio) : 0;
    if (!sign || (direction && sign !== direction)) break;
    direction = sign;
    run.push({ date, logRatio, rows: rs, quality: average(rs.map(r => loadProvenance(r) === 'legacy_measured' ? 0.5 : 1)),
      complete: rs.every(completeFailure) });
  }
  if (run.length < ADAPTIVE_EXPERIMENT.confirmationDays) return null;
  const influence = Math.min(1, (run.length - 2) / 3) * average(run.map(d => d.quality));
  return { direction, influence, logRatio: median(run.map(d => d.logRatio)),
    dates: run.map(d => d.date).sort(), completeDates: run.filter(d => d.complete).map(d => d.date).sort(),
    durations: run.flatMap(d => d.rows.map(r => r.actual_time_s)) };
}

export function adaptiveEvidence(openers, amps, duration, referenceDate) {
  const earlier = openers.filter(r => r.date < referenceDate && r.target_duration >= 12);
  // Keep the last evidenced estimate through inactivity. Otherwise a confirmed
  // decline would silently turn into a rebound on day 43 without a new workout.
  // Freshness is separate metadata, not an unobserved force change.
  const lastEvidence = daysOf(earlier).at(-1);
  const recent = earlier.filter(r => Date.parse(lastEvidence) - Date.parse(r.date)
    <= ADAPTIVE_EXPERIMENT.windowDays * DAY);
  const local = confirmation(recent.filter(r => duration > 0
    && Math.max(duration, r.actual_time_s) / Math.min(duration, r.actual_time_s) <= ADAPTIVE_EXPERIMENT.nearbyRatio), amps);
  const broad = confirmation(recent, amps);
  const candidates = [];
  if (local) {
    const center = Math.exp(average(local.durations.map(t => Math.log(t))));
    const locality = Math.max(0, 1 - Math.abs(Math.log(duration / center)) / Math.log(2));
    candidates.push({ ...local, influence: local.influence * locality, scope: 'nearby' });
  }
  if (broad) {
    const min = Math.min(...broad.durations), max = Math.max(...broad.durations);
    const bands = new Set(broad.durations.map(t => Math.floor(Math.log(t) / Math.log(1.5))));
    if (max / min >= ADAPTIVE_EXPERIMENT.broadRatio && bands.size >= ADAPTIVE_EXPERIMENT.broadBands) {
      const distance = duration < min ? Math.log(min / Math.max(0.001, duration))
        : duration > max ? Math.log(duration / max) : 0;
      const locality = Math.max(0, 1 - distance / Math.log(2));
      candidates.push({ ...broad, influence: broad.influence * locality, scope: 'broad' });
    }
  }
  return candidates.filter(c => c.influence > 0).sort((a, b) => b.influence - a.influence)[0]
    || { direction: 0, influence: 0, logRatio: 0, dates: [], completeDates: [], scope: 'none' };
}

// Pool adjacent violators on log-force. A local adjustment must not create a
// curve that says someone can sustain MORE force for a longer hold.
export function decreasingLogProjection(forces) {
  const blocks = [];
  forces.forEach((force, index) => {
    blocks.push({ sum: Math.log(force), count: 1, start: index, end: index });
    while (blocks.length > 1) {
      const a = blocks.at(-2), b = blocks.at(-1);
      if (a.sum / a.count >= b.sum / b.count) break;
      blocks.splice(-2, 2, { sum: a.sum + b.sum, count: a.count + b.count, start: a.start, end: b.end });
    }
  });
  const out = [];
  for (const b of blocks) for (let i = b.start; i <= b.end; i++) out[i] = Math.exp(b.sum / b.count);
  return out;
}

export function buildAdaptiveCapacity(history, hand, grip, referenceDate) {
  const clean = cleanHistory(history, hand, grip, referenceDate);
  const trend = fitEstablishedTrend(clean.history, hand, grip, referenceDate);
  if (!trend) return null;
  const times = [...new Set([0, 1, 3, ...Array.from({ length: 121 }, (_, i) => i * 5)])].sort((a, b) => a - b);
  const evidenceAt = t => adaptiveEvidence(clean.own, trend.established, t, referenceDate);
  const raw = times.map(t => {
    const evidence = evidenceAt(t);
    return predForceThreeExp(trend.established, t) * Math.exp(evidence.influence * evidence.logRatio);
  });
  const forces = decreasingLogProjection(raw);
  const forceAt = t => {
    if (!(t >= 0 && t <= 600)) return null;
    const hi = times.findIndex(x => x >= t);
    if (hi === 0 || times[hi] === t) return forces[hi];
    const fraction = (t - times[hi - 1]) / (times[hi] - times[hi - 1]);
    return Math.exp(Math.log(forces[hi - 1]) * (1 - fraction) + Math.log(forces[hi]) * fraction);
  };
  return { ...trend, times, forces, forceAt, evidenceAt, openers: clean.own,
    evidenceAgeDays: (Date.parse(referenceDate) - Date.parse(trend.lastDate)) / DAY,
    projectionMaxChangePct: Math.max(...forces.map((f, i) => 100 * Math.abs(f / raw[i] - 1))) };
}

function ageConfidence(date, referenceDate) {
  const age = (Date.parse(referenceDate) - Date.parse(date)) / DAY;
  if (age <= CAPACITY_FLOOR_FULL_CONFIDENCE_DAYS) return 1;
  if (age >= CAPACITY_FLOOR_EXPIRY_DAYS) return 0;
  const x = (age - CAPACITY_FLOOR_FULL_CONFIDENCE_DAYS)
    / (CAPACITY_FLOOR_EXPIRY_DAYS - CAPACITY_FLOOR_FULL_CONFIDENCE_DAYS);
  return 1 - x * x * (3 - 2 * x);
}

// Read-only chronological replay. Cache belongs to one caller's immutable
// history/hand/grip, never shared across users, datasets, or edits.
export function adaptiveFloorReplay(history, hand, grip, target, referenceDate, existingFloor, cache = new Map()) {
  if (!(existingFloor > 0)) return { floor: existingFloor, events: [] };
  const clean = cleanHistory(history, hand, grip, referenceDate);
  const floorSources = clean.own.filter(r => r.actual_time_s >= target)
    .map(r => ({ ...r, discountedForce: r.avg_force_kg * ageConfidence(r.date, referenceDate) }))
    .filter(r => r.discountedForce > 0).sort((a, b) => b.discountedForce - a.discountedForce || b.date.localeCompare(a.date));
  const source = floorSources[0];
  if (!source) return { floor: existingFloor, events: [] };
  let floor = source.discountedForce;
  const events = [];
  for (const date of daysOf(clean.own).filter(d => d > source.date)) {
    const tomorrow = nextDate(date);
    if (!cache.has(tomorrow)) cache.set(tomorrow, buildAdaptiveCapacity(clean.history, hand, grip, tomorrow));
    const model = cache.get(tomorrow);
    if (!model) continue;
    const evidence = model.evidenceAt(target);
    const sourceDay = clean.own.filter(r => r.date === date && completeFailure(r));
    // Actual demonstrated ability can restore an earned lower floor.
    for (const r of sourceDay.filter(r => r.actual_time_s >= target)) floor = Math.max(floor,
      r.avg_force_kg * ageConfidence(r.date, referenceDate));
    if (evidence.direction !== -1 || evidence.completeDates.length < 3
      || !evidence.completeDates.includes(date) || evidence.completeDates.some(d => d <= source.date)) continue;
    const proposed = model.forceAt(target);
    const next = Math.min(floor, Math.max(floor * (1 - CAPACITY_FLOOR_MAX_REVISION_DROP), proposed));
    if (next < floor - 1e-8) events.push({ date, from: floor, to: next, evidenceDates: evidence.completeDates });
    floor = next;
  }
  return { floor: Math.min(existingFloor, floor), events, sourceDate: source.date };
}

export function applyAdaptiveBounds(value, bounds, revisedFloor = bounds.floorKg) {
  let result = capLoad(revisedFloor == null ? value : Math.max(value, revisedFloor), bounds.peakCapKg);
  if (bounds.endCeilKg != null) result = Math.min(result,
    revisedFloor == null ? bounds.endCeilKg : Math.max(bounds.endCeilKg, revisedFloor));
  return result;
}

export function adaptiveDuration(model, force) {
  if (!model || !(force > 0)) return { status: 'unavailable', seconds: null };
  if (force > model.forceAt(0)) return { status: 'above_curve', seconds: null };
  if (force < model.forceAt(600)) return { status: 'beyond_600s', seconds: null };
  let lo = 0, hi = 600;
  for (let i = 0; i < 50; i++) {
    const t = (lo + hi) / 2;
    if (model.forceAt(t) > force) lo = t; else hi = t;
  }
  return { status: 'estimated', seconds: (lo + hi) / 2 };
}

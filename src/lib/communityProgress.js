import { comparisonReps, forceComparison } from '../model/curveComparison.js';
import { SUPPORT_MIN_HOLD_FRAC } from '../model/baselines.js';
import { ZONE6, ZONE_REF_T } from '../model/zones.js';
import { buildPeakForceTrend } from '../model/peakForce.js';
import { loadProvenance } from '../model/forceRecording.js';
import { ymdLocal } from '../util.js';

export const STAR_STEPS = [1, 2, 5, 10, 20, 35, 50, 75, 100];
export const COMMUNITY_METRICS = [{ key: 'balanced', label: 'Balanced curve' }, ...ZONE6];
const geometricMean = values => Math.exp(values.reduce((sum, n) => sum + Math.log(n), 0) / values.length);

// Presentation-only adapter. Read the same frozen comparison as Analysis;
// neither change baseline pins nor fit a second community model.
export function communityComparison(overlay, metric, date) {
  if (metric !== 'balanced') {
    const point = forceComparison(overlay, metric, date);
    return point && { ...point, support: [metric] };
  }
  const support = ZONE6.filter(z => overlay?.baselineMaxHoldS == null
    || overlay.baselineMaxHoldS >= ZONE_REF_T[z.key] * SUPPORT_MIN_HOLD_FRAC).map(z => z.key);
  const points = support.map(key => forceComparison(overlay, key, date));
  if (!points.length || points.some(p => !p || !(p.before > 0) || !(p.now > 0))) return null;
  const before = geometricMean(points.map(p => p.before));
  const now = geometricMean(points.map(p => p.now));
  return { before, now, percent: (now / before - 1) * 100, baselineDate: overlay.baselineDate, support };
}

function evidenceTime(reps) {
  const times = reps.map(r => Number(r.rep_timing?.ended_at_ms)
    || Date.parse(r.session_started_at)).filter(t => Number.isFinite(t) && t > 0);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

export function communityProgress(history, overlays, today) {
  const stars = [], current = [];
  for (const [grip, overlay] of Object.entries(overlays || {})) {
    const evidence = comparisonReps(history, grip);
    const dates = [...new Set(evidence.map(r => r.date))]
      .filter(date => date <= today && overlay.ampsByDate?.has(date)).sort();
    for (const { key: metric } of COMMUNITY_METRICS) {
      let previous = null;
      const earned = new Set();
      for (const date of dates) {
        const point = communityComparison(overlay, metric, date);
        if (!point || !Number.isFinite(point.percent)) { previous = null; continue; }
        const basis = [grip, metric, point.baselineDate, point.support.join(',')].join('|');
        const snapshot = { grip, metric, date, ...point, basis };
        if (previous?.basis === basis && previous.date > point.baselineDate) {
          for (const threshold of STAR_STEPS) {
            const key = `v1|${basis}|${threshold}`;
            if (earned.has(key) || point.percent + 1e-10 < threshold || previous.percent + 1e-10 < threshold) continue;
            earned.add(key);
            stars.push({ achievement_key: key, grip, metric, milestone_pct: threshold,
              improvement_pct: Math.max(threshold, point.percent), baseline_date: point.baselineDate,
              achieved_date: date, prior_date: previous.date,
              occurred_at: evidenceTime(evidence.filter(r => r.date === date)),
              baseline_force_kg: point.before, current_force_kg: point.now, support_keys: point.support });
          }
        }
        previous = snapshot;
      }
      if (previous) current.push(previous);
    }
  }
  return { stars, current };
}

// One observed record per grip/hand, using the existing peak evidence gates.
// No extrapolated curve value, manual load, bodyweight division or rounding
// enters ranking. The display may round only after rank has been computed.
export function communityPeaks(history, today) {
  const result = [];
  const grips = [...new Set(history.map(r => r.grip).filter(Boolean))];
  for (const grip of grips) for (const hand of ['L', 'R']) {
    const rows = history.filter(r => r.grip === grip && r.hand === hand && r.date <= today
      && ['measured_force', 'legacy_measured'].includes(loadProvenance(r)));
    let best = null;
    buildPeakForceTrend(rows, { valueForRep: (peak, rep) => {
      if (!best || peak > best.kg || (peak === best.kg && rep.date < best.date)) best = { kg: peak, date: rep.date };
      return peak;
    } });
    if (best) result.push({ grip, hand, peak_kg: best.kg, measured_date: best.date });
  }
  return result;
}

export function similarStart(card, current) {
  return current.some(p => p.grip === card.grip && p.metric === card.metric
    && p.support.join(',') === card.support_keys.join(',')
    && Math.abs(card.baseline_force_kg / p.before - 1) <= 0.25);
}

// Publish one card for the highest milestone reached in a domain on a date.
// Lower steps remain private stars; retries use the immutable achievement key.
export function publicationCandidates(stars, enrolledAt) {
  const groups = new Map();
  const cutoff = Date.parse(enrolledAt);
  if (!Number.isFinite(cutoff)) return [];
  const cutoffDate = ymdLocal(new Date(cutoff));
  for (const star of stars) {
    const occurred = Date.parse(star.occurred_at);
    // Imported old sessions sometimes carry a newly generated timestamp.
    // Both the training date and the timestamp must be after enrollment.
    if (!Number.isFinite(occurred) || occurred < cutoff || occurred > Date.now() + 300000
      || star.achieved_date < cutoffDate) continue;
    const key = [star.grip, star.metric, star.achieved_date].join('|');
    if (!groups.has(key) || groups.get(key).milestone_pct < star.milestone_pct) groups.set(key, star);
  }
  return [...groups.values()];
}

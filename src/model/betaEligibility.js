import { isSeedArtifactRep } from './firstSessionEvidence.js';

const DAY_MS = 86400000;
export const BETA_CONSISTENCY_WEEKS = 13;
export const BETA_REQUIRED_WEEKS = 10;
export const BETA_DAYS_PER_WEEK = 2;
export const BETA_ELIGIBILITY_DESCRIPTION = 'Betas unlock after three calendar months of recorded training for this grip, with at least two training days in 10 weeks within a 13-week period. Each grip qualifies separately. Once earned, access stays available through lighter training periods and breaks. Extra hands and sets on one day count as one day.';
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;
const dateMs = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
};
const threeMonthsBefore = ms => {
  const d = new Date(ms), day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 3);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.getTime();
};

// Attendance is separate from model-quality evidence: sensor interruptions
// don't erase training. Count dates once across hands, sets and sessions for
// the selected grip only. A missing or unknown grip must never grant access.
// Experience is earned, not a rolling readiness score. Search historical
// 13-week periods as well as the current one; breaks cannot erase experience.
// Recompute from history so account changes/deleted evidence still take effect.
export function betaEligibility(history = [], asOf, grip) {
  const now = dateMs(asOf);
  const days = new Set();
  if (now != null && ['Micro', 'Crusher', 'Prime'].includes(grip)) for (const r of Array.isArray(history) ? history : []) {
    const date = dateMs(r?.date);
    if (date == null || date >= now || r?.grip !== grip
      || !['L', 'R'].includes(r.hand) || isSeedArtifactRep(r)
      || r.force_recording?.session_protocol?.id === 'peak_test'
      || !(Number(r.target_duration) > 5)
      || !(positive(r.actual_time_s) || positive(r.force_recording?.activity?.duration_s))) continue;
    days.add(date);
  }
  const ordered = [...days].sort((a, b) => a - b);
  const before = boundary => {
    let lo = 0, hi = ordered.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (ordered[mid] < boundary) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const weekCounts = end => Array.from({ length: BETA_CONSISTENCY_WEEKS }, (_, i) =>
    before(end - i * 7 * DAY_MS) - before(end - (i + 1) * 7 * DAY_MS));
  const count = weeks => weeks.filter(n => n >= BETA_DAYS_PER_WEEK).length;
  let weeklyDays = weekCounts(now), qualifyingWeeks = count(weeklyDays), bestEnd = now;
  const recentQualifyingWeeks = qualifyingWeeks;
  // Counts change only the day after a recorded date crosses a week boundary.
  // Evaluate those events rather than every calendar day (including long gaps).
  const ends = new Set();
  for (const day of ordered) for (let w = 0; w <= BETA_CONSISTENCY_WEEKS; w++) {
    const end = day + (1 + w * 7) * DAY_MS;
    if (end <= now) ends.add(end);
  }
  for (const end of ends) {
    const weeks = weekCounts(end), qualifying = count(weeks);
    if (qualifying > qualifyingWeeks) {
      weeklyDays = weeks; qualifyingWeeks = qualifying; bestEnd = end;
    }
  }
  const first = ordered[0] ?? null;
  const hasThreeMonths = now != null && first != null && first <= threeMonthsBefore(now);
  return { eligible: hasThreeMonths && qualifyingWeeks >= BETA_REQUIRED_WEEKS,
    hasThreeMonths, qualifyingWeeks, weeklyDays, recentQualifyingWeeks,
    consistencyPeriodThrough: first == null ? null : new Date(bestEnd - DAY_MS).toISOString().slice(0, 10),
    firstTrainingDate: first == null ? null : new Date(first).toISOString().slice(0, 10) };
}

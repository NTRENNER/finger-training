import { isSeedArtifactRep } from './firstSessionEvidence.js';

const DAY_MS = 86400000;
export const BETA_CONSISTENCY_WEEKS = 13;
export const BETA_REQUIRED_WEEKS = 10;
export const BETA_DAYS_PER_WEEK = 2;
export const BETA_ELIGIBILITY_DESCRIPTION = 'Betas unlock after three calendar months of recorded finger training, with at least two training days in 10 of the last 13 weeks. Extra sets and multiple grips on one day count as one day.';
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
// don't erase training. Count dates once across hands, grips, sets and sessions.
// Evaluate 13 complete rolling seven-day windows ending yesterday, so the
// current partial week neither penalizes nor prematurely unlocks the athlete.
export function betaEligibility(history = [], asOf) {
  const now = dateMs(asOf);
  const days = new Set();
  if (now != null) for (const r of Array.isArray(history) ? history : []) {
    const date = dateMs(r?.date);
    if (date == null || date >= now || !['Micro', 'Crusher', 'Prime'].includes(r?.grip)
      || !['L', 'R'].includes(r.hand) || isSeedArtifactRep(r)
      || r.force_recording?.session_protocol?.id === 'peak_test'
      || !(Number(r.target_duration) > 5)
      || !(positive(r.actual_time_s) || positive(r.force_recording?.activity?.duration_s))) continue;
    days.add(date);
  }
  const weeklyDays = Array.from({ length: BETA_CONSISTENCY_WEEKS }, (_, i) =>
    [...days].filter(d => d >= now - (i + 1) * 7 * DAY_MS && d < now - i * 7 * DAY_MS).length);
  const qualifyingWeeks = weeklyDays.filter(n => n >= BETA_DAYS_PER_WEEK).length;
  const first = days.size ? Math.min(...days) : null;
  const hasThreeMonths = now != null && first != null && first <= threeMonthsBefore(now);
  return { eligible: hasThreeMonths && qualifyingWeeks >= BETA_REQUIRED_WEEKS,
    hasThreeMonths, qualifyingWeeks, weeklyDays,
    firstTrainingDate: first == null ? null : new Date(first).toISOString().slice(0, 10) };
}

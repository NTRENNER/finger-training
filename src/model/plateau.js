import { volumeOpeningPoints, volumeExperimentStatus } from './volumeExperiment.js';
import { betaEligibility } from './betaEligibility.js';
import { prepareEvaluationRows } from './evaluationRows.js';
import { trainingDayContext } from './trainingDayContext.js';
import { firstSessionEvidence, isSeedArtifactRep } from './firstSessionEvidence.js';
import { zoneOf, TRAINING_ZONE_KEYS } from './zones.js';
import { attemptsOf } from './climbingFatigue.js';

// Research heuristics, not validated physiological thresholds. Compare raw
// native measurements; a refitted/smoothed curve cannot prove its own plateau.
export const PLATEAU_POLICY = Object.freeze({ version: 1, windowDays: 56, periodDays: 28,
  confirmationDays: 14, forceTolerance: 0.01, minDatesPerPeriod: 3,
  flatFraction: 0.05, maxSpread: 0.15, minActiveWeeks: 6, maxGapDays: 14 });
const DAY = 86400000;
const GRIPS = ['Micro', 'Crusher', 'Prime'];
const HANDS = ['L', 'R'];
const shift = (date, n) => new Date(Date.parse(date) + n * DAY).toISOString().slice(0, 10);
const validDate = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)
  && Number.isFinite(Date.parse(d)) && new Date(Date.parse(d)).toISOString().slice(0, 10) === d;
const unique = rows => [...new Set(rows.map(r => r.date))].sort();
const median = values => {
  const s = [...values].sort((a, b) => a - b), n = s.length;
  return n ? (s[Math.floor((n - 1) / 2)] + s[Math.ceil((n - 1) / 2)]) / 2 : null;
};
const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const basis = p => stable([p.basis, p.setupId, p.source, p.recordingVersion, p.policy, p.protocol, p.firstHand]);
const scope = p => `${p.grip}|${p.hand}|${zoneOf(p.targetDurationS || p.timeS)}`;
const work = r => !isSeedArtifactRep(r) && Number(r.actual_time_s) > 0 && Number(r.target_duration) > 5
  && r.force_recording?.session_protocol?.id !== 'peak_test';
const fatigue = r => r.session_cooked != null && Number.isFinite(Number(r.session_cooked)) ? Number(r.session_cooked) : null;

function compare(points, anchor, asOf) {
  const from = shift(asOf, -56), split = shift(asOf, -28);
  const matching = points.filter(p => p.date >= from && p.date < asOf && basis(p) === basis(anchor)
    && Math.abs(p.forceKg / anchor.forceKg - 1) <= PLATEAU_POLICY.forceTolerance + 1e-9);
  const early = matching.filter(p => p.date < split), recent = matching.filter(p => p.date >= split);
  const earlyS = median(early.map(p => p.timeS)), recentS = median(recent.map(p => p.timeS));
  const change = earlyS > 0 && recentS > 0 ? recentS / earlyS - 1 : null;
  const spread = group => group.length ? (Math.max(...group.map(p => p.timeS)) - Math.min(...group.map(p => p.timeS))) / median(group.map(p => p.timeS)) : null;
  const enough = early.length >= 3 && recent.length >= 3;
  const noisy = enough && Math.max(spread(early), spread(recent)) > PLATEAU_POLICY.maxSpread;
  const state = !enough ? 'insufficient' : noisy ? 'variable'
    : change > PLATEAU_POLICY.flatFraction ? 'improving'
      : change < -PLATEAU_POLICY.flatFraction ? 'declining' : 'flat';
  return { state, from, through: shift(asOf, -1), split, earlyCount: early.length, recentCount: recent.length,
    earlyS, recentS, changePct: change == null ? null : 100 * change,
    // Bounded receipts: all observations affect statistics, only six IDs per period are stored.
    earlyIds: early.slice(-6).map(p => p.id), recentIds: recent.slice(-6).map(p => p.id) };
}

function attendance(rows, grip, asOf) {
  const dates = unique(rows.filter(r => r.grip === grip && work(r) && r.date >= shift(asOf, -56) && r.date < asOf));
  const early = dates.filter(d => d < shift(asOf, -28)).length, recent = dates.length - early;
  const weeks = Array.from({ length: 8 }, (_, w) => dates.filter(d => d >= shift(asOf, -(w + 1) * 7) && d < shift(asOf, -w * 7)).length);
  const gaps = [shift(asOf, -56), ...dates, asOf].slice(1).map((d, i) => (Date.parse(d) - Date.parse([shift(asOf, -56), ...dates][i])) / DAY);
  const maxGap = Math.max(...gaps);
  return { earlyDays: early, recentDays: recent, activeWeeks: weeks.filter(n => n > 0).length, maxGap,
    steady: early >= 4 && recent >= 4 && recent / early >= 0.75 && recent / early <= 1.33
      && weeks.filter(n => n > 0).length >= 6 && maxGap <= 14 };
}

function confounders(rows, activities, grip, asOf) {
  const from = shift(asOf, -56), split = shift(asOf, -28);
  const own = rows.filter(r => r.grip === grip && work(r) && r.date >= from && r.date < asOf);
  const recent = own.filter(r => r.date >= split);
  const reasons = [];
  const dailyRatings = period => [...new Set(period.map(r => r.date))].map(d =>
    median(period.filter(r => r.date === d).map(fatigue).filter(n => n != null))).filter(n => n != null);
  const before = dailyRatings(own.filter(r => r.date < split)), after = dailyRatings(recent);
  if (after.length >= 2 && (median(after) >= 6 || (before.length >= 2 && median(after) - median(before) >= 2))) reasons.push('reported_fatigue');
  if (recent.some(r => Number(r.set_num) > 1 || r.force_recording?.volume_beta
    || r.force_recording?.session_protocol?.id === 'whole_curve_beta')) reasons.push('recent_dose_experiment');
  const climbs = (activities || []).filter(a => a?.type === 'climbing' && validDate(a.date) && a.date >= from && a.date < asOf);
  const counts = [climbs.filter(a => a.date < split), climbs.filter(a => a.date >= split)].map(rs => rs.reduce((n, a) => n + attemptsOf(a), 0));
  if (counts[1] >= 10 && (counts[0] === 0 || counts[1] > counts[0] * 1.25)) reasons.push('climbing_increased');
  return { reasons, fatigueDays: after.length, climbingAttempts: counts,
    contextLimited: !climbs.length || after.length < 2 };
}

export function detectPlateaus({ history = [], activities = [], asOf, experiments = {} } = {}) {
  if (!validDate(asOf)) throw new Error('A valid plateau review date is required.');
  const prepared = prepareEvaluationRows(Array.isArray(history) ? history : []);
  const rows = prepared.rows.filter(r => validDate(r.date) && r.date < asOf);
  // Determine ordering before removing conflicting/malformed measurements.
  // Otherwise a discarded opener could make a later session look fresh.
  const orderRows = (Array.isArray(history) ? history : []).filter(r => r && validDate(r.date) && r.date < asOf);
  const context = trainingDayContext(orderRows), first = firstSessionEvidence(orderRows);
  const rowById = new Map(rows.map(r => [r.id, r]));
  const excluded = { ...prepared.excluded, afterTraining: 0, unknownOrder: 0, highFatigue: 0 };
  const points = volumeOpeningPoints(rows, shift(asOf, -70), shift(asOf, -1)).filter(p => {
    const r = rowById.get(p.id);
    if (!r || !['first_session', 'only_recorded_session', 'legacy_single_session'].includes(first(r))
      || !(r.failure_valid === true || r.failed === true)
      || ['voluntary_stop', 'stopped_early'].includes(r.end_reason)) return false;
    const status = context(r).status;
    if (status !== 'first_recorded') { excluded[status === 'after_training' ? 'afterTraining' : 'unknownOrder']++; return false; }
    if (fatigue(r) >= 6) { excluded.highFatigue++; return false; }
    return p.timeS <= 600 && TRAINING_ZONE_KEYS.includes(zoneOf(p.targetDurationS || p.timeS));
  });
  const byGrip = GRIPS.map(grip => {
    const eligibility = betaEligibility(rows, asOf, grip);
    const frequency = attendance(rows, grip, asOf), contextInfo = confounders(rows, activities, grip, asOf);
    const cells = HANDS.flatMap(hand => TRAINING_ZONE_KEYS.map(zone => {
      const own = points.filter(p => scope(p) === `${grip}|${hand}|${zone}`);
      const anchor = own.at(-1);
      if (!anchor) return { hand, zone, status: 'insufficient', reason: 'No comparable fresh opening holds.' };
      const current = compare(own, anchor, asOf), prior = compare(own, anchor, shift(asOf, -14));
      const stale = anchor.date < shift(asOf, -14);
      const status = stale ? 'stale' : current.state !== 'flat' ? current.state
        : prior.state === 'flat' ? 'plateau' : 'watch';
      return { hand, zone, status, forceKg: anchor.forceKg, lastDate: anchor.date,
        basis: { timing: anchor.basis, recordingVersion: anchor.recordingVersion, protocol: anchor.protocol,
          setupId: anchor.setupId, firstHand: anchor.firstHand }, current, prior };
    }));
    const bothHandZones = TRAINING_ZONE_KEYS.filter(z => HANDS.every(h => cells.some(c => c.zone === z && c.hand === h && c.status === 'plateau')));
    const activeExperiment = Object.values(experiments || {}).some(e => ['active', 'paused'].includes(volumeExperimentStatus(e, asOf)));
    const blockers = [...contextInfo.reasons];
    if (!eligibility.eligible) blockers.push('beta_ineligible');
    if (!frequency.steady) blockers.push('inconsistent_attendance');
    if (activeExperiment) blockers.push('existing_experiment');
    if (cells.some(c => c.status === 'improving')) blockers.push('progress_continues');
    if (cells.some(c => c.status === 'declining')) blockers.push('performance_declining');
    if (!bothHandZones.length) blockers.push('no_persistent_bilateral_plateau');
    return { grip, eligibility, frequency, context: contextInfo, cells, plateauZones: bothHandZones, blockers,
      recommendation: blockers.length ? 'continue_observing' : 'consider_volume_beta' };
  });
  return { version: 1, asOf, policy: { ...PLATEAU_POLICY }, excluded, byGrip,
    experimental: true };
}

export const PLATEAU_REASON = {
  beta_ineligible: 'Three months of consistent training is not established for this grip.',
  inconsistent_attendance: 'Training frequency has changed or has gaps. Re-establish a steady schedule first.',
  existing_experiment: 'Finish or end the existing experiment before starting another.',
  progress_continues: 'Comparable performance is still improving elsewhere in this grip. Keep the current dose.',
  performance_declining: 'Some comparable performance is declining. Review fatigue and recovery before adding work.',
  no_persistent_bilateral_plateau: 'A persistent plateau in the same duration range on both hands is not established.',
  reported_fatigue: 'Reported fatigue is high or has increased.',
  recent_dose_experiment: 'Recent extra sets or Chaos sessions already changed the training dose or structure.',
  climbing_increased: 'Recorded climbing attempts increased; this can confound the comparison.',
};

// Keep a bounded, immutable enrollment receipt. The experiment's matched
// baseline remains separate; neither changes when future history accumulates.
export function plateauEnrollmentEvidence(report, grips, source = 'voluntary') {
  return { version: 1, asOf: report.asOf, source: source === 'plateau_prompt' ? source : 'voluntary',
    policy: { ...report.policy }, eligible: grips.length > 0
      && grips.every(grip => report.byGrip.some(g => g.grip === grip && g.eligibility?.eligible)),
    byGrip: report.byGrip.filter(g => grips.includes(g.grip)).map(g => ({
      grip: g.grip, recommendation: g.recommendation, blockers: [...g.blockers], frequency: { ...g.frequency },
      context: { ...g.context }, plateauZones: [...g.plateauZones],
      cells: g.cells.filter(c => c.current).map(c => ({ hand: c.hand, zone: c.zone, status: c.status,
        forceKg: c.forceKg, lastDate: c.lastDate, basis: c.basis,
        current: c.current, prior: c.prior })),
    })) };
}

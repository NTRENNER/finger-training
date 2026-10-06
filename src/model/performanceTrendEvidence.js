// Evidence annotations for the descriptive performance charts. This module
// never changes the force observations, fitted curves, starting reference,
// prescriptions, or existing long/short percentages.
import { buildPerformanceTrends, DEFAULT_PERFORMANCE_TREND_MODEL } from './performanceTrends.js';
import { fitEstablishedTrend, TREND_EXPERIMENT } from './capacityTrendFit.js';
import { fitContextualTrend } from './contextualTrendFit.js';
import { trainingDayContext } from './trainingDayContext.js';
import { loadProvenance } from './forceRecording.js';
import { computeBalancedCurveScore, predForceThreeExp } from './threeExp.js';
import { ZONE_REF_T } from './zones.js';

export const PERFORMANCE_REFERENCE_DURATIONS = Object.freeze(Object.values(ZONE_REF_T));
export const PERFORMANCE_DURATION_BANDS = Object.freeze([
  Object.freeze({ id: 'short', label: 'Short (≤45 s)', minExclusive: 0, maxInclusive: 45 }),
  Object.freeze({ id: 'medium', label: 'Medium (>45–120 s)', minExclusive: 45, maxInclusive: 120 }),
  Object.freeze({ id: 'long', label: 'Long (>120 s)', minExclusive: 120, maxInclusive: Infinity }),
]);
export const DURATION_BAND_LABELS = Object.freeze(Object.fromEntries(
  PERFORMANCE_DURATION_BANDS.map(band => [band.id, band.label]),
));

// Engineering coverage labels, not statistical confidence intervals or a
// physiological readiness test. A reference duration has local support when
// each selected hand has observations on >=2 distinct dates within ±25% of
// that duration (at least ±3 seconds for short holds). Repeated holds on one
// date cannot turn sparse coverage into supported coverage. These diagnostics
// describe evidence available by the plotted date, including older evidence;
// lastDate makes its age visible. They do not assert that the athlete is rested.
export const PERFORMANCE_EVIDENCE_POLICY = Object.freeze({
  version: 1,
  minimumNearbyDates: 2,
  relativeDurationRadius: 0.25,
  minimumDurationRadiusSeconds: 3,
});

const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const geometricMean = values => Math.exp(mean(values.map(Math.log)));
const nextDate = date => new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10);
const distinctDates = rows => [...new Set(rows.map(row => row.date))].sort();
const supportStatus = dates => dates >= PERFORMANCE_EVIDENCE_POLICY.minimumNearbyDates
  ? 'supported' : dates ? 'sparse' : 'unobserved';

export function performanceDurationBand(duration) {
  return PERFORMANCE_DURATION_BANDS.find(band => duration > band.minExclusive && duration <= band.maxInclusive)?.id ?? null;
}

function recordingMethod(rep) {
  const recording = rep.force_recording || {};
  const basis = recording.basis || 'legacy_elapsed';
  const version = recording.version ?? null;
  const policy = recording.failure_policy?.version ?? null;
  const provenance = loadProvenance(rep);
  const basisLabel = basis === 'target_acquired' ? 'Target-acquired interval'
    : basis === 'legacy_elapsed' ? 'Legacy whole-pull interval' : basis;
  const parts = [basisLabel];
  if (version != null) parts.push(`recording v${version}`);
  if (policy != null) parts.push(`failure policy v${policy}`);
  if (policy == null) parts.push('stopping policy unknown');
  return {
    key: [provenance, basis, version ?? 'unknown', policy ?? 'unknown', recording.averaging_basis || 'unspecified'].join('|'),
    label: parts.join(' · '),
    basis,
    version,
    failurePolicyVersion: policy,
  };
}

function recordingMethods(rows) {
  const groups = new Map();
  for (const row of rows) {
    const method = recordingMethod(row);
    if (!groups.has(method.key)) groups.set(method.key, { ...method, rows: [] });
    groups.get(method.key).rows.push(row);
  }
  return [...groups.values()].map(({ rows: members, ...method }) => {
    const dates = distinctDates(members);
    return { ...method, dates: dates.length, holds: members.length, firstDate: dates[0], lastDate: dates.at(-1) };
  }).sort((a, b) => a.firstDate.localeCompare(b.firstDate) || a.key.localeCompare(b.key));
}

function localSupport(rows, duration) {
  const radius = Math.max(PERFORMANCE_EVIDENCE_POLICY.minimumDurationRadiusSeconds,
    duration * PERFORMANCE_EVIDENCE_POLICY.relativeDurationRadius);
  const range = { min: Math.max(0, duration - radius), max: duration + radius };
  const nearby = rows.filter(row => row.actual_time_s >= range.min && row.actual_time_s <= range.max);
  const dates = distinctDates(nearby);
  return { duration, status: supportStatus(dates.length), dates: dates.length,
    holds: nearby.length, range, lastDate: dates.at(-1) ?? null };
}

function evidenceFor(snapshot) {
  const context = trainingDayContext(snapshot.history.filter(row => row.date <= snapshot.date));
  const perHand = snapshot.hands.map((hand, index) => {
    const own = snapshot.eligible.filter(row => row.hand === hand);
    const durations = own.map(row => row.actual_time_s);
    const contexts = { first_recorded: 0, after_training: 0, unknown: 0 };
    for (const row of own) contexts[context(row).status] += 1;
    return {
      hand,
      eligibleDates: distinctDates(own).length,
      eligibleHolds: own.length,
      effectiveDays: snapshot.models[index]?.effectiveDays ?? 0,
      durationRange: { min: durations.length ? Math.min(...durations) : null,
        max: durations.length ? Math.max(...durations) : null },
      referenceSupport: PERFORMANCE_REFERENCE_DURATIONS.map(duration => localSupport(own, duration)),
      recordingMethods: recordingMethods(own),
      contexts,
    };
  });
  const referenceSupport = PERFORMANCE_REFERENCE_DURATIONS.map((duration, index) => {
    const hands = perHand.map(hand => ({ hand: hand.hand, ...hand.referenceSupport[index] }));
    const dates = Math.min(...hands.map(hand => hand.dates));
    return { duration, status: supportStatus(dates), dates, perHand: hands };
  });
  const supported = referenceSupport.filter(support => support.status === 'supported').length;
  const methods = recordingMethods(snapshot.eligible);
  const reasons = [];
  if (supported < PERFORMANCE_REFERENCE_DURATIONS.length) {
    reasons.push(`Only ${supported} of ${PERFORMANCE_REFERENCE_DURATIONS.length} reference durations have at least two nearby training dates for every selected hand.`);
  }
  if (methods.length > 1) reasons.push('Recording methods differ within this history; timing and stopping rules may not be identical.');
  return {
    status: supported === PERFORMANCE_REFERENCE_DURATIONS.length ? 'supported' : 'limited',
    label: `Local support at ${supported} of ${PERFORMANCE_REFERENCE_DURATIONS.length} durations`,
    reasons,
    eligibleDates: Math.min(...perHand.map(hand => hand.eligibleDates)),
    perHand,
    referenceSupport,
    recordingMethods: methods,
  };
}

function baselineStability(snapshot, evidence, model) {
  const dates = distinctDates(snapshot.eligible);
  // At the usual first-qualifying reference, at least one hand has exactly
  // five dates. A leave-one-date refit then fails the existing model gate.
  // Do not lower that gate, silently rebase, or report a zero sensitivity.
  if (evidence.perHand.some(hand => hand.eligibleDates <= TREND_EXPERIMENT.minPriorDays)) {
    return { status: 'insufficient', label: 'Insufficient for stability check',
      reason: 'Removing a training date would leave fewer than five eligible dates for at least one selected hand.',
      testedDates: 0, totalDates: dates.length };
  }
  const changes = [];
  for (const excludedDate of dates) {
    const retained = snapshot.history.filter(row => row.date <= snapshot.date && row.date !== excludedDate);
    const scores = snapshot.hands.map(hand => {
      const fit = model === 'original'
        ? fitEstablishedTrend(retained, hand, snapshot.grip, nextDate(snapshot.date), { prepared: true })
        : fitContextualTrend(retained, hand, snapshot.grip, nextDate(snapshot.date),
          { prepared: true, robust: model === 'contextRobust' });
      return fit ? computeBalancedCurveScore(fit.established) : null;
    });
    if (!scores.every(score => Number.isFinite(score) && score > 0)) {
      return { status: 'insufficient', label: 'Insufficient for stability check',
        reason: 'At least one leave-one-date refit has insufficient eligible history.',
        testedDates: changes.length, totalDates: dates.length };
    }
    changes.push(100 * (geometricMean(scores) / snapshot.score - 1));
  }
  return { status: 'available', label: 'Leave-one-date sensitivity',
    reason: 'Variation after removing each training date in turn; this is not a confidence interval.',
    testedDates: changes.length, totalDates: dates.length,
    changeRange: [Math.min(...changes), Math.max(...changes)],
    maxAbsoluteChange: Math.max(...changes.map(Math.abs)) };
}

function startingEvidence(snapshot, evidence, model) {
  const stability = baselineStability(snapshot, evidence, model);
  const provisional = evidence.status !== 'supported' || stability.status === 'insufficient'
    || evidence.recordingMethods.length > 1;
  const reasons = [...evidence.reasons];
  if (stability.status === 'insufficient') reasons.push(stability.reason);
  return { ...evidence, status: provisional ? 'provisional' : 'supported',
    label: provisional ? 'Provisional starting reference' : 'Starting reference has local support', reasons, stability };
}

function pooledReferenceForces(snapshot) {
  return PERFORMANCE_REFERENCE_DURATIONS.map(duration => geometricMean(
    snapshot.models.map(fit => predForceThreeExp(fit.established, duration)),
  ));
}

function observationFor({ rep, expectedForce, deviation, context }) {
  const recording = rep.force_recording || {};
  const method = recordingMethod(rep);
  const converted = recording.interval_basis_applied === 'legacy_elapsed';
  return {
    id: rep.id || [rep.date, rep.session_id || '', rep.grip, rep.hand, rep.set_num ?? '',
      rep.rep_num ?? '', rep.target_duration ?? '', rep.actual_time_s, rep.avg_force_kg, rep.manual_load_kg ?? ''].join('|'),
    date: rep.date,
    timestamp: Date.parse(rep.date),
    grip: rep.grip,
    hand: rep.hand,
    duration: rep.actual_time_s,
    force: rep.avg_force_kg,
    expectedForce,
    deviation,
    durationBand: performanceDurationBand(rep.actual_time_s),
    context: context.status,
    earlierGrips: context.earlierGrips,
    earlierSessions: context.earlierSessions,
    recordingBasis: method.basis,
    recordingMethod: method.label,
    recordingCompatibility: converted
      ? 'Duration includes recorded acquisition time for the legacy comparison; stopping-policy differences remain.'
      : method.basis === 'legacy_elapsed'
        ? 'Legacy recording interval; acquisition and stopping details may be unknown.'
        : 'Native recorded interval; comparisons still depend on recording and stopping rules.',
  };
}

// The original builder owns all eligibility, duration/basis guards, causal
// fits and daily aggregation. Its optional sink supplies those same inputs;
// this wrapper only annotates them. There is intentionally no activities or
// fatigue-correction argument. Climbing context belongs beside the readings.
export function buildPerformanceTrendAnalysis(history, grips, hand = 'pooled',
  { model = DEFAULT_PERFORMANCE_TREND_MODEL } = {}) {
  const baselines = new Map(), peaks = new Map(), annotations = new Map();
  const observations = [];
  const rows = buildPerformanceTrends(history, grips, hand, { model, onEvidence: snapshot => {
    observations.push(...snapshot.observations.map(observationFor));
    if (!(Number.isFinite(snapshot.score) && snapshot.score > 0)) return;
    const currentEvidence = evidenceFor(snapshot);
    const forces = pooledReferenceForces(snapshot);
    if (!baselines.has(snapshot.grip)) baselines.set(snapshot.grip, {
      date: snapshot.date, score: snapshot.score, forces,
      evidence: startingEvidence(snapshot, currentEvidence, model),
    });
    if (!peaks.has(snapshot.grip) || snapshot.score > peaks.get(snapshot.grip).score) {
      peaks.set(snapshot.grip, { date: snapshot.date, score: snapshot.score, forces, evidence: currentEvidence });
    }
    const baseline = baselines.get(snapshot.grip), peak = peaks.get(snapshot.grip);
    const detail = {
      date: snapshot.date,
      score: snapshot.score,
      baselineDate: baseline.date,
      baselineScore: baseline.score,
      peakDate: peak.date,
      peakScore: peak.score,
      changeFromPeak: 100 * (snapshot.score / peak.score - 1),
      referenceForces: PERFORMANCE_REFERENCE_DURATIONS.map((duration, index) => {
        const currentSupport = currentEvidence.referenceSupport[index].status;
        const baselineSupport = baseline.evidence.referenceSupport[index].status;
        const peakSupport = peak.evidence.referenceSupport[index].status;
        return { duration, force: forces[index], baselineForce: baseline.forces[index], peakForce: peak.forces[index],
          currentSupport, baselineSupport, peakSupport,
          currentSupported: currentSupport === 'supported', baselineSupported: baselineSupport === 'supported',
          peakSupported: peakSupport === 'supported' };
      }),
      baselineEvidence: baseline.evidence,
      currentEvidence,
      peakEvidence: peak.evidence,
    };
    if (!annotations.has(snapshot.date)) annotations.set(snapshot.date, {});
    annotations.get(snapshot.date)[`${snapshot.grip}_evidence`] = detail;
  } });
  return { rows: rows.map(row => ({ ...row, ...annotations.get(row.date) })), observations };
}

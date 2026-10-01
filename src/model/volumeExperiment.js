import { today, uuid } from '../util.js';
import { firstSessionEvidence, isSeedArtifactRep } from './firstSessionEvidence.js';
import { isCapacityEvidenceRep } from './forceRecording.js';
import { sane } from './load.js';
import { recordedSessionPrescription } from './progressionEvidence.js';
import { isVolumeRepComplete } from './volumeSession.js';

const DAY_MS = 86400000;
const DAYS = 42;
const LOAD_TOLERANCE = 0.03;
const HANDS = ['L', 'R'];
const GRIPS = ['Micro', 'Crusher', 'Prime'];
const asRows = history => Array.isArray(history) ? history : [];
const FIRST = ['first_session', 'only_recorded_session', 'legacy_single_session'];
const INTERRUPTED = ['interrupted', 'equipment_interruption', 'target_not_reached'];
const positive = x => Number.isFinite(x) && x > 0;
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const validTimestamp = value => typeof value === 'string' && value.includes('T') && Number.isFinite(Date.parse(value));
const shift = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const mean = points => points.length ? points.reduce((sum, p) => sum + p.timeS, 0) / points.length : null;
const freeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
const duration = r => Math.max(0, Number(r.force_recording?.activity?.duration_s
  ?? r.force_recording?.elapsed_activity_s ?? r.actual_time_s) || 0);
const sameBasis = (a, b) => a.basis === b.basis && a.setupId === b.setupId
  && a.source === b.source && a.recordingVersion === b.recordingVersion && stable(a.policy) === stable(b.policy);
const matching = (point, benchmark) => sameBasis(point, benchmark)
  && Math.abs(point.forceKg - benchmark.loadKg) <= benchmark.loadKg * LOAD_TOLERANCE + 1e-9;

// Preserve original force and timing bases. Converting acquisition time back
// to legacy elapsed time cannot undo a detector change, so this experiment
// deliberately does not use the converted freshFitReps output.
function openingPoints(history, from, through) {
  const rows = asRows(history).filter(r => r && validDate(r.date) && r.date >= from && r.date <= through);
  const first = firstSessionEvidence(rows);
  const byDay = new Map();
  for (const r of rows) {
    if (!FIRST.includes(first(r)) || !HANDS.includes(r.hand)
      || Number(r.set_num ?? 1) !== 1 || Number(r.rep_num ?? 1) !== 1
      || !isCapacityEvidenceRep(r) || isSeedArtifactRep(r)
      || !positive(Number(r.actual_time_s)) || Number(r.target_duration) <= 5
      || INTERRUPTED.includes(r.end_reason) || r.force_recording?.signal_quality === 'incomplete') continue;
    // Never substitute the prescribed spring target for measured force.
    const measured = sane(r.avg_force_kg);
    const known = r.load_provenance === 'known_external_load' ? sane(r.manual_load_kg) : null;
    if (measured == null && known == null) continue;
    const point = {
      id: r.id ?? null, date: r.date, grip: r.grip, hand: r.hand,
      sessionId: r.session_id ?? null, forceKg: measured ?? known, timeS: Number(r.actual_time_s),
      targetDurationS: positive(Number(r.target_duration)) ? Number(r.target_duration) : null,
      basis: r.force_recording?.basis ?? 'legacy_elapsed', setupId: r.setup_id ?? null,
      source: measured != null ? 'measured_force' : 'known_external_load',
      recordingVersion: r.force_recording?.version ?? null,
      policy: clone(r.force_recording?.failure_policy),
      protocol: r.force_recording?.session_protocol?.id ?? 'ordinary', cooked: r.session_cooked ?? null,
      firstHand: r.force_recording?.hand_order?.first_hand ?? null,
    };
    const key = stable([point.grip, point.hand, point.date]);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(point);
  }
  // A date contributes once. Conflicting copies of its opening measurement
  // are ambiguous; identical copies do not invent another independent test.
  return [...byDay.values()].flatMap(points => {
    const signature = p => stable({ ...p, id: null });
    return new Set(points.map(signature)).size === 1 ? [points[0]] : [];
  }).sort((a, b) => a.date.localeCompare(b.date));
}

export function buildVolumeBaseline({ history = [], grips = [], startDate = today() } = {}) {
  if (!validDate(startDate)) throw new Error('A valid experiment start date is required.');
  const windowStart = shift(startDate, -DAYS), windowEnd = shift(startDate, -1);
  const candidates = openingPoints(history, windowStart, windowEnd);
  const selected = [...new Set(grips)].filter(grip => GRIPS.includes(grip));
  const byHand = selected.flatMap(grip => HANDS.map(hand => {
    const rows = candidates.filter(p => p.grip === grip && p.hand === hand);
    const latest = rows.at(-1);
    const benchmark = { grip, hand, loadKg: latest?.forceKg ?? null, basis: latest?.basis ?? null,
      setupId: latest?.setupId ?? null, source: latest?.source ?? null,
      recordingVersion: latest?.recordingVersion ?? null, policy: clone(latest?.policy) };
    const points = latest ? rows.filter(p => matching(p, benchmark)).slice(-3) : [];
    return { ...benchmark, points, meanTimeS: mean(points), provisional: points.length < 3 };
  }));
  const trainingDaysByGrip = Object.fromEntries(selected.map(grip => [grip,
    new Set(asRows(history).filter(r => r?.grip === grip && validDate(r.date) && r.date >= windowStart && r.date <= windowEnd
      && duration(r) > 0 && !isSeedArtifactRep(r) && r.force_recording?.session_protocol?.id !== 'peak_test'
      && !(Number(r.target_duration) > 0 && Number(r.target_duration) <= 5)).map(r => r.date)).size]));
  return freeze({ windowStart, windowEnd, windowWeeks: 6, loadTolerance: LOAD_TOLERANCE, trainingDaysByGrip, byHand });
}

export function createVolumeExperiment({ history = [], grips = [], startDate = today(), id = uuid(),
  createdAt = new Date().toISOString() } = {}) {
  const selected = [...new Set(grips)].filter(grip => GRIPS.includes(grip));
  if (!validDate(startDate) || !validTimestamp(createdAt) || !selected.length || typeof id !== 'string' || !id.trim())
    throw new Error('Choose a grip and a valid experiment start date.');
  return freeze({ id, version: 1, startDate, endDate: shift(startDate, DAYS - 1), createdAt,
    grips: selected, weeks: 6, days: DAYS, weeklyGoal: 3, goalSessionsPerGrip: 18,
    sets: 2, restSeconds: 300, status: 'active',
    baseline: buildVolumeBaseline({ history, grips: selected, startDate }) });
}

// Additional review notes and lifecycle timestamps are permitted. Protocol
// fields and the frozen historical window cannot change through cloud merge.
export function isValidVolumeExperiment(e) {
  if (!e || e.version !== 1 || typeof e.id !== 'string' || !e.id.trim()
    || !validTimestamp(e.createdAt)
    || !validDate(e.startDate) || !validDate(e.endDate) || e.endDate !== shift(e.startDate, DAYS - 1)
    || !['active', 'paused', 'completed', 'ended'].includes(e.status)
    || !Array.isArray(e.grips) || !e.grips.length || new Set(e.grips).size !== e.grips.length
    || e.grips.some(g => !GRIPS.includes(g)) || e.weeks !== 6 || e.days !== DAYS
    || e.weeklyGoal !== 3 || e.goalSessionsPerGrip !== 18 || e.sets !== 2 || e.restSeconds !== 300) return false;
  const b = e.baseline;
  if (!b || b.windowStart !== shift(e.startDate, -DAYS) || b.windowEnd !== shift(e.startDate, -1)
    || b.loadTolerance !== LOAD_TOLERANCE || !Array.isArray(b.byHand) || b.byHand.length !== e.grips.length * 2) return false;
  const keys = new Set();
  return b.byHand.every(h => {
    const key = `${h?.grip}|${h?.hand}`;
    if (!h || !e.grips.includes(h.grip) || !HANDS.includes(h.hand) || keys.has(key)
      || !Array.isArray(h.points) || h.points.length > 3) return false;
    keys.add(key);
    if (!h.points.length) return h.loadKg === null && h.meanTimeS === null;
    return positive(h.loadKg) && h.loadKg < 200 && positive(h.meanTimeS)
      && typeof h.basis === 'string' && ['measured_force', 'known_external_load'].includes(h.source)
      && (h.recordingVersion === null || (Number.isInteger(h.recordingVersion) && h.recordingVersion >= 1))
      && h.points.every(p => p && validDate(p.date) && p.date >= b.windowStart && p.date <= b.windowEnd
        && p.grip === h.grip && p.hand === h.hand && positive(p.forceKg) && p.forceKg < 200
        && positive(p.timeS) && matching(p, h))
      && new Set(h.points.map(p => p.date)).size === h.points.length
      && Math.abs(h.meanTimeS - mean(h.points)) < 1e-9;
  });
}

export function volumeExperimentStatus(experiment, date = today()) {
  if (!experiment || !validDate(date) || !validDate(experiment.startDate) || !validDate(experiment.endDate)) return 'ended';
  if (experiment.status === 'ended') return 'ended';
  if (experiment.status === 'completed' || date > experiment.endDate) return 'completed';
  // A scheduled future experiment is inactive until its first calendar day.
  if (experiment.status === 'paused' || date < experiment.startDate) return 'paused';
  return experiment.status === 'active' ? 'active' : 'ended';
}

export function volumeSessionPlan(experiment, grip, date = today()) {
  if (!isValidVolumeExperiment(experiment) || volumeExperimentStatus(experiment, date) !== 'active'
    || !experiment.grips.includes(grip)) return null;
  return freeze({ id: 'volume_beta', version: 1, experiment_id: experiment.id,
    started_on: experiment.startDate, ends_on: experiment.endDate,
    sets: 2, rest_s: 300, goal_sessions_per_grip: 18 });
}

const tagged = (r, e) => r?.force_recording?.volume_beta?.id === 'volume_beta'
  && r.force_recording.volume_beta.version === 1 && r.force_recording.volume_beta.experiment_id === e.id;
const validProtocol = (r, e) => {
  const p = r.force_recording.volume_beta;
  return p.sets === 2 && p.rest_s === 300 && p.started_on === e.startDate && p.ends_on === e.endDate
    && p.goal_sessions_per_grip === 18 && !r.force_recording?.session_protocol;
};

function sessionProgress(rows, experiment) {
  const groups = new Map();
  rows.forEach(r => {
    const key = stable([r.hand, r.set_num]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  });
  const plans = rows.map(recordedSessionPrescription);
  const modes = new Set(plans.filter(Boolean).map(p => p.hand_mode));
  const mode = modes.size === 1 ? [...modes][0] : null;
  const hands = mode === 'Both' ? HANDS : HANDS.includes(mode) ? [mode] : [];
  const consistent = hands.length > 0 && plans.every(Boolean) && modes.size === 1
    && rows.every(r => validProtocol(r, experiment) && hands.includes(r.hand) && [1, 2].includes(r.set_num));
  let completedSets = 0;
  for (const rs of groups.values()) {
    const ps = rs.map(recordedSessionPrescription);
    const count = ps[0]?.reps_per_set;
    const slots = [...rs].sort((a, b) => a.rep_num - b.rep_num);
    if (consistent && count > 0 && slots.length === count && ps.every(p => p
      && stable(p) === stable(ps[0])) && slots.every((r, i) => r.rep_num === i + 1 && isVolumeRepComplete(r))) completedSets++;
  }
  // Plans for a hand remain the same across both sets. Do not assemble a
  // completion from different rungs or from duplicate/missing numbered slots.
  const consistentHands = hands.every(h => new Set(rows.filter(r => r.hand === h)
    .map(r => stable(recordedSessionPrescription(r)))).size === 1);
  return { completed: !!consistent && consistentHands && completedSets === hands.length * 2,
    completedSets, recordedSets: groups.size };
}

export function volumeProgress(experiment, history = [], date = today()) {
  if (!isValidVolumeExperiment(experiment) || !validDate(date)) return { status: 'ended', week: 0, byGrip: [] };
  const through = date < experiment.endDate ? date : experiment.endDate;
  // Exact duplicate IDs are sync copies; different IDs occupying the same
  // slot stay visible to completeness checks instead of filling missing slots.
  const seen = new Set();
  const rows = asRows(history).filter(r => {
    if (!tagged(r, experiment) || !validDate(r.date) || r.date < experiment.startDate || r.date > through
      || !experiment.grips.includes(r.grip) || !r.session_id || duration(r) <= 0) return false;
    if (r.id && seen.has(r.id)) return false;
    if (r.id) seen.add(r.id);
    return true;
  });
  const byGrip = experiment.grips.map(grip => {
    const reps = rows.filter(r => r.grip === grip), groups = new Map();
    for (const r of reps) {
      const key = stable([r.date, r.session_id]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const completedDates = new Set(), dates = [...new Set(reps.map(r => r.date))].sort();
    let completedSets = 0, recordedSets = 0, workSeconds = 0, impulseKgS = 0, estimatedWork = false;
    for (const rs of groups.values()) {
      const progress = sessionProgress(rs, experiment);
      if (progress.completed) completedDates.add(rs[0].date);
      completedSets += progress.completedSets; recordedSets += progress.recordedSets;
    }
    // Conflicting duplicate slots cannot double the apparent training dose.
    const slots = new Map();
    for (const r of reps) {
      const key = stable([r.date, r.session_id, r.hand, r.set_num, r.rep_num]);
      if (!slots.has(key) || duration(r) > duration(slots.get(key))) slots.set(key, r);
    }
    for (const r of slots.values()) {
      const f = r.force_recording, observed = f?.activity?.impulse_kg_s ?? f?.impulse_kg_s;
      workSeconds += duration(r);
      if (Number.isFinite(observed) && observed >= 0) impulseKgS += observed;
      else {
        const force = sane(f?.activity?.avg_force_kg) ?? sane(r.avg_force_kg)
          ?? (r.load_provenance === 'known_external_load' ? sane(r.manual_load_kg) : null);
        if (force != null) impulseKgS += force * duration(r);
        estimatedWork = true;
      }
      if (f?.activity?.signal_quality === 'incomplete' || f?.signal_quality === 'incomplete'
        || f?.duration_basis === 'elapsed_activity_estimate' || f?.release_uncertain) estimatedWork = true;
    }
    return { grip, started: dates.length, completed: completedDates.size, twoSetSessions: completedDates.size,
      goal: 18, completedSets, recordedSets, holdCount: slots.size, workSeconds, impulseKgS, estimatedWork, dates };
  });
  return { status: volumeExperimentStatus(experiment, date),
    week: Math.max(0, Math.min(6, Math.floor((Date.parse(date) - Date.parse(experiment.startDate)) / DAY_MS / 7) + 1)), byGrip };
}

export function volumeComparison(experiment, history = [], date = today()) {
  if (!isValidVolumeExperiment(experiment) || !validDate(date)) return { byHand: [] };
  const through = date < experiment.endDate ? date : experiment.endDate;
  // Establish the first-session boundary on ALL work, then require the
  // experiment tag. A later beta session can never replace an earlier opener.
  const points = openingPoints(history, experiment.startDate, through);
  const taggedIds = new Set(asRows(history).filter(r => tagged(r, experiment)).map(r => r.id));
  return { byHand: experiment.baseline.byHand.map(baseline => {
    const matches = baseline.loadKg > 0 ? points.filter(p => p.grip === baseline.grip && p.hand === baseline.hand
      && p.id != null && taggedIds.has(p.id) && matching(p, baseline)).slice(-3) : [];
    const meanTimeS = mean(matches);
    return { grip: baseline.grip, hand: baseline.hand, baseline, points: matches, meanTimeS,
      changeSeconds: meanTimeS != null ? meanTimeS - baseline.meanTimeS : null,
      changePercent: meanTimeS != null ? (meanTimeS / baseline.meanTimeS - 1) * 100 : null,
      provisional: baseline.provisional || matches.length < 3,
      status: baseline.loadKg == null ? 'baseline_missing' : matches.length ? 'descriptive' : 'no_matches' };
  }) };
}

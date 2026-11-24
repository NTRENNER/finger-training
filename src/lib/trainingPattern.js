// Descriptive training exposure only. Never imported by a prescription engine.
import { sane } from '../model/load.js';
import { isSeedArtifactRep } from '../model/firstSessionEvidence.js';
import { recordedRedoAttempts } from '../model/repRedo.js';
import { POTENTIATION_PROTOCOL_ID } from '../model/potentiationRfd.js';

const DAY = 86400000;
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const addDays = (date, n) => new Date(Date.parse(date) + n * DAY).toISOString().slice(0, 10);
const sessionStart = row => typeof row.session_started_at === 'string' && row.session_started_at.includes('T')
  && Number.isFinite(Date.parse(row.session_started_at)) ? new Date(row.session_started_at).toISOString() : null;
const protocolOf = row => {
  const f = row.force_recording;
  if (f?.session_protocol?.id === 'whole_curve_beta') return 'Chaos Machine';
  if (f?.volume_beta) return 'Volume Beta';
  if (f?.decision?.pilot) return 'Emphasis pilot';
  if (f?.session_protocol?.id) return f.session_protocol.id;
  return f?.workout_plan || f?.decision ? 'Standard' : 'Unspecified';
};

function workOf(row) {
  const out = { attempts: 0, workSeconds: 0, measuredKgS: 0, estimatedKgS: 0, unknownLoadSeconds: 0, uncertain: false };
  const attempts = recordedRedoAttempts(row);
  for (const [i, attempt] of attempts.entries()) {
    const f = attempt.forceRecording || {}, a = f.activity;
    const seconds = positive(a?.duration_s) || positive(attempt.actualTime);
    if (!seconds) continue;
    out.attempts++; out.workSeconds += seconds;
    const impulse = a?.impulse_kg_s ?? f.impulse_kg_s;
    const measured = sane(a?.avg_force_kg) ?? sane(attempt.avgForce);
    // Prior manual attempts may lack saved load: keep that exposure unknown.
    const manual = i === attempts.length - 1 && !['nominal_setting', 'prescription_only'].includes(row.load_provenance)
      ? sane(row.manual_load_kg) : null;
    if (Number.isFinite(impulse) && impulse >= 0) out.measuredKgS += impulse;
    else if (measured != null) out.measuredKgS += measured * seconds;
    else if (manual != null) out.estimatedKgS += manual * seconds;
    else out.unknownLoadSeconds += seconds;
    if (f.signal_quality === 'incomplete' || a?.signal_quality === 'incomplete'
      || f.duration_basis === 'elapsed_activity_estimate' || f.release_uncertain
      || a?.endpoint_quality === 'release_not_observed') out.uncertain = true;
  }
  return out;
}

const summarize = records => {
  const blocks = new Set(), sets = new Set(), days = new Set();
  const totals = { trainingDays: 0, blocks: 0, sets: 0, reps: records.length, unidentifiedReps: 0,
    attempts: 0, workSeconds: 0, measuredKgS: 0, estimatedKgS: 0, unknownLoadSeconds: 0, uncertain: false };
  for (const r of records) {
    days.add(r.date);
    if (r.identified) {
      blocks.add(r.blockKey);
      if (['L', 'R'].includes(r.hand) && Number.isInteger(r.set) && r.set > 0) sets.add(JSON.stringify([r.blockKey, r.hand, r.set]));
    } else totals.unidentifiedReps++;
    for (const key of ['attempts', 'workSeconds', 'measuredKgS', 'estimatedKgS', 'unknownLoadSeconds']) totals[key] += r.work[key];
    totals.uncertain ||= r.work.uncertain;
  }
  return { ...totals, trainingDays: days.size, blocks: blocks.size, sets: sets.size };
};

export function buildTrainingPattern(history = [], activities = [], { start, end } = {}) {
  if (!validDate(start) || !validDate(end) || start > end) return null;
  const rows = (history || []).filter(row => row && validDate(row.date) && row.date >= start && row.date <= end
    && !isSeedArtifactRep(row) && !['peak_test', POTENTIATION_PROTOCOL_ID].includes(row.force_recording?.session_protocol?.id));
  const identitiesByStart = new Map();
  for (const row of rows) {
    const timestamp = sessionStart(row);
    if (!row.session_id || !timestamp) continue;
    const key = JSON.stringify([row.grip || 'Unknown grip', timestamp]);
    if (!identitiesByStart.has(key)) identitiesByStart.set(key, new Set());
    identitiesByStart.get(key).add(row.session_id);
  }
  const records = [], seen = new Set();
  for (const row of rows) {
    if (row.id && seen.has(row.id)) continue;
    if (row.id) seen.add(row.id);
    const work = workOf(row);
    if (!work.workSeconds) continue;
    const grip = row.grip || 'Unknown grip';
    const timestamp = sessionStart(row), linked = identitiesByStart.get(JSON.stringify([grip, timestamp]));
    // A missing ID can join an unambiguous saved start, never a guessed date
    // bucket. Conflicting starts stay unidentified instead of adding a block.
    const identity = row.session_id ? ['id', row.session_id] : linked?.size === 1 ? ['id', [...linked][0]]
      : timestamp && !linked?.size ? ['start', timestamp] : null;
    records.push({ date: row.date, grip, hand: row.hand, set: Number(row.set_num ?? 1),
      blockKey: JSON.stringify([grip, identity || ['unknown', row.date]]), identified: !!identity, protocol: protocolOf(row), work });
  }
  const climbs = (activities || []).filter(a => a?.type === 'climbing' && validDate(a.date) && a.date >= start && a.date <= end);
  const climbingDates = new Set(climbs.map(a => a.date));
  const fingerDates = [...new Set(records.map(r => r.date))].sort();
  const days = [];
  for (let date = start; date <= end; date = addDays(date, 1)) {
    const rows = records.filter(r => r.date === date), groups = new Map();
    for (const row of rows) {
      if (!groups.has(row.blockKey)) groups.set(row.blockKey, []);
      groups.get(row.blockKey).push(row);
    }
    days.push({ date, ...summarize(rows), climbingEntries: climbs.filter(a => a.date === date).length,
      blocks: [...groups.entries()].map(([key, rs]) => ({ key, grip: rs[0].grip, identified: rs[0].identified,
        protocols: [...new Set(rs.map(r => r.protocol))].sort(), ...summarize(rs) })) });
  }
  const by = field => [...new Set(records.map(r => r[field]))].sort().map(value => ({ [field]: value,
    ...summarize(records.filter(r => r[field] === value)) }));
  return { start, end, days, totals: summarize(records), byGrip: by('grip'), byProtocol: by('protocol'),
    spacingDays: fingerDates.slice(1).map((date, i) => (Date.parse(date) - Date.parse(fingerDates[i])) / DAY),
    climbingDays: climbingDates.size, sharedClimbingDays: fingerDates.filter(date => climbingDates.has(date)).length };
}

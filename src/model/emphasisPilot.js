// Emphasis-block pilot (docs/emphasis-block-protocol.md). For an enrolled
// athlete, the plan card recommends each grip's next step in its block cycle
// instead of the recommender's pick. The recommender still runs and its pick
// is logged beside the pilot step, so the pilot never changes the production
// model (the protocol's model freeze).
import { isPotentiationMeasurement } from './potentiationRfd.js';
import { prescription } from './prescription.js';
import { zoneOf } from './zones.js';

// v2 (2026-11-06): fixed target times per domain on every grip.
export const EMPHASIS_PILOT_VERSION = 2;

// One target time per domain, the same on every grip (Nathan, 2026-11-06),
// so each emphasis trains the same points of the curve. A grip whose ladder
// sits at another time restarts at this one from the curve's load. The
// short-end block's max-strength steps are 20 s holds (Nathan, 2026-11-06),
// the same session as its power steps.
export const PILOT_TARGET_S = {
  max_strength: 20,
  power: 20,
  power_strength: 70,
  strength: 115,
  strength_endurance: 160,
  endurance: 220,
};

// Each session on a grip takes the next step, repeating the cycle as needed.
// The primary grip runs the 8-step cycle; the others run its first 4 steps.
export const EMPHASIS_CYCLES = {
  long: {
    primary: ['strength', 'strength_endurance', 'endurance', 'power',
      'strength', 'strength_endurance', 'endurance', 'power_strength'],
    other: ['strength', 'strength_endurance', 'endurance', 'power'],
  },
  short: {
    primary: ['max_strength', 'power', 'power_strength', 'strength',
      'max_strength', 'power', 'power_strength', 'endurance'],
    other: ['max_strength', 'power', 'power_strength', 'strength'],
  },
};

export const EMPHASIS_LABEL = { long: 'Long end', short: 'Short end', rotation: 'Rotation' };
export const EMPHASIS_BLOCK_NAME = { long: 'long-end block', short: 'short-end block', rotation: 'rotation block' };

// Pre-registered calendars. Block order was drawn at random (see the
// protocol's Calendar section); dates are inclusive local days.
export const EMPHASIS_PILOTS = {
  'emphasis-2026-11': {
    id: 'emphasis-2026-11',
    primaryGrip: 'Micro',
    grips: ['Micro', 'Crusher', 'Prime'],
    blocks: [
      { label: 'B', emphasis: 'long', start: '2026-11-02', end: '2026-11-29' },
      { label: 'A', emphasis: 'short', start: '2026-11-30', end: '2026-12-27' },
      // The app's regular rotation under the same conditions, the
      // comparison for focused against rotational training.
      { label: 'R', emphasis: 'rotation', start: '2026-12-28', end: '2027-01-24' },
    ],
  },
};

const ymd = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
const dayIndex = date => Date.parse(`${date}T00:00:00Z`) / 864e5;

// The enrollment stored in user_settings.emphasis_pilot.
export function validPilotEnrollment(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.version !== 1 || !EMPHASIS_PILOTS[raw.pilot_id]) return null;
  if (!['active', 'left'].includes(raw.status)) return null;
  if (typeof raw.updated_at !== 'string' || !Number.isFinite(Date.parse(raw.updated_at))) return null;
  return { version: 1, pilot_id: raw.pilot_id, status: raw.status, updated_at: raw.updated_at };
}

export function pilotEnrollment(pilotId, status, now = new Date()) {
  return { version: 1, pilot_id: pilotId, status, updated_at: now.toISOString() };
}

export function activePilot(enrollment) {
  const valid = validPilotEnrollment(enrollment);
  return valid?.status === 'active' ? EMPHASIS_PILOTS[valid.pilot_id] : null;
}

export function pilotBlockOn(pilot, date) {
  if (!pilot || !ymd(date)) return null;
  const index = pilot.blocks.findIndex(b => b.start <= date && date <= b.end);
  if (index < 0) return null;
  const block = pilot.blocks[index];
  return {
    ...block, index,
    day: dayIndex(date) - dayIndex(block.start) + 1,
    days: dayIndex(block.end) - dayIndex(block.start) + 1,
  };
}

// Days in the block before `date` with finger training on this grip. Peak
// Tests and warm-up pulls are measurements, not sessions.
export function pilotSessionDates(history, grip, block, date) {
  const dates = new Set();
  for (const r of history || []) {
    if (r?.grip !== grip || !ymd(r.date) || r.date < block.start || r.date >= date) continue;
    if (r.force_recording?.session_protocol?.id === 'peak_test' || isPotentiationMeasurement(r)) continue;
    dates.add(r.date);
  }
  return [...dates].sort();
}

// Today's step for one grip, or null when the athlete is not enrolled, the
// grip is outside the pilot, or the date is outside every emphasis block (a
// rotation block runs the regular recommendations). Counting only earlier
// days keeps the step fixed for the whole day.
export function pilotStep(enrollment, history, grip, date) {
  const pilot = activePilot(enrollment);
  if (!pilot || !pilot.grips.includes(grip)) return null;
  const block = pilotBlockOn(pilot, date);
  if (!block || !EMPHASIS_CYCLES[block.emphasis]) return null;
  const primary = grip === pilot.primaryGrip;
  const cycle = EMPHASIS_CYCLES[block.emphasis][primary ? 'primary' : 'other'];
  const sessionsBefore = pilotSessionDates(history, grip, block, date).length;
  const position = sessionsBefore % cycle.length;
  return {
    pilotId: pilot.id, version: EMPHASIS_PILOT_VERSION,
    block: block.label, emphasis: block.emphasis, blockDay: block.day, blockDays: block.days,
    primary, sessionsBefore, step: position + 1, cycleLength: cycle.length, zone: cycle[position],
  };
}

// What the plan card shows for a pilot step: a session at the step's fixed
// target time, in the domain that time belongs to (a 20 s max-strength step
// runs as the 20 s power session), loaded from the curve. The density ladder
// sets load and reps only when its pinned time is that target (see
// pilotUsesLadder).
// Grips the recommender still treats as new keep its cold-start plan.
export function pilotRecommendation(step, engineRec, { history, grip, freshMap = null, threeExpPriors = null }) {
  if (!step || !engineRec || engineRec.coldStart || engineRec.coldStartStage || engineRec.boundaryProbe) return engineRec;
  const T = PILOT_TARGET_S[step.zone];
  const loadByHand = {};
  for (const hand of ['L', 'R']) {
    const value = prescription(history, hand, grip, T, { freshMap, threeExpPriors })?.value;
    if (value > 0) loadByHand[hand] = value;
  }
  const values = Object.values(loadByHand);
  return {
    zone: zoneOf(T), T, hand: engineRec.hand, pilot: step, source: engineRec.source,
    loadByHand, loadKg: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
  };
}

export function pilotLabel(step) {
  return step ? `Pilot · ${EMPHASIS_LABEL[step.emphasis]} · day ${step.blockDay} of ${step.blockDays}` : null;
}

// A domain's ladder carries over only at the pilot's target time; at any
// other time the session restarts at the target and the ladder re-pins there.
export function pilotUsesLadder(rec, ladder) {
  return !rec?.pilot || !ladder || ladder.T === rec.T;
}

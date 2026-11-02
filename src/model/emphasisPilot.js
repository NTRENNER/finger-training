// Emphasis-block pilot (docs/emphasis-block-protocol.md). For an enrolled
// athlete, the plan card recommends each grip's next step in its block cycle
// instead of the recommender's pick. The recommender still runs and its pick
// is logged beside the pilot step, so the pilot never changes the production
// model (the protocol's model freeze).
import { isPotentiationMeasurement } from './potentiationRfd.js';
import { prescription } from './prescription.js';
import { ZONE_REF_T } from './zones.js';

export const EMPHASIS_PILOT_VERSION = 1;

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

export const EMPHASIS_LABEL = { long: 'Long end', short: 'Short end' };
export const EMPHASIS_BLOCK_NAME = { long: 'long-end block', short: 'short-end block' };

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
// grip is outside the pilot, or the date is outside every block. Counting
// only earlier days keeps the step fixed for the whole day.
export function pilotStep(enrollment, history, grip, date) {
  const pilot = activePilot(enrollment);
  if (!pilot || !pilot.grips.includes(grip)) return null;
  const block = pilotBlockOn(pilot, date);
  if (!block) return null;
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

// What the plan card shows for a pilot step: the step's domain at its
// reference duration, loaded from the curve like a tile. As on any tile, the
// density ladder pins duration, load and reps for domains trained before.
// Grips the recommender still treats as new keep its cold-start plan.
export function pilotRecommendation(step, engineRec, { history, grip, freshMap = null, threeExpPriors = null }) {
  if (!step || !engineRec || engineRec.coldStart || engineRec.coldStartStage || engineRec.boundaryProbe) return engineRec;
  const T = ZONE_REF_T[step.zone];
  const loadByHand = {};
  for (const hand of ['L', 'R']) {
    const value = prescription(history, hand, grip, T, { freshMap, threeExpPriors })?.value;
    if (value > 0) loadByHand[hand] = value;
  }
  const values = Object.values(loadByHand);
  return {
    zone: step.zone, T, hand: engineRec.hand, pilot: step, source: engineRec.source,
    loadByHand, loadKg: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
  };
}

export function pilotLabel(step) {
  return step ? `Pilot · ${EMPHASIS_LABEL[step.emphasis]} · day ${step.blockDay} of ${step.blockDays}` : null;
}

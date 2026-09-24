import { adaptiveEvidence, buildAdaptiveCapacity, adaptiveFloorReplay, applyAdaptiveBounds,
  decreasingLogProjection, adaptiveDuration } from '../adaptiveCapacityExperiment.js';
import { evaluateAdaptiveCapacity } from '../adaptiveCapacityEvaluation.js';
import { predForceThreeExp } from '../threeExp.js';
import { loadBounds } from '../prescription.js';

const amps = [20, 25, 30], durations = [30, 70, 115, 160, 220];
const date = n => new Date(Date.UTC(2026, 0, 1 + n * 3)).toISOString().slice(0, 10);
const rep = (n, factor = 1, duration = durations[n % 5]) => {
  const force = predForceThreeExp(amps, duration) * factor;
  return { id: `rep-${n}`, session_id: `session-${n}`, date: date(n), hand: 'L', grip: 'Crusher',
    rep_num: 1, set_num: 1, target_duration: duration, actual_time_s: duration, avg_force_kg: force,
    peak_force_kg: force * 1.1, prescribed_load_kg: force, load_provenance: 'measured_force',
    failure_valid: true, end_reason: 'target_force_failure',
    force_recording: { capacity_eligible: true, signal_quality: 'complete' } };
};
const base = () => Array.from({ length: 30 }, (_, i) => rep(i));
const decline = n => [...base(), ...Array.from({ length: n }, (_, i) => rep(30 + i, 0.65))];

test('one anomalous day does not confirm a shift, no matter how many same-day reps are added', () => {
  const weak = rep(30, 0.65, 220);
  const model = buildAdaptiveCapacity([...base(), weak,
    ...Array.from({ length: 12 }, (_, i) => ({ ...weak, id: `copy-${i}`, session_id: `copy-${i}` }))], 'L', 'Crusher', date(31));
  expect(model.evidenceAt(220).influence).toBe(0);
  expect(model.forceAt(30)).toBeCloseTo(predForceThreeExp(model.established, 30), 6);
});

test('three agreeing days start an adjustment; five strengthen it; a contrary day interrupts it', () => {
  const rows = [0, 1, 2, 3, 4].map(i => rep(i, 0.65, 160));
  const three = adaptiveEvidence(rows.slice(0, 3), amps, 160, date(5));
  const five = adaptiveEvidence(rows, amps, 160, date(5));
  expect(three.influence).toBeCloseTo(1 / 3);
  expect(five.influence).toBeCloseTo(1);
  expect(adaptiveEvidence([...rows, rep(5, 1.1, 160)], amps, 160, date(6)).influence).toBe(0);
  expect(adaptiveEvidence(rows, amps, 160, date(30)).influence).toBeCloseTo(1);
});

test('endurance-only evidence cannot shift power; evidence broadens only with duration coverage', () => {
  const rows = Array.from({ length: 6 }, (_, i) => rep(i, 0.65, 220));
  expect(adaptiveEvidence(rows, amps, 30, date(6)).influence).toBe(0);
  expect(adaptiveEvidence(rows, amps, 220, date(6)).influence).toBeCloseTo(1);
  expect(adaptiveEvidence(Array.from({ length: 6 }, (_, i) => rep(i, 0.65)), amps, 160, date(6)).scope).toBe('broad');
});

test('sustained decline reaches the final bounded load without changing the established curve', () => {
  const history = decline(6), ref = date(36), t = 160;
  const model = buildAdaptiveCapacity(history, 'L', 'Crusher', ref);
  const bounds = loadBounds(history, 'L', 'Crusher', t, { referenceDate: ref });
  const revision = adaptiveFloorReplay(history, 'L', 'Crusher', t, ref, bounds.floorKg);
  const truth = predForceThreeExp(amps, t) * 0.65;
  expect(Math.abs(model.forceAt(t) / truth - 1)).toBeLessThan(0.15);
  expect(predForceThreeExp(model.established, t) / truth - 1).toBeGreaterThan(0.3);
  const value = applyAdaptiveBounds(model.forceAt(t), bounds, revision.floor);
  expect(Math.abs(value / truth - 1)).toBeLessThan(0.15);
  expect(revision.events.length).toBeGreaterThan(0);
  for (const event of revision.events) expect(event.to).toBeGreaterThanOrEqual(event.from * 0.75 - 1e-8);
});

test('repeated reads are idempotent, new days permit more reduction, and earned reductions persist', () => {
  const run = (rows, ref) => {
    const bounds = loadBounds(rows, 'L', 'Crusher', 160, { referenceDate: ref });
    return adaptiveFloorReplay(rows, 'L', 'Crusher', 160, ref, bounds.floorKg);
  };
  const first = run(decline(4), date(34));
  expect(run(decline(4), date(34))).toEqual(first);
  expect(run(decline(6), date(36)).floor).toBeLessThan(first.floor);
  // Later calendar time may age the old floor downward, but must not restore it.
  expect(run(decline(6), date(55)).floor).toBeLessThanOrEqual(run(decline(6), date(36)).floor + 1e-8);
  const now = buildAdaptiveCapacity(decline(6), 'L', 'Crusher', date(36));
  const later = buildAdaptiveCapacity(decline(6), 'L', 'Crusher', date(55));
  expect(later.forces).toEqual(now.forces);
  expect(later.evidenceAgeDays).toBeGreaterThan(now.evidenceAgeDays);
});

test('legacy, interrupted and manual data cannot authorize the new floor override', () => {
  for (const shape of ['legacy', 'interrupted', 'manual']) {
    const rows = decline(6).map(r => Number(r.id.split('-')[1]) < 30 ? r : shape === 'legacy'
      ? { ...r, failure_valid: null, end_reason: null, load_provenance: null, force_recording: null }
      : shape === 'interrupted' ? { ...r, failure_valid: false, end_reason: 'equipment_interruption' }
        : { ...r, avg_force_kg: null, load_provenance: 'nominal_setting', manual_load_kg: r.avg_force_kg });
    const bounds = loadBounds(rows, 'L', 'Crusher', 160, { referenceDate: date(36) });
    const revision = adaptiveFloorReplay(rows, 'L', 'Crusher', 160, date(36), bounds.floorKg);
    expect(revision.floor).toBe(bounds.floorKg);
    expect(revision.events).toEqual([]);
  }
});

test('different hand, grip, setup, and optional sets cannot supply confirmation', () => {
  for (const other of [{ hand: 'R' }, { grip: 'Micro' }, { setup_id: 'different' }, { set_num: 2 }]) {
    const rows = [...base(), rep(30, 0.65), ...[31, 32].map(i => ({ ...rep(i, 0.65), ...other }))];
    const model = buildAdaptiveCapacity(rows, 'L', 'Crusher', date(33));
    expect(model?.evidenceAt(160).influence || 0).toBe(0);
  }
});

test('gains are accepted, including sustained overshooting; output stays monotonic and invertible', () => {
  const rows = [...base(), ...Array.from({ length: 6 }, (_, i) => ({ ...rep(30 + i, 1.15),
    prescribed_load_kg: predForceThreeExp(amps, durations[i % 5]) }))];
  const model = buildAdaptiveCapacity(rows, 'L', 'Crusher', date(36));
  expect(model.evidenceAt(160).direction).toBe(1);
  expect(model.forceAt(160)).toBeGreaterThan(predForceThreeExp(model.established, 160));
  expect(model.forces.every((f, i) => f > 0 && (!i || f <= model.forces[i - 1] + 1e-8))).toBe(true);
  expect(adaptiveDuration(model, model.forceAt(160)).seconds).toBeCloseTo(160, 6);
  decreasingLogProjection([30, 20, 25, 10]).forEach((v, i) =>
    expect(v).toBeCloseTo([30, Math.sqrt(500), Math.sqrt(500), 10][i]));
});

test('future and same-day records cannot enter curves, adjustment or historical floor checkpoints', () => {
  const rows = decline(4), ref = date(34);
  const expanded = [...rows, rep(34, 2), rep(40, 3)];
  const a = buildAdaptiveCapacity(rows, 'L', 'Crusher', ref);
  const b = buildAdaptiveCapacity(expanded, 'L', 'Crusher', ref);
  expect(a.forces).toEqual(b.forces);
  expect(adaptiveFloorReplay(rows, 'L', 'Crusher', 160, ref, 21))
    .toEqual(adaptiveFloorReplay(expanded, 'L', 'Crusher', 160, ref, 21));
  const short = Array.from({ length: 7 }, (_, i) => rep(i));
  const before = evaluateAdaptiveCapacity(short);
  const after = evaluateAdaptiveCapacity([...short, rep(7, 2), rep(20, 3)]);
  expect(before.observations).toEqual(after.observations.filter(r => r.date <= date(6)));
});

test('missing acquisition data is excluded and peak/endurance ceilings remain in effect', () => {
  const invalid = [30, 31, 32].map(i => ({ ...rep(i, 0.65),
    force_recording: { ...rep(i).force_recording, basis: 'target_acquired', acquisition_s: null } }));
  const model = buildAdaptiveCapacity([...base(), ...invalid], 'L', 'Crusher', date(33));
  expect(model.openers).toHaveLength(30);
  expect(model.evidenceAt(160).influence).toBe(0);
  expect(applyAdaptiveBounds(40, { floorKg: 30, peakCapKg: 25, endCeilKg: 20 }, 15)).toBe(20);
  expect(evaluateAdaptiveCapacity([]).standard.curves.matchedObservations).toBe(0);
});

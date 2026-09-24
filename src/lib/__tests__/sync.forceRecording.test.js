import { peakMeasurementRecord, isValidPeakMeasurement } from '../../model/peakTest.js';
import { startingHandForDay } from '../../model/handOrder.js';
const mockOrder = jest.fn();
jest.mock('../supabase.js', () => ({supabase: {from: () => ({select: () => ({order: (...args) => mockOrder(...args)})})}}));
import { repPayload, fetchReps } from '../sync.js';
import { freshFitReps } from '../../model/load.js';
import { recoveryEvidence } from '../../model/recoveryEvidence.js';

test('beta protocol survives cloud serialization without making tired holds fresh capacity', async () => {
  const rows = [1, 2].map(n => ({ id: `beta-${n}`, date: '2026-09-23', grip: 'Micro', hand: 'L',
    session_id: 'beta', rep_num: n, set_num: 1, avg_force_kg: 20, peak_force_kg: 22,
    actual_time_s: 30, failure_valid: true, load_provenance: 'measured_force',
    force_recording: { version: 2, capacity_eligible: n === 1,
      mixed_load_prediction: { version: 1, mode: 'shadow', prediction: { status: 'estimated', seconds: 35 },
        model: { amps: [10, 20, 30], recovery_taus: [15, 90, 600] } },
      session_protocol: { id: 'whole_curve_beta', version: 1, role: n === 1 ? 'opening_hold' : 'fatigued_hold' } } }));
  mockOrder.mockResolvedValue({ data: rows.map(r => repPayload(r, 'user')), error: null });
  const restored = await fetchReps();
  expect(restored.map(r => r.force_recording)).toEqual(rows.map(r => r.force_recording));
  expect(freshFitReps(restored)).toHaveLength(1);
  expect(recoveryEvidence(restored).eligible).toBe(false);
});

test('cloud round-trip retains interrupted activity and excludes it from fitting', async () => {
  const rep = {id: 'rep', date: '2026-09-10', grip: 'Micro', hand: 'L', rep_num: 1, set_num: 1,
    actual_time_s: 12, avg_force_kg: 17.5, failure_valid: false, end_reason: 'interrupted',
    force_recording: {version: 2, method: 'time_weighted', duration_s: 12, capacity_eligible: false},
    load_provenance: 'measured_force',
    rep_timing: {version: 1, started_at_ms: 100000, ended_at_ms: 112000, rest_before_s: 35}};
  const payload = repPayload(rep, 'user');
  mockOrder.mockResolvedValue({data: [payload], error: null});
  const [restored] = await fetchReps();
  expect(restored).toMatchObject(rep);
  expect(freshFitReps([restored])).toEqual([]);
});
test('cloud round-trip leaves historical validity unspecified', async () => {
  mockOrder.mockResolvedValue({data: [{actual_time_s: 30, avg_force_kg: 20}], error: null});
  const [restored] = await fetchReps();
  expect(restored.failure_valid).toBeNull();
  expect(restored.force_recording).toBeNull();
});


test("cloud round-trip preserves an untouched session's adjustment separately from its rating", async () => {
 const session_adjustment={version:1,reported_cooked:null,applied_multiplier:1};
 const payload=repPayload({session_cooked:null,session_adjustment},"user");
 mockOrder.mockResolvedValue({data:[payload],error:null});
 expect((await fetchReps())[0]).toMatchObject({session_cooked:null,session_adjustment});
});


test("interrupted rep round-trip preserves the battery reading and warning timestamps", async () => {
  const battery = { status: "available", voltage_mv: 2750, voltage_read_at_ms: 100000,
    low_battery_warning: true, low_battery_warning_at_ms: 112000 };
  const rep = { id: "battery-interruption", failure_valid: false, end_reason: "equipment_interruption",
    force_recording: { version: 3, capacity_eligible: false, battery } };
  const payload = repPayload(rep, "user");
  mockOrder.mockResolvedValue({ data: [payload], error: null });
  expect((await fetchReps())[0]).toMatchObject(rep);
});

test('Peak Test cloud round-trip preserves sustained duration separately from peak', async () => {
  const rep = { id: 'peak-test', grip: 'Micro', hand: 'L', rep_num: 1, set_num: 1,
    actual_time_s: 7.2, target_duration: 5, avg_force_kg: 20, peak_force_kg: 28,
    failure_valid: true, load_provenance: 'measured_force',
    force_recording: { version: 3, basis: 'target_acquired', capacity_eligible: true,
      session_protocol: { id: 'peak_test', version: 1, position: 1, duration_reference: 'load_selection_until_failure' } } };
  mockOrder.mockResolvedValue({ data: [repPayload(rep, 'user')], error: null });
  const [restored] = await fetchReps();
  expect(restored).toMatchObject(rep);
  expect(freshFitReps([restored])[0]).toMatchObject({ actual_time_s: 7.2, avg_force_kg: 20 });
});


test('peak-only measurements and the daily hand order survive cloud round-trip', async () => {
  const rep = peakMeasurementRecord({ stats: { actualTime:3,avgForce:20,peakForce:28,failureValid:true },
    hand:'R',round:0,grip:'Micro',sessionId:'peak-session',date:'2026-09-24',
    firstHand:'R',source:'warmup',startedAt:'2026-09-24T12:00:00Z' });
  mockOrder.mockResolvedValue({data:[repPayload(rep,'user')],error:null});
  const restored=await fetchReps();
  expect(isValidPeakMeasurement(restored[0])).toBe(true);
  expect(freshFitReps(restored)).toEqual([]);
  expect(recoveryEvidence(restored).eligible).toBe(false);
  expect(startingHandForDay(restored,'2026-09-24')).toBe('R');
  expect(startingHandForDay(restored,'2026-09-25')).toBe('L');
});

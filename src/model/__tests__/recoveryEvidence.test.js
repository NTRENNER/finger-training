import { measuredRecoveryFields } from '../../testHelpers/recovery.js';
import { recoveryEvidence } from '../recoveryEvidence.js';
import { computePersonalRecoveryTausForGrip } from '../recoveryFit.js';
import { buildRecoveryBundle, buildRecoveryTrend } from '../recoveryDynamics.js';
import { predictRepTimes, PHYS_MODEL_DEFAULT } from '../fatigue.js';
import { buildPeakForceTrend } from '../peakForce.js';
const set = (loads = [30,30,30,30], rests = [20,20,20]) => loads.map((load,i) => ({
  ...measuredRecoveryFields(i ? rests[i-1] : null),
  id:`r${i}`, session_id:'s', date:'2026-09-10', grip:'Crusher', hand:'L', set_num:1,
  rep_num:i+1, actual_time_s:[40,24,16,12][i], avg_force_kg:load, peak_force_kg:load+1, rest_s:20,
}));
test('constant actual force qualifies; escalating force at identical durations does not', () => {
  expect(computePersonalRecoveryTausForGrip(set(),'Crusher')).not.toBeNull();
  expect(computePersonalRecoveryTausForGrip(set([30,45,50,55]),'Crusher')).toBeNull();
  expect(recoveryEvidence(set([30,45,50,55])).reason).toBe('force_changed');
});
test('slight force variation stays comparable', () => {
  expect(recoveryEvidence(set([30,31,29.5,30.5])).status).toBe('comparable');
});
test('measured rest order matters and is not replaced by its average', () => {
  const model = { numReps:4, firstRepTime:40, physModel:PHYS_MODEL_DEFAULT };
  const a = predictRepTimes({...model,restIntervals:[5,20,60]});
  const b = predictRepTimes({...model,restIntervals:[60,20,5]});
  expect(a).not.toEqual(b);
  const bundle = buildRecoveryBundle({reps:set(undefined,[5,20,60]),restSeconds:999,physModel:PHYS_MODEL_DEFAULT});
  expect(bundle.predicted[1].predictedFraction).toBeCloseTo(a[1]/a[0],6);
});
test('unknown actual rest is descriptive only, even with planned rest present', () => {
  const rows=set().map(({rep_timing,...r})=>r);
  expect(recoveryEvidence(rows).reason).toBe('unmeasured_rest');
  expect(computePersonalRecoveryTausForGrip(rows,'Crusher')).toBeNull();
  expect(buildRecoveryTrend(rows,'Crusher')).toEqual([]);
});
test('interruption at rep four retains the first three, including their recovery fit', () => {
  const rows=set(); rows[3].failure_valid=false;
  expect(recoveryEvidence(rows)).toMatchObject({status:'partial',eligible:true});
  expect(recoveryEvidence(rows).reps).toHaveLength(3);
  expect(computePersonalRecoveryTausForGrip(rows,'Crusher').nSets).toBe(1);
  expect(buildRecoveryTrend(rows,'Crusher')).toHaveLength(1);
});
test('interrupted opener, missing rep two, changed setup, or duplicate rep two cannot become a sequence', () => {
  const interrupted=set(); interrupted[0].failure_valid=false;
  const changed=set(); changed[1].setup_id='different edge';
  const rows=set();
  for (const data of [interrupted, [rows[0],rows[2],rows[3]], changed, [rows[0],rows[1],rows[1],rows[2]]]) {
    expect(recoveryEvidence(data).eligible).toBe(false);
  }
});
test('zero rest is measured; null and negative rest are not', () => {
  expect(recoveryEvidence(set(undefined,[0,0,0])).status).toBe('comparable');
  expect(recoveryEvidence(set(undefined,[null,20,20])).eligible).toBe(false);
  expect(recoveryEvidence(set(undefined,[-1,20,20])).eligible).toBe(false);
});
test('interrupted peaks do not set personal records', () => {
  expect(buildPeakForceTrend(set().map(r=>({...r,failure_valid:false})))).toBeNull();
});

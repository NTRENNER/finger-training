import { RECOVERY_ROW_SHAPES, recoveryRows } from '../../testHelpers/recoveryRows.js';
import { recoveryEvidence } from '../recoveryEvidence.js';
import { computePersonalRecoveryTausForGrip } from '../recoveryFit.js';
import { buildRecoveryTrend } from '../recoveryDynamics.js';
import { PHYS_MODEL_DEFAULT } from '../fatigue.js';
import { isCapacityEvidenceRep } from '../forceRecording.js';

// Compatibility contract: usable legacy measurements must not disappear
// solely because their provenance/timing columns were added later. These
// assertions intentionally expose the pending legacy-recovery regression;
// do not change them to expect exclusion merely to make the suite green.
const eligibleShapes = new Set(['measured', 'legacy', 'legacy_nullable']);

describe.each(RECOVERY_ROW_SHAPES)('%s storage-shaped recovery evidence', shape => {
  const rows = () => recoveryRows(shape);
  test('failure-capacity eligibility respects source and interruptions', () => {
    expect(isCapacityEvidenceRep(rows()[0])).toBe(eligibleShapes.has(shape));
  });
  test('comparable sequences preserve usable history without admitting nominal or interrupted openers', () => {
    expect(recoveryEvidence(rows()).eligible).toBe(eligibleShapes.has(shape));
  });
  test('personal recovery remains available for eligible sequences', () => {
    expect(computePersonalRecoveryTausForGrip(rows(), 'Crusher') !== null).toBe(eligibleShapes.has(shape));
  });
  test('historical recovery dates remain available for eligible sequences', () => {
    expect(buildRecoveryTrend(rows(), 'Crusher')).toHaveLength(eligibleShapes.has(shape) ? 1 : 0);
  });
});

test('legacy fixture keeps new columns absent, while synced legacy keeps them null', () => {
  for (const key of ['load_provenance', 'force_recording', 'rep_timing', 'failure_valid']) {
    expect(recoveryRows('legacy')[0]).not.toHaveProperty(key);
    expect(recoveryRows('legacy_nullable')[0][key]).toBeNull();
  }
});
test('manual fixture never gains sensor provenance or force-quality metadata', () => {
  expect(recoveryRows('manual')[0]).toMatchObject({load_provenance:'nominal_setting',
    avg_force_kg:null, peak_force_kg:null, force_recording:null, manual_load_kg:30});
});
test('a late interruption preserves the valid opening prefix', () => {
  const rows = recoveryRows('interrupted', {interruptedRep:4});
  expect(recoveryEvidence(rows)).toMatchObject({eligible:true,status:'partial'});
  expect(recoveryEvidence(rows).reps).toHaveLength(3);
  expect(computePersonalRecoveryTausForGrip(rows, 'Crusher')).not.toBeNull();
});


test('legacy fitting has less influence and never relabels source rows', () => {
  const legacy = recoveryRows('legacy');
  const snapshot = JSON.stringify(legacy);
  expect(recoveryEvidence(legacy)).toMatchObject({confidence:'historical_estimate',weight:0.5,rests:[20,20,20]});
  const oldFit = computePersonalRecoveryTausForGrip(legacy, 'Crusher');
  const measuredFit = computePersonalRecoveryTausForGrip(recoveryRows('measured'), 'Crusher');
  expect(oldFit).toMatchObject({nSets:1,effectiveSets:0.5,estimatedSets:1});
  expect(measuredFit).toMatchObject({nSets:1,effectiveSets:1,estimatedSets:0});
  expect(Math.abs(oldFit.fast - PHYS_MODEL_DEFAULT.tauR.fast))
    .toBeLessThan(Math.abs(measuredFit.fast - PHYS_MODEL_DEFAULT.tauR.fast));
  expect(JSON.stringify(legacy)).toBe(snapshot);
  expect(buildRecoveryTrend(legacy,'Crusher')[0].confidence).toBe('historical_estimate');
});
test('fallback cannot rescue modern missing metadata, invalid signals, interruptions, or missing rest', () => {
  const cases = [
    recoveryRows('legacy', {date:'2026-09-11'}),
    recoveryRows('legacy').map(r => ({...r,failure_valid:false})),
    recoveryRows('legacy').map(r => ({...r,force_recording:{capacity_eligible:false}})),
    recoveryRows('legacy').map(r => ({...r,rest_s:null})),
    recoveryRows('legacy').map(r => ({...r,rest_s:-1})),
    recoveryRows('measured').map(r => ({...r,rep_timing:null})),
  ];
  for (const rows of cases) expect(recoveryEvidence(rows).eligible).toBe(false);
});
test('missing planned rest differs from explicit zero in legacy rows', () => {
  expect(recoveryEvidence(recoveryRows('legacy').map(r=>({...r,rest_s:0})))).toMatchObject({eligible:true,rests:[0,0,0]});
  expect(recoveryEvidence(recoveryRows('legacy').map(({rest_s,...r})=>r)).eligible).toBe(false);
});

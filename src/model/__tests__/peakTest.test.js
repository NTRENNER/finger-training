import { peakMeasurementRecord, isValidPeakMeasurement } from '../peakTest.js';
import { freshFitReps } from '../load.js';
import { isCapacityEvidenceRep, evidenceLabel } from '../forceRecording.js';
import { maxTestStaleness, buildPeakForceTrend } from '../peakForce.js';
import { recoveryEvidence } from '../recoveryEvidence.js';
import { bestAvailablePeakMeasurement } from '../prescription.js';
import { coldStartLongProbeLoad, coachingRecommendationContinuous } from '../coaching.js';

export const measuredPeak = (extra = {}) => peakMeasurementRecord({
  stats: { actualTime: 3, avgForce: 28, peakForce: 40, failureValid: true,
    startedAtMs: 10000, endedAtMs: 13000, ...extra }, hand: 'R', round: 0, grip: 'Micro',
  sessionId: 'session', date: '2026-09-24', startedAt: '2026-09-24T12:00:00Z', firstHand: 'R', source: 'warmup',
});

test('brief maximal pulls update peaks and their reminder but never failure capacity or recovery', () => {
  const r = measuredPeak();
  expect(isValidPeakMeasurement(r)).toBe(true);
  expect(r.failure_valid).toBe(false);
  expect(evidenceLabel(r)).toBe('Peak measurement — not a failure hold');
  expect(isCapacityEvidenceRep(r)).toBe(false);
  expect(freshFitReps([r])).toEqual([]);
  expect(recoveryEvidence([r]).eligible).toBe(false);
  expect(maxTestStaleness([r], '2026-09-24').staleDays).toBe(0);
  expect(buildPeakForceTrend([r]).best.Micro.kg).toBe(40);
  expect(bestAvailablePeakMeasurement([r], 'R', 'Micro').kg).toBe(40);
  const probe = coldStartLongProbeLoad([r], 'R');
  expect(probe.value).toBe(8);
  expect(probe.anchor).toBeNull(); // no fabricated (3s, peak) capacity point
});

test.each([{ endReason: 'equipment_interruption' }, { failureValid: false }, { actualTime: 0.4 }, { peakForce: 0 }])('invalid peak cannot reset reminder or set a ceiling: %j', extra => {
  const r = measuredPeak(extra);
  expect(isValidPeakMeasurement(r)).toBe(false);
  expect(buildPeakForceTrend([r])).toBeNull();
  expect(maxTestStaleness([r], '2026-09-24').lastDate).toBeNull();
  expect(bestAvailablePeakMeasurement([r], 'R', 'Micro')).toBeNull();
});


test('a recorded peak on both hands advances sparse-history calibration without entering the capacity fit', () => {
  const baseline = ['L','R'].flatMap(hand => [1,2,3].map(n => ({ id:`${hand}-${n}`,session_id:`old-${n}`,
    date:`2026-09-${10+n}`,grip:'Micro',hand,rep_num:1,set_num:1,target_duration:30,actual_time_s:30+n,avg_force_kg:20 })));
  const before=coachingRecommendationContinuous(baseline,'Micro',{today:'2026-09-24'});
  expect(before.coldStartStage).toBe('upper');
  const right=measuredPeak();
  const after=coachingRecommendationContinuous([...baseline,right,{...right,id:'left-peak',hand:'L'}],'Micro',{today:'2026-09-24'});
  expect(after.coldStartStage).toBe('lower');
  expect(after.peakTest).not.toBe(true);
  expect(freshFitReps([...baseline,right])).toEqual(freshFitReps(baseline));
});


test('a lower-probe miss reduces a peak-based starting estimate', () => {
  const r=measuredPeak();
  const attempt={id:'miss',session_id:'later',hand:'R',grip:'Micro',date:'2026-09-25',
    rep_num:1,set_num:1,target_duration:220,actual_time_s:30,avg_force_kg:8,failure_valid:true};
  expect(coldStartLongProbeLoad([r,attempt],'R').value).toBeLessThan(8);
});

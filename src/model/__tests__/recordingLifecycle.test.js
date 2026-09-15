import { renderHook } from '@testing-library/react';
import { useGripFits } from '../../hooks/useGripFits.js';
import { recordCapacityForce, recordForce, finalizeDeviceActivity, comparableCapacityHistory } from '../forceRecording.js';
import { buildFreshLoadMap, prescription, repKey } from '../prescription.js';
import { buildThreeExpPriors } from '../threeExp.js';
import { freshFitReps } from '../load.js';
import { recoveryRows, RECOVERY_ROW_SHAPES } from '../../testHelpers/recoveryRows.js';
import { recoveryEvidence } from '../recoveryEvidence.js';
import { coachingRecommendationContinuous } from '../coaching.js';

const trace = (plateauSeconds, plateau=30) => Array.from({length:80+plateauSeconds*100+1},(_,i)=>({
 ts:i*10, at:100000+i*10, kg:i<80 ? 4+(plateau-4)*i/80 : plateau,
}));
test.each([7,12,20,90,160])('ramp is excluded from both capacity force and %s-second duration', seconds => {
 const r=recordCapacityForce(trace(seconds),undefined,30);
 expect(r).toMatchObject({actualTime:seconds,avgForce:30,failureValid:true,startedAtMs:100800});
 expect(r.forceRecording).toMatchObject({version:3,basis:'target_acquired',acquisition_s:0.8,
  activity:{duration_s:seconds+0.8,signal_quality:'complete'}});
 expect(r.forceRecording.activity.impulse_kg_s).toBeGreaterThan(30*seconds);
});
test('sustained overshoot and subsequent variation are retained after acquisition',()=>{
 const samples=[{ts:0,kg:4},{ts:500,kg:35},{ts:1000,kg:35},{ts:1500,kg:30},{ts:2000,kg:30}];
 const r=recordCapacityForce(samples,2000,25);
 expect(r.actualTime).toBe(1.5); expect(r.avgForce).toBeCloseTo(100/3);
});
test('an incomplete acquisition interval cannot become valid capacity by trimming it',()=>{
 const r=recordCapacityForce([{ts:0,kg:4},{ts:2000,kg:30},{ts:2500,kg:30}],2500,25);
 expect(r.failureValid).toBe(false); expect(r.forceRecording.capacity_eligible).toBe(false);
});
test('empty BLE record preserves elapsed activity but no measured failure claim',()=>{
 const r=finalizeDeviceActivity(recordForce([]),1000,46000);
 expect(r).toMatchObject({actualTime:45,startedAtMs:1000,endedAtMs:46000,failureValid:false,
  endReason:'equipment_interruption',forceRecording:{observed_time_s:0,duration_basis:'elapsed_activity_estimate'}});
 expect(r.avgForce).toBeNull();
});
test('partial sensor duration stays measured rather than extending across a dropout',()=>{
 const r=finalizeDeviceActivity(recordCapacityForce(trace(7),undefined,30),100000,145000,true);
 expect(r.actualTime).toBe(7); expect(r.failureValid).toBe(false);
});

describe.each(RECOVERY_ROW_SHAPES)('%s prescription path',shape=>{
 test('uses eligible anchors while preserving recovery classification',()=>{
  const rows=recoveryRows(shape).map(r=>({...r,actual_time_s:160,target_duration:160,manual_load_kg:shape==='manual'?12:r.manual_load_kg,
   avg_force_kg:shape==='manual'?null:12,peak_force_kg:shape==='manual'?null:13}));
  const p=prescription(rows,'L','Crusher',160,{referenceDate:'2026-08-21'});
  if(shape==='interrupted') expect(p).toBeNull();
  else expect(p.value).toBe(12);
  if(shape==='manual') {
   expect(p).toMatchObject({source:'manual-load-estimate',evidenceWeight:0.5});
   expect(recoveryEvidence(rows).eligible).toBe(false);
   const rec=coachingRecommendationContinuous(rows,'Crusher',{today:'2026-08-21'});
   expect(rec).toMatchObject({loadKg:12,source:'manual-load-estimate',T:160});
  }
 });
});
const sequence=()=>recoveryRows('measured');
test('an interrupted but completely recorded pull still contributes to fatigue',()=>{
 const rows=sequence(); rows[1].failure_valid=false; rows[1].end_reason='interrupted';
 const map=buildFreshLoadMap(rows);
 expect(map.has(repKey(rows[1]))).toBe(false);
 expect(map.get(repKey(rows[2]))).toMatchObject({capacityEligible:true});
 expect(map.get(repKey(rows[2])).availFrac).toBeLessThan(1);
});
test('unknown work invalidates later fresh fitting, but not a new session',()=>{
 const rows=sequence(); rows[1].failure_valid=false; rows[1].end_reason='equipment_interruption';
 const next={...rows[0],id:'next',session_id:'next'};
 const map=buildFreshLoadMap([...rows,next]);
 expect(map.get(repKey(rows[2])).capacityEligible).toBe(false);
 expect(map.get(repKey(next))).toMatchObject({capacityEligible:true,availFrac:1});
 const opts={referenceDate:'2026-08-21',threeExpPriors:buildThreeExpPriors(rows)};
 expect(prescription(rows,'L','Crusher',30,opts)).toEqual(prescription(rows.slice(0,2),'L','Crusher',30,opts));
});
test('absent and explicitly null rest use the same estimated fallback',()=>{
 const absent=sequence().map(({rep_timing,...r})=>r);
 const explicit=absent.map(r=>({...r,rep_timing:{rest_before_s:null}}));
 const a=buildFreshLoadMap(absent),b=buildFreshLoadMap(explicit);
 expect([...a.values()]).toEqual([...b.values()]);
 expect(a.get(repKey(absent[2]))).toMatchObject({capacityEligible:true,confidence:'estimated_rest'});
 expect(a.get(repKey(absent[2])).availFrac).toBeLessThan(1);
});
// The requirement is that the two recording bases are never COMPARED as if
// they described the same interval. Reconciling them satisfies that. Dropping
// one generation also satisfied it, but cost a grip its whole baseline, curve
// and capacity floor on the strength of a single session — see
// basisNormalization.test.js for the regression that motivated the change.
test('earlier and new capacity intervals are reconciled into one series, not segregated',()=>{
 const old=sequence()[0];
 const recent={...old,id:'new',session_id:'new',date:'2026-09-15',actual_time_s:old.actual_time_s-1.4,
  force_recording:{basis:'target_acquired',capacity_eligible:true,acquisition_s:1.4,duration_s:old.actual_time_s-1.4}};
 const out=comparableCapacityHistory([old,recent]);
 expect(out.map(r=>r.id)).toEqual([old.id,'new']);
 expect(out[1].actual_time_s).toBeCloseTo(old.actual_time_s,5);          // back on the earlier interval
 expect(out[1].force_recording.duration_s).toBe(old.actual_time_s-1.4);  // native record kept
 expect(out[0]).toBe(old);                                               // earlier rows untouched
 expect(freshFitReps([old,recent]).map(r=>r.id)).toContain(old.id);
});

test('a new-basis rep that cannot be placed on the earlier interval is the only thing dropped',()=>{
 const old=sequence()[0];
 const noOffset={...old,id:'new',session_id:'new',date:'2026-09-15',
  force_recording:{basis:'target_acquired',capacity_eligible:true}};
 expect(comparableCapacityHistory([old,noOffset]).map(r=>r.id)).toEqual([old.id]);
});

test('pinned baselines survive the measurement-basis change; old dots remain available',()=>{
 const old=sequence()[0];
 const recent={...old,id:'new',session_id:'new',date:'2026-09-15',actual_time_s:old.actual_time_s-1.4,
  force_recording:{basis:'target_acquired',capacity_eligible:true,acquisition_s:1.4}};
 const history=[old,recent]; const pin={date:old.date,amps:[10,10,10],maxHoldS:40};
 const {result}=renderHook(()=>useGripFits({history,grips:['Crusher'],threeExpPriors:buildThreeExpPriors(history),
  pinnedGripBaselines:{Crusher:pin},pinnedPerHandBaselines:{'Crusher|L':pin}}));
 expect(result.current.gripBaselines.Crusher).toBeTruthy();
 expect(result.current.gripBaselines.Crusher.date).toBe(pin.date);
 // Every recorded pull is still present; preserveAllBases now governs whether
 // an unconvertible row is kept, not whether the shared interval is applied.
 expect(freshFitReps(history,{preserveAllBases:true}).map(r=>r.id)).toEqual(history.map(r=>r.id));
});

// Protocol tests assume enrollment eligibility; access is covered separately.
jest.mock('../../model/betaEligibility.js', () => ({ betaEligibility: () => ({ eligible: true }) }));
import { act, renderHook } from '@testing-library/react';
import { useSessionRunner } from '../useSessionRunner.js';
import { makeMixedDomainPlan, MIXED_DOMAIN_ZONES } from '../../model/mixedDomain.js';
import { predForceThreeExp } from '../../model/threeExp.js';
import { ZONE_REF_T } from '../../model/zones.js';
import { summarizeMixedPredictions } from '../../model/mixedLoadPrediction.js';
jest.mock('../../lib/sync.js', () => ({ pushDailyState: jest.fn() }));
const fresh = () => ['L','R'].flatMap(hand => [10,30,70,115,160,220].map((t,i)=>({
  id:`old-${hand}-${i}`,session_id:`old-${i}`,date:`2026-09-${10+i}`,grip:'Micro',hand,rep_num:1,set_num:1,
  actual_time_s:t,avg_force_kg:predForceThreeExp([18,15,25],t),load_provenance:'measured_force',failure_valid:true,
  force_recording:{version:3,basis:'target_acquired',capacity_eligible:true,signal_quality:'complete'},
})));
const plan = (adaptive) => makeMixedDomainPlan(MIXED_DOMAIN_ZONES.map(key=>({key,
  L:predForceThreeExp([18,15,25],ZONE_REF_T[key]),R:predForceThreeExp([18,15,25],ZONE_REF_T[key]),
})), 'endurance', ['L','R'], adaptive);
const finish = (hook, time, start, extra={}) => {
  const kg=hook.result.current.refWeights[hook.result.current.activeHand];
  act(()=>hook.result.current.handleRepDone({actualTime:time,avgForce:kg,peakForce:kg,
    startedAtMs:start,endedAtMs:start+time*1000,failureValid:true,endReason:'target_force_failure',
    forceRecording:{version:3,basis:'target_acquired',capacity_eligible:true,signal_quality:'complete',
      duration_s:time,impulse_kg_s:kg*time,acquisition_s:0},...extra}));
};
beforeEach(()=>jest.useFakeTimers().setSystemTime(new Date('2026-09-26T12:00:00Z')));
afterEach(()=>jest.useRealTimers());
test('default Chaos Machine loads adapt and freeze between holds, persist predictions, isolate hands and never enter the regular ladder',()=>{
 const history=fresh(),addReps=jest.fn();
 const hook=renderHook(()=>useSessionRunner({history,addReps,tindeqConnected:true}));
 act(()=>hook.result.current.startSession({grip:'Micro',hand:'Both',mixedDomainPlan:plan()}));
 const firstHand=hook.result.current.activeHand;
 const opening=hook.result.current.refWeights[firstHand];
 finish(hook,220,1000000);
 const next=hook.result.current.refWeights[firstHand];
 expect(next).toBeLessThan(plan().steps.find(s=>s.zone==='power').loadByHand[firstHand]);
 expect(hook.result.current.nextWeight).toBe(next);
 expect(hook.result.current.activeRepConfig.mixedLoadAdjustment.status).toBe('adjusted');
 history.push({...history[0],id:'new',session_id:'new',avg_force_kg:150});
 hook.rerender();
 act(()=>{jest.advanceTimersByTime(60000);hook.result.current.handleRestDone();});
 expect(hook.result.current.refWeights[firstHand]).toBe(next);
 for(let i=1;i<5;i++){
   finish(hook,hook.result.current.activeRepConfig.targetTime,1300000+i*300000);
   if(i<4)act(()=>hook.result.current.handleRestDone());
 }
 expect(hook.result.current.phase).toBe('switch_hands');
 expect(hook.result.current.refWeights[hook.result.current.activeHand]).toBe(opening);
 expect(hook.result.current.activeRepConfig.mixedLoadAdjustment.status).toBe('opening_hold');
 const saved=addReps.mock.calls.flatMap(c=>c[0]);
 expect(saved[1].prescribed_load_kg).toBe(next);
 expect(saved[1].force_recording.session_protocol).toMatchObject({load_mode:'adaptive_targets',duration_reference:'approximate_hold_target'});
 expect(saved[1].force_recording.mixed_load_prediction).toMatchObject({load_kg:next,mode:'adaptive_targets',prior_rep_ids:[saved[0].id]});
 expect(saved.slice(1).every(r=>r.force_recording.capacity_eligible===false)).toBe(true);
 expect(summarizeMixedPredictions(saved).excluded.edited_since_prediction).toBeUndefined();
});
test('interruption disables subsequent adaptive loads with an explicit fallback',()=>{
 const hook=renderHook(()=>useSessionRunner({history:fresh(),addReps:jest.fn(),tindeqConnected:true}));
 act(()=>hook.result.current.startSession({grip:'Micro',hand:'L',mixedDomainPlan:plan()}));
 finish(hook,5.8,1000000,{failureValid:false,endReason:'equipment_interruption'});
 expect(hook.result.current.activeRepConfig.mixedLoadAdjustment).toMatchObject({status:'unavailable',reason:'unmeasured_or_interrupted_prefix'});
 expect(hook.result.current.refWeights.L).toBe(Math.round(plan().steps.find(s=>s.zone==='power').loadByHand.L*10)/10);
});
test('readiness applies once and does not affect the legacy fixed-reference beta',()=>{
 for(const adaptive of [false,true]){
 const hook=renderHook(()=>useSessionRunner({history:fresh(),addReps:jest.fn(),tindeqConnected:true}));
 act(()=>hook.result.current.startSession({grip:'Micro',hand:'L',cooked:5,adjustLoadForFatigue:true,mixedDomainPlan:plan(adaptive)}));
 finish(hook,220,1000000);
 const saved=hook.result.current.sessionReps[0], multiplier=saved.session_adjustment.applied_multiplier;
 expect(saved.prescribed_load_kg).toBe(Math.round(plan().steps[0].loadByHand.L*multiplier*10)/10);
 if(adaptive) expect(saved.force_recording.mixed_load_prediction.model.readiness_multiplier).toBe(multiplier);
 else expect(hook.result.current.refWeights.L).toBeCloseTo(plan().steps.find(s=>s.zone==='power').loadByHand.L*multiplier);
 hook.unmount();
 }
});

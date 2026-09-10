import {effectiveSessionCount} from '../sessionConfidence.js';
import {calendarRecencyDays,buildContinuousRecency,COACH_RECOVERY_TAU_DAYS,coachingRecommendationContinuous} from '../coaching.js';
import {ZONE_REF_T} from '../zones.js';
const today='2026-09-10';
const rep=(sid,extra={})=>({session_id:sid,date:today,hand:'L',grip:'Micro',rep_num:1,actual_time_s:30,avg_force_kg:20,peak_force_kg:22,load_provenance:'measured_force',failure_valid:true,...extra});
test('six reps in one session count once; six sessions count six times',()=>{
 expect(effectiveSessionCount(Array.from({length:6},(_,i)=>rep('one',{rep_num:i+1})),30,today)).toBe(1);
 expect(effectiveSessionCount(Array.from({length:6},(_,i)=>rep(`s${i}`)),30,today)).toBe(6);
});
test('old, distant, uncertain and interrupted evidence does not inflate confidence',()=>{
 expect(effectiveSessionCount([rep('a',{date:'2026-06-12'})],30,today)).toBeCloseTo(.5);
 expect(effectiveSessionCount([rep('a',{actual_time_s:200})],30,today)).toBeLessThan(.01);
 expect(effectiveSessionCount([rep('a',{load_provenance:null})],30,today)).toBe(.75);
 expect(effectiveSessionCount([rep('a',{failure_valid:false}),rep('b',{date:'2026-09-11'})],30,today)).toBe(0);
 expect(effectiveSessionCount([rep(null),rep(null)],30,today)).toBe(1);
});
test('all zone boundaries have continuous recency and cost assumptions',()=>{
 for(const T of [12,50,90,140,180]) {
  const left=calendarRecencyDays(T-.001),right=calendarRecencyDays(T+.001);
  expect(Math.abs(left-right)).toBeLessThan(.001);
  const fn=buildContinuousRecency([rep('one',{date:'2026-09-09',actual_time_s:T-1})],'Micro',{today});
  expect(Math.abs(fn(T-.001)-fn(T+.001))).toBeLessThan(.001);
 }
 for(const [zone,T] of Object.entries(ZONE_REF_T)) expect(calendarRecencyDays(T)).toBeCloseTo(COACH_RECOVERY_TAU_DAYS[zone]);
 expect(calendarRecencyDays(1)).toBe(1); expect(calendarRecencyDays(500)).toBe(3.5);
});
test('engine confidence reports sessions while usable repeated reps remain accepted',()=>{
 const h=[rep('one'),rep('one',{rep_num:2,actual_time_s:20})];
 const r=coachingRecommendationContinuous(h,'Micro',{today,tMin:30,tMax:30});
 expect(r).toBeTruthy();expect(r.confidenceBasis).toBe('independent_sessions');
 expect(r.effN).toBeLessThanOrEqual(1);
});

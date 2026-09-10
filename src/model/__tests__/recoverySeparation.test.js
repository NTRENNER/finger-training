import { coachingRecommendationContinuous, buildContinuousRecency } from '../coaching.js';
import { predictRepTimes, PHYS_MODEL_DEFAULT } from '../fatigue.js';
import { sessionPerformanceContext } from '../sessionPerformanceContext.js';
const history = [5,15,30,60,120,200].flatMap((t,i)=>[1,4,8].map(d=>({
 id:`${t}-${d}`,session_id:`${t}-${d}`,date:`2026-09-${String(10-d).padStart(2,'0')}`,
 grip:'Micro',hand:'L',rep_num:1,actual_time_s:t,target_duration:t,
 avg_force_kg:30*Math.exp(-t/30)+10*Math.exp(-t/180),peak_force_kg:40,
 failure_valid:true,load_provenance:'measured_force',force_recording:{version:2,capacity_eligible:true}
})));
test('short-rest recovery speed cannot stretch calendar recency or alter the recommendation',()=>{
 const opts={today:'2026-09-10',tMin:30,tMax:30};
 const base=coachingRecommendationContinuous(history,'Micro',opts);
 expect(base).toBeTruthy();
 for(const medium of [45,90,360,900]) {
  expect(coachingRecommendationContinuous(history,'Micro',{...opts,personalTaus:{medium}})).toEqual(base);
  expect(coachingRecommendationContinuous(history,'Micro',{...opts,personalTaus:new Map([['Micro',{medium}]])})).toEqual(base);
 }
 expect(buildContinuousRecency(history,'Micro',{today:opts.today,tauScale:2})(30))
  .toBe(buildContinuousRecency(history,'Micro',{today:opts.today})(30));
});
test('within-set predictions still respond to between-rep recovery speed',()=>{
 const forecast=medium=>predictRepTimes({numReps:4,firstRepTime:30,restSeconds:20,
  physModel:{...PHYS_MODEL_DEFAULT,tauR:{...PHYS_MODEL_DEFAULT.tauR,medium}}});
 expect(forecast(45)[1]).toBeGreaterThan(forecast(360)[1]);
});
test('stable openings and lower later reps remain separate statements',()=>{
 const text=sessionPerformanceContext({force:{state:'unchanged'},duration:{state:'insufficient'},repeat:{state:'lower'}});
 expect(text).toMatch(/holding steady/); expect(text).toMatch(/Later-rep performance is lower/);
 expect(text).toMatch(/does not establish readiness today/);
});
test('lower, mixed and absent opening evidence do not claim recovery',()=>{
 expect(sessionPerformanceContext({force:{state:'lower'}})).toMatch(/opening performance is lower/);
 expect(sessionPerformanceContext({force:{state:'lower'},duration:{state:'improving'}})).toMatch(/mixed/);
 expect(sessionPerformanceContext({})).toMatch(/not enough comparable opening/);
});

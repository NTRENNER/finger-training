import { peakMeasurementRecord } from '../peakTest.js';
import { freshFitReps } from '../load.js';
import { buildThreeExpPriors } from '../threeExp.js';
import { buildGripBaselines } from '../baselines.js';
import { prescription, demonstratedCapacityKg } from '../prescription.js';
import { computeDensityLadder } from '../densityLadder.js';
import { getLastZoneTrainedDates, getRollingSessionPace } from '../lockout.js';
import { fingerSessionsThisWeek } from '../deload.js';
import { gatherSignals, gatherCheckInSignals } from '../weeklyReview.js';
import { generateWarmupProtocol } from '../warmup.js';
import { coachingRecommendationContinuous } from '../coaching.js';

const day = '2026-09-24';
const history = [[30,40],[70,30],[115,25],[160,20],[220,15]].flatMap(([t,f],i)=>[1,2,3,4].map(n=>({
  id:`r${i}-${n}`,session_id:`s${i}`,date:`2026-09-${17+i}`,grip:'Crusher',hand:'L',set_num:1,rep_num:n,
  target_duration:t,actual_time_s:t/(n===1?1:2),avg_force_kg:f,peak_force_kg:45,rest_s:20,
})));
const peak = peakMeasurementRecord({stats:{actualTime:3,avgForce:50,peakForce:60,failureValid:true},
  hand:'L',round:0,grip:'Crusher',sessionId:'peak-only-day',date:day,startedAt:`${day}T12:00:00Z`,firstHand:'L',source:'warmup'});
const surfaces = {
  'capacity fit': h=>freshFitReps(h),
  'priors': h=>buildThreeExpPriors(h),
  'baseline': h=>buildGripBaselines(h,buildThreeExpPriors(h)),
  'unbounded curve': h=>prescription(h,'L','Crusher',70,{referenceDate:day})?.potential,
  'capacity floor': h=>demonstratedCapacityKg(h,'L','Crusher',70,day),
  'earned ladder': h=>computeDensityLadder(h,'Crusher','power'),
  'domain exposure': h=>getLastZoneTrainedDates(h),
  'session pace': h=>getRollingSessionPace(h,new Date(2026,8,24,12)),
  'hard training days': h=>fingerSessionsThisWeek(h,day),
  'weekly training': h=>gatherSignals(h,[],[],{refDate:day}).finger,
  'weekly volume': h=>gatherCheckInSignals(h,[],[],{refDate:day}).volume,
  'warmup': h=>generateWarmupProtocol({history:h,wLog:[],bodyWeightKg:70}),
};
beforeEach(()=>jest.useFakeTimers().setSystemTime(new Date(2026,8,24,12)));
afterEach(()=>jest.useRealTimers());
test.each(Object.entries(surfaces))('peak-only observations do not change %s',(_,read)=>{
  expect(read([...history,peak])).toEqual(read(history));
});
test('warmup accepts explicit manual anchors without admitting interrupted, optional or mixed-domain holds',()=>{
  const manual=history.filter(r=>r.rep_num===1).map(r=>({...r,avg_force_kg:null,peak_force_kg:null,
    manual_load_kg:r.avg_force_kg,load_provenance:'nominal_setting'}));
  const build=h=>generateWarmupProtocol({history:h,wLog:[],bodyWeightKg:70});
  expect(build(manual)).toMatchObject({ok:true,estimatedGrips:['Crusher']});
  for (const patch of [{failure_valid:false},{set_num:2},{force_recording:{session_protocol:{id:'mixed_domain'}}}]) {
    expect(build(manual.map(r=>({...r,...patch}))).ok).toBe(false);
  }
  expect(build([...history,...manual])).toEqual(build(history));
});
test('null reference date uses today instead of deleting all eligible history',()=>{
  expect(coachingRecommendationContinuous(history,'Crusher',{today:null}))
    .toEqual(coachingRecommendationContinuous(history,'Crusher',{today:day}));
});

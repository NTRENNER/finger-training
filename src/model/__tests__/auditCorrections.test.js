import { buildFreshLoadMap, repKey } from "../prescription.js";
import { recentGapHeldOut, gripPressure, gripIsDown } from "../deload.js";
import { sessionFatigueDetail } from "../climbingFatigue.js";
import { buildRecoveryTrend } from "../recoveryDynamics.js";
import { PHYS_MODEL_DEFAULT } from "../fatigue.js";
import { measuredRecoveryFields } from "../../testHelpers/recovery.js";

const rep = (id, cooked, adjustment) => ({id, session_id:id, date:"2026-09-16", grip:"Micro", hand:"L", set_num:1, rep_num:1, actual_time_s:30, avg_force_kg:25, target_duration:30, session_cooked:cooked, session_adjustment:adjustment});
const snapshot = (rating, multiplier) => ({version:1, reported_cooked:rating, applied_multiplier:multiplier});

test("untouched evening session does not inherit a morning rating", () => {
  const history=[rep("morning",10,snapshot(10,0.75)),rep("evening",null,snapshot(null,1))];
  const map=buildFreshLoadMap(history,{cookedByDate:{"2026-09-16":10}});
  expect(map.get(repKey(history[0])).fresh).toBeCloseTo(25/0.75);
  expect(map.get(repKey(history[1])).fresh).toBe(25);
});
test("a later rating edit cannot rewrite the adjustment used at session start", () => {
  const r=rep("edited",10,snapshot(null,1));
  expect(buildFreshLoadMap([r]).get(repKey(r)).fresh).toBe(25);
});
test("ambiguous legacy day ratings do not invent session compensation", () => {
  const r=rep("legacy",null);
  const value=buildFreshLoadMap([r],{cookedByDate:{"2026-09-16":10}}).get(repKey(r));
  expect(value.fresh).toBe(25);
  expect(value.adjustmentBasis).toBe("unknown_legacy_adjustment");
});
test("fallback gauge and gate agree at the exact boundary", () => {
  const gap={mean:-0.15,z:null};
  expect(gripPressure(gap)).toBe(1);
  expect(gripIsDown(gap)).toBe(true);
});
test("session rating keeps counts including climbs without per-climb effort", () => {
  const activities=[{type:"climbing",date:"2026-09-16",session_rpe:8,attempts:3},{type:"climbing",date:"2026-09-16",attempts:2}];
  expect(sessionFatigueDetail(activities,"2026-09-16")).toMatchObject({score:8,nClimbs:2,nAttempts:5});
});
const recoveryHistory=(count=30)=>Array.from({length:count},(_,i)=>[1,2].map(j=>({
  ...measuredRecoveryFields(120),id:`r${i}-${j}`,session_id:`s${i}`,date:new Date(Date.UTC(2026,7,1+i)).toISOString().slice(0,10),grip:"Micro",hand:"L",set_num:1,rep_num:j,actual_time_s:j===1?30:10+(i%5)*6,avg_force_kg:30,target_duration:30,rest_s:120,
}))).flat();
test("baseline counts overlapping means separately from independent training dates", () => {
 const h=recoveryHistory(); const g=recentGapHeldOut(h,"Micro",h.at(-1).date,2);
 expect(g.baseline.windowSize).toBe(2);
 expect(g.baseline.n).toBe(g.baseline.sessionCount-1);
 expect(g.baseline.independentDates).toBe(g.baseline.sessionCount);
 expect(g.z).toBeCloseTo((g.mean-g.baseline.mean)/g.baseline.sd,9);
});


test("small dips on a constant baseline are ignored, sustained large dips are detected", () => {
  const flat = recoveryHistory().map(r=>({...r,actual_time_s:r.rep_num===1?30:28}));
  const asOf=flat.at(-1).date;
  const withDip = time => flat.map((r,i)=>({...r, actual_time_s:i>=flat.length-4 && r.rep_num===2 ? time:r.actual_time_s}));
  const normal=recentGapHeldOut(flat,"Micro",asOf,2);
  expect(normal.baseline).not.toBeNull();
  expect(gripIsDown(normal)).toBe(false);
  expect(gripIsDown(recentGapHeldOut(withDip(27.9),"Micro",asOf,2))).toBe(false);
  expect(gripIsDown(recentGapHeldOut(withDip(15),"Micro",asOf,2))).toBe(true);
});
test("same-day duplicates cannot cross the fit boundary or inflate independent evidence", () => {
  const h=recoveryHistory();
  const duplicate=h.filter(r=>r.date===h[28].date).map(r=>({...r,id:r.id+'dup',session_id:r.session_id+'dup'}));
  const original=recentGapHeldOut(h,"Micro",h.at(-1).date,2);
  const g=recentGapHeldOut([...h,...duplicate],"Micro",h.at(-1).date,2);
  expect(g.baseline.splitDate).toBe(original.baseline.splitDate);
  expect(g.baseline.independentDates).toBe(original.baseline.independentDates);
  expect(g.baseline.sessionCount).toBe(original.baseline.sessionCount+1);
});
test("no future leakage; repeated calls and moving the reference date alone keep calibration", () => {
  const h=recoveryHistory(); const asOf=h.at(-1).date;
  const g=recentGapHeldOut(h,"Micro",asOf,2);
  const future=recoveryHistory(35);
  expect(recentGapHeldOut(future,"Micro",asOf,2)).toEqual(g);
  expect(recentGapHeldOut(h,"Micro",asOf,2)).toEqual(g);
  expect(recentGapHeldOut(h,"Micro","2026-08-31",2)).toEqual(g);
});
test("the first eligible baseline has no jump and later independent dates gradually personalize", () => {
  const at = count => { const h=recoveryHistory(count); return recentGapHeldOut(h,"Micro",h.at(-1).date,2); };
  expect(at(13).baseline).toBeNull();
  expect(at(14).baseline.weight).toBe(0);
  expect(at(14).threshold).toBe(-0.15);
  expect(at(15).baseline.weight).toBeCloseTo(1/6);
  expect(at(15).assessment).toBe("provisional");
  expect(at(30).assessment).toBe("personalized");
});
test("zero, corrupt and future-version snapshots never inherit the day rating", () => {
 for (const adj of [snapshot(0,1), snapshot(null,0), snapshot(null,NaN), {version:9,applied_multiplier:0.75}]) {
  const r=rep("r",null,adj);
  expect(buildFreshLoadMap([r],{cookedByDate:{"2026-09-16":10}}).get(repKey(r)).fresh).toBe(25);
 }
});


test("baseline numerically uses matched window averages rather than single-session spread", () => {
 const h=recoveryHistory();const g=recentGapHeldOut(h,"Micro",h.at(-1).date,2);
 const scored=buildRecoveryTrend(h,"Micro",{physModel:PHYS_MODEL_DEFAULT});
 const vals=scored.filter(row=>row.date>=g.baseline.splitDate && row.date<scored.at(-2).date).map(row=>row.gapAtTarget);
 const means=vals.slice(1).map((v,i)=>(v+vals[i])/2);
 const mean=means.reduce((sum,v)=>sum+v,0)/means.length;
 const sd=Math.sqrt(means.reduce((sum,v)=>sum+(v-mean)**2,0)/(means.length-1));
 expect(g.baseline.mean).toBeCloseTo(mean,10);
 expect(g.baseline.rawSd).toBeCloseTo(sd,10);
 const singleMean=vals.reduce((sum,v)=>sum+v,0)/vals.length;
 const singleSd=Math.sqrt(vals.reduce((sum,v)=>sum+(v-singleMean)**2,0)/(vals.length-1));
 expect(g.baseline.rawSd).toBeLessThan(singleSd);
});

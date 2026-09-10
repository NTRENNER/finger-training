import {measuredProgress} from '../measuredProgress.js';
const dates=['2026-07-01','2026-07-08','2026-07-15','2026-08-20','2026-08-27','2026-09-03'];
const rep=(i,kg=20,time=30,extra={})=>({id:`r${i}`,session_id:`s${i}`,date:dates[i],grip:'Micro',hand:'L',rep_num:1,set_num:1,avg_force_kg:kg,actual_time_s:time,peak_force_kg:kg+2,failure_valid:true,force_recording:{version:2,capacity_eligible:true},load_provenance:'measured_force',...extra});
const get=h=>measuredProgress(h,'Micro','L','2026-09-10');
test('more force at similar duration measures recent medians and separate best',()=>{
 const h=dates.map((_,i)=>rep(i,i<3?20:24));
 const p=get(h).force;
 expect(p).toMatchObject({state:'improving',previous:20,recent:24,best:24,n:6});
 expect(get([...h].reverse())).toEqual(get(h));
});
test('longer holds at same force improve duration independently',()=>{
 const p=get(dates.map((_,i)=>rep(i,20,i<3?30:40)));
 expect(p.duration).toMatchObject({state:'improving',previous:30,recent:40});
 expect(p.force.state).toBe('insufficient');
});
test('small changes remain unchanged and repeated declines are visible',()=>{
 expect(get(dates.map((_,i)=>rep(i,i<3?20:20.5))).force.state).toBe('unchanged');
 expect(get(dates.map((_,i)=>rep(i,i<3?24:20))).force.state).toBe('lower');
});
test('extra reps, interrupted openers and other hands do not create six sessions',()=>{
 const h=dates.slice(0,3).flatMap((_,i)=>[rep(i),rep(i,22,30,{rep_num:2}),rep(i,22,30,{set_num:2}),rep(i,22,30,{hand:'R'})]);
 expect(get(h).force.state).toBe('insufficient');
 expect(get(dates.map((_,i)=>rep(i,20,30,{failure_valid:i!==5}))).force.state).toBe('insufficient');
});
test('prescribed or nominal values do not substitute for measurements',()=>{
 expect(get(dates.map((_,i)=>rep(i,0,30,{prescribed_load_kg:30}))).force.state).toBe('insufficient');
 expect(get(dates.map((_,i)=>rep(i,20,30,{load_provenance:'nominal_setting'}))).force.state).toBe('insufficient');
});
test('new setup or stale observations cannot imply current improvement',()=>{
 expect(get(dates.map((_,i)=>rep(i,20,30,{setup_id:i<3?'old':'new'}))).force.state).toBe('insufficient');
 const h=dates.map((_,i)=>rep(i));
 expect(measuredProgress(h,'Micro','L','2027-01-01').force.state).toBe('insufficient');
});
test('repeat comparison requires actual rest and compares independent sessions',()=>{
 const h=dates.flatMap((_,i)=>[rep(i),rep(i,20,i<3?15:21,{id:`b${i}`,rep_num:2,rep_timing:{rest_before_s:20}})]);
 expect(get(h).repeat).toMatchObject({state:'improving',previous:.5,recent:.7});
 expect(get(h.map(r=>({...r,rep_timing:null}))).repeat.state).toBe('insufficient');
 expect(get(h.map(r=>r.rep_num===2?{...r,rep_timing:{rest_before_s:r.date<'2026-08-01'?20:60}}:r)).repeat.state).toBe('insufficient');
});
test('legacy measured results disclose uncertainty; future records cannot contribute',()=>{
 const h=dates.map((_,i)=>rep(i,20,30,{force_recording:null,load_provenance:null}));
 expect(get(h).force.legacy).toBe(true);
 expect(get([...h,rep(5,100,30,{date:'2026-10-01',session_id:'future'})]).force.best).toBe(20);
});

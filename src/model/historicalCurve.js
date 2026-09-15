import { freshFitReps, effectiveLoad } from './load.js';
import { fitAmpsForPts } from './baselines.js';
import { predForceThreeExp } from './threeExp.js';

// Display-only historical reference. Never feeds prescriptions or mixes
// acquisition-timed measurements with the earlier recording basis.
export function historicalCurve(history, grip, hand='pooled', today=new Date().toISOString().slice(0,10)) {
  const rows=freshFitReps(history || [], {preserveAllBases:true}).filter(r=>
    r.date && r.date<=today && r.grip===grip && (hand==='pooled' || r.hand===hand) && effectiveLoad(r)>0 && r.actual_time_s>0);
  const current=rows.filter(r=>r.force_recording?.basis==='target_acquired');
  const old=rows.filter(r=>r.force_recording?.basis!=='target_acquired');
  const pool=old.length ? old : current;
  const groups=new Map();
  for(const r of pool) {
    const key=r.session_id || r.date;
    if(!key) continue;
    if(!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(r);
  }
  const sessions=[...groups.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,v])=>v);
  if(sessions.length<2 || new Set(pool.map(r=>r.actual_time_s)).size<2) return null;
  const fit=rs=>fitAmpsForPts(rs.map(r=>({T:r.actual_time_s,F:effectiveLoad(r)})),grip,null);
  const amps=fit(pool);
  if(!amps) return null;
  let seed=149;
  const random=()=>{ seed=(Math.imul(1664525,seed)+1013904223)>>>0; return seed/4294967296; };
  const fits=[];
  if(sessions.length>=5) for(let i=0;i<100;i++) {
    const sample=Array.from({length:sessions.length},()=>sessions[Math.floor(random()*sessions.length)]).flat();
    const a=fit(sample); if(a) fits.push(a);
  }
  const min=Math.max(1,Math.min(...pool.map(r=>r.actual_time_s)));
  const max=Math.max(...pool.map(r=>r.actual_time_s));
  const points=Array.from({length:60},(_,i)=>{
    const time=min+(max-min)*i/59;
    const values=fits.map(a=>predForceThreeExp(a,time)).sort((a,b)=>a-b);
    return {time,force:predForceThreeExp(amps,time),range:values.length ? [values[Math.floor(values.length*.05)],values[Math.floor(values.length*.95)]]:null};
  });
  const date=pool.map(r=>r.date).filter(Boolean).sort().at(-1);
  const age=Math.max(0,Math.floor((Date.parse(today)-Date.parse(date))/86400000));
  const newSessions=new Set(current.map(r=>r.session_id || r.date)).size;
  return {points,date,age,sessions:sessions.length,newSessions,transition:old.length>0 && current.length>0,hasBand:fits.length>0};
}

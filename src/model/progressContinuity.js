import { freshFitReps, effectiveLoad } from './load.js';
import { fitAmpsForPts } from './baselines.js';
import { predForceThreeExp } from './threeExp.js';
import { ZONE_REF_T } from './zones.js';

// Display only: preserve the old progress scale, then chain changes measured
// wholly within the new method. Never changes a stored rep or a load floor.
export function extendProgressOverlay(branch, history, grip, hand=null) {
  if (!branch?.dates?.length) return branch;
  const last=branch.dates.at(-1), oldAmps=branch.ampsByDate.get(last);
  const rows=freshFitReps(history,{preserveAllBases:true}).filter(r=>r.grip===grip
    && (!hand || r.hand===hand) && r.force_recording?.basis==='target_acquired'
    && r.date>last && effectiveLoad(r)>0 && r.actual_time_s>0);
  if (!rows.length) return branch;
  const dates=[...new Set([...branch.dates,...rows.map(r=>r.date)])].sort();
  const ampsByDate=new Map(branch.ampsByDate), maxHoldByDate=new Map(branch.maxHoldByDate);
  const progressPointsByDate=new Map(), continuityByDate=new Map();
  const oldRows=freshFitReps(history,{preserveAllBases:true}).filter(r=>r.grip===grip
    && (!hand || r.hand===hand) && r.force_recording?.basis!=='target_acquired' && r.date<=last)
    .sort((a,b)=>a.date.localeCompare(b.date));
  const setups=new Map(oldRows.map(r=>[r.hand,r.setup_id ?? '']));
  const groups=new Map();
  for(const r of rows) {
    if(setups.size && (!setups.has(r.hand) || setups.get(r.hand)!==(r.setup_id ?? ''))) continue;
    const key=`${r.hand}|${r.setup_id ?? ''}`;
    if(!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(r);
  }
  const fit=rs=>fitAmpsForPts(rs.map(r=>({T:r.actual_time_s,F:effectiveLoad(r)})),grip,null);
  const maxT=Math.max(220,branch.maxHoldByDate.get(last) || 220);
  const ts=[...new Set([...Object.values(ZONE_REF_T),...Array.from({length:100},(_,i)=>5+(maxT-5)*i/99)])].sort((a,b)=>a-b);
  for(const date of dates.filter(d=>d>last)) {
    const changes=[];
    for(const group of groups.values()) {
      const available=group.filter(r=>r.date<=date).sort((a,b)=>a.date.localeCompare(b.date));
      const prefixes=[];
      for(const d of [...new Set(available.map(r=>r.date))]) {
        const prefix=available.filter(r=>r.date<=d);
        if(new Set(prefix.map(r=>r.session_id || r.date)).size>=3 && prefix.length>=5
          && new Set(prefix.map(r=>r.target_duration)).size>=3) {
          const base=fit(prefix); if(base) prefixes.push({rows:prefix,base,date:d});
        }
      }
      const now=fit(available);
      if(now) changes.push({now,available,prefixes});
    }
    // Each duration needs local evidence in the new reference window. Sparse
    // domains retain their established estimate instead of extrapolating a gain.
    const supports=(rs,t)=>new Set(rs.filter(r=>r.actual_time_s>=t/2 && r.actual_time_s<=t*2)
      .map(r=>r.session_id || r.date)).size>=3;
    let linked=false;
    const evidenceDates={};
    const rawPoints=ts.map(t=>{
      const usable=changes.map(c=>{
        const reference=c.prefixes.find(p=>supports(p.rows,t));
        const evidenceDate=c.available.filter(r=>r.actual_time_s>=t/2 && r.actual_time_s<=t*2).at(-1)?.date;
        const current=c.prefixes.find(p=>p.date===evidenceDate);
        return {reference,current,evidenceDate};
      }).filter(c=>c.reference && c.current);
      const updated=usable.filter(c=>c.evidenceDate>c.reference.date);
      if(updated.length) linked=true;
      const zone=Object.entries(ZONE_REF_T).find(([,duration])=>duration===t)?.[0];
      if(zone) evidenceDates[zone]=updated.length ? updated.map(c=>c.evidenceDate).sort().at(-1) : last;
      const ratio=usable.length ? Math.exp(usable.reduce((sum,c)=>sum+Math.log(predForceThreeExp(c.current.base,t)/predForceThreeExp(c.reference.base,t)),0)/Math.max(setups.size,groups.size,1)) : 1;
      const f=predForceThreeExp(oldAmps,t)*ratio;
      return {t,f,supported:updated.length>0};
    });
    // Preserve unsupported durations exactly. Bound changed sections by their
    // unchanged neighbors, then enforce monotonicity for Time inversion.
    let ceiling=Infinity;
    const points=rawPoints.map((p,i)=>{
      const next=rawPoints.slice(i+1).find(q=>!q.supported);
      const floor=next ? next.f : 0;
      ceiling=Math.min(ceiling,Math.max(floor,p.f));
      return {t:p.t,f:ceiling};
    });
    progressPointsByDate.set(date,points);
    ampsByDate.set(date,oldAmps); // Original scale retained for baseline metadata.
    maxHoldByDate.set(date,branch.maxHoldByDate.get(last));
    continuityByDate.set(date,{historicalDate:last,newSessions:new Set(rows.filter(r=>r.date<=date).map(r=>r.session_id || r.date)).size,
      linked,evidenceDates});
  }
  return {...branch,dates,ampsByDate,maxHoldByDate,progressPointsByDate,continuityByDate};
}

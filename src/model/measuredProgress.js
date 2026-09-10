import { isCapacityEvidenceRep } from './forceRecording.js';
import { isSeedArtifactRep } from './load.js';
import { compareSessionOrder, compareOpeningRep } from './sessionOrder.js';
import { recoveryEvidence } from './recoveryEvidence.js';

const median = xs => { const s=[...xs].sort((a,b)=>a-b); return s.length ? (s[Math.floor((s.length-1)/2)]+s[Math.floor(s.length/2)])/2 : null; };
const close = (a,b) => a>0 && b>0 && Math.max(a,b)/Math.min(a,b)<=1.10;
const sameSetup = (a,b) => (a.setup_id ?? null)===(b.setup_id ?? null);
const enough = (rows,value,anchor,ref) => {
  const current=rows.filter(r=>r.date>=ref.cutoff && r.date<=ref.today).slice(-6);
  const best=rows.length ? Math.max(...rows.map(value)) : null;
  if(current.length<6 || current.at(-1).date<ref.recent) return {state:'insufficient',label:'Not enough comparable evidence',n:current.length,best};
  const before=current.slice(0,3), after=current.slice(3);
  const previous=median(before.map(value)), recent=median(after.map(value));
  const change=recent/previous-1;
  return {state:change>0.05?'improving':change<-.05?'lower':'unchanged',
    label:change>0.05?'Improving':change<-.05?'Lower recently':'Broadly unchanged',
    previous,recent,change,n:6,best,from:before[0].date,to:after.at(-1).date,
    legacy:current.some(r=>!r.force_recording), anchor};
};

// Descriptive comparisons of measured performance, not predictions or causal
// claims. Six independent session openers: prior three vs latest three.
export function measuredProgress(history, grip, hand, today) {
  const refMs=Date.parse(today+'T12:00:00Z');
  const day=days=>new Date(refMs-days*86400000).toISOString().slice(0,10);
  const ref={today,cutoff:day(90),recent:day(30)};
  const sessions=new Map();
  for(const r of history||[]) {
    if(r.grip!==grip || r.hand!==hand || !r.date || r.date>today || (Number(r.set_num)||1)!==1) continue;
    const key=r.session_id || r.date;
    if(!sessions.has(key)) sessions.set(key,[]);
    sessions.get(key).push(r);
  }
  const openers=[...sessions.values()].map(rs=>[...rs].sort(compareOpeningRep)[0])
    .filter(r=>(Number(r.rep_num)||1)===1 && isCapacityEvidenceRep(r) && !isSeedArtifactRep(r)
      && r.avg_force_kg>0 && r.actual_time_s>0).sort(compareSessionOrder);
  const anchor=openers.at(-1);
  if(!anchor) return {force:enough([],()=>0,null,ref),duration:enough([],()=>0,null,ref),repeat:enough([],()=>0,null,ref)};
  const compatible=openers.filter(r=>sameSetup(r,anchor));
  const force=enough(compatible.filter(r=>close(r.actual_time_s,anchor.actual_time_s)),r=>r.avg_force_kg,{duration:anchor.actual_time_s},ref);
  const duration=enough(compatible.filter(r=>close(r.avg_force_kg,anchor.avg_force_kg)),r=>r.actual_time_s,{load:anchor.avg_force_kg},ref);
  const repeated=[];
  for(const rs of sessions.values()) {
    const e=recoveryEvidence(rs);
    if(e.reps.length<2) continue;
    const [a,b]=e.reps;
    repeated.push({...a,ratio:b.actual_time_s/a.actual_time_s,rest:e.rests[0]});
  }
  repeated.sort(compareSessionOrder);
  const last=repeated.at(-1);
  const repeat=enough(last?repeated.filter(r=>sameSetup(r,last) && close(r.avg_force_kg,last.avg_force_kg)
    && close(r.actual_time_s,last.actual_time_s) && Math.abs(r.rest-last.rest)<=Math.max(1,last.rest*.10)):[],r=>r.ratio,last?{load:last.avg_force_kg,rest:last.rest}:null,ref);
  return {force,duration,repeat};
}

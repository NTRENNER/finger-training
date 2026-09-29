import React,{useMemo,useState} from 'react';
import {PerformanceTrendCards} from '../analysis/PerformanceTrendCards.jsx';
import {C} from '../../ui/theme.js';
const names={original:'Previous trend',contextOnly:'Current trend · earlier training accounted for',contextRobust:'Earlier training + unusual-result protection'};
export function ContextualTrendResults({report,history,unit}) {
  const [preview,setPreview]=useState(false),[model,setModel]=useState('contextOnly');
  const grips=useMemo(()=>[...new Set(history.map(r=>r.grip))].filter(Boolean),[history]);
  const fmt=v=>v==null?'—':`${(v*(unit==='lbs'?2.2046226218:1)).toFixed(2)} ${unit}`;
  const table=(scores)=><div style={{overflowX:'auto'}}><table style={{width:'100%',minWidth:540,textAlign:'left',fontSize:14}}>
    <thead><tr><th>Trend model</th><th>Typical error</th><th>Larger misses</th><th>Bias</th></tr></thead>
    <tbody>{Object.entries(names).map(([key,name])=><tr key={key}><th scope="row" style={{fontWeight:400,padding:'8px 8px 8px 0'}}>{name}</th>
      <td>{fmt(scores[key]?.mae)}</td><td>{fmt(scores[key]?.rmse)}</td><td>{fmt(scores[key]?.bias)}</td></tr>)}</tbody>
  </table></div>;
  return <details style={{marginTop:18}}><summary style={{cursor:'pointer',fontWeight:700}}>Does earlier training explain trend changes?</summary>
    <p style={{color:C.muted,lineHeight:1.5}}>A first rep can follow another tiring workout. The current chart reduces the influence of later sessions, including work on another grip. The experimental alternative also limits the influence of unusually high or low results. Neither assumes how much fatigue was present.</p>
    <p>{report.all.original.trainingDays} training days · {report.all.original.observations} opening holds</p>
    {table(report.all)}
    <p style={{color:C.muted,fontSize:13}}>Lower error is better. These are predictions from strictly earlier dates, tested at each recorded hold duration. A smoother chart alone does not establish better accuracy. Current recommendations remain unchanged.</p>
    {Object.entries(report.byGrip).map(([grip,scores])=><details key={grip}><summary>{grip}</summary>{table(scores)}</details>)}
    {Object.entries(report.byContext).map(([context,scores])=><details key={context}><summary>{context==='after_training'?'After earlier training':context==='first_recorded'?'First recorded session of the day':'Session order unknown'} · {scores.original.trainingDays} days</summary>{table(scores)}</details>)}
    <label style={{display:'flex',gap:8,alignItems:'center',minHeight:44,marginTop:12}}><input type="checkbox" checked={preview} onChange={e=>setPreview(e.target.checked)}/>Compare trend charts</label>
    {preview&&<><label style={{display:'block',marginBottom:16}}>Trend model <select aria-label="Research trend model" value={model} onChange={e=>setModel(e.target.value)} style={{maxWidth:'100%',minHeight:44,background:C.bg,color:C.text}}>
      {Object.entries(names).map(([key,name])=><option key={key} value={key}>{name}</option>)}</select></label>
      <PerformanceTrendCards key={model} history={history} grips={grips} trendModel={model}/></>}
  </details>;
}

import React, {useMemo} from 'react';
import {Card} from '../../ui/components.js';
import {C} from '../../ui/theme.js';
import {fmtW} from '../../ui/format.js';
import {measuredProgress} from '../../model/measuredProgress.js';
import {ymdLocal} from '../../util.js';

export function MeasuredProgressCard({history,grip,hand,unit='kg',today=ymdLocal()}) {
  const progress=useMemo(()=>measuredProgress(history,grip,hand,today),[history,grip,hand,today]);
  const format=(key,v)=>key==='force'?`${fmtW(v,unit)} ${unit}`:key==='duration'?`${Math.round(v)} s`:`${Math.round(v*100)}%`;
  return <Card style={{marginBottom:16}}>
    <div style={{fontWeight:700}}>Measured progress · {grip} · {hand==='L'?'Left':'Right'}</div>
    <p style={{fontSize:12,color:C.muted}}>Latest three comparable sessions versus the previous three, within 90 days. These are measured results, not changes in the fitted curve.</p>
    {Object.entries(progress).map(([key,result])=><div key={key} style={{marginTop:12}}>
      <div><b>{key==='force'?'More force at a similar duration':key==='duration'?'Longer holds at a similar force':'Repeated effort at similar force and rest'}</b> — {result.label}</div>
      {result.n===6 && result.recent!=null && <div style={{fontSize:12}}>{format(key,result.previous)} → {format(key,result.recent)} · {result.from} to {result.to}</div>}
      {result.best!=null && <div style={{fontSize:12,color:C.muted}}>Best recorded in this comparison: {format(key,result.best)}</div>}
      {result.anchor && <div style={{fontSize:12,color:C.muted}}>{key==='force'?`Around ${Math.round(result.anchor.duration)} s`: `Around ${fmtW(result.anchor.load,unit)} ${unit}`}{key==='repeat'?` · ${Math.round(result.anchor.rest)} s rest · second-rep duration as a percentage of the opener`:''}</div>}
      {result.legacy && <div style={{fontSize:12,color:C.muted}}>Includes older force averages with measurement uncertainty.</div>}
    </div>)}
    <p style={{fontSize:11,color:C.muted,marginBottom:0}}>Small changes within 5% are labeled broadly unchanged. This is a descriptive guide, not a statistical test. Comparable conditions cannot be fully verified from older records. Repeated-effort comparisons require recorded actual rest.</p>
  </Card>;
}

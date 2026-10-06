import React, {useMemo} from 'react';
import {Card} from '../../ui/components.jsx';
import {C} from '../../ui/theme.js';
import {fmtW} from '../../ui/format.js';
import {measuredProgress} from '../../model/measuredProgress.js';
import {ymdLocal} from '../../util.js';

export function MeasuredProgressSection({history,grips=[],hands=['L','R'],unit='kg',today=ymdLocal()}) {
  const groups=useMemo(()=>grips.flatMap(grip=>hands.map(hand=>({grip,hand,
    results:Object.entries(measuredProgress(history,grip,hand,today))
  }))),[history,grips,hands,today]);
  const available=groups.map(group=>({...group,results:group.results.filter(([,result])=>result.state!=='insufficient')}))
    .filter(group=>group.results.length>0);
  const incomplete=groups.some(group=>group.results.some(([,result])=>result.state==='insufficient'));
  const largestGroup=Math.max(0,...groups.flatMap(group=>group.results.map(([,result])=>result.n||0)));
  const format=(key,v)=>key==='force'?`${fmtW(v,unit)} ${unit}`:key==='duration'?`${Math.round(v)} s`:`${Math.round(v*100)}%`;
  return <Card style={{marginBottom:16}}>
    <div style={{fontWeight:700}}>Measured progress</div>
    {available.length===0 ? <>
      <p style={{fontSize:14,color:C.muted}}>
        Not enough recent, comparable sessions to show a measured trend. This evidence cannot yet establish an increase or a decrease, even when the estimated curve moves.
      </p>
      <p style={{fontSize:12,color:C.muted,marginBottom:0}}>
        Each comparison needs six similar sessions within 90 days, including a comparable session in the last 30 days.
        {largestGroup>0 && largestGroup<6 ? ` The largest available comparison group has ${largestGroup} of the six sessions needed.` : ''}
      </p>
    </> : <>
      <p style={{fontSize:12,color:C.muted}}>Latest three comparable sessions versus the previous three, within 90 days. These are measured results, not changes in the fitted curve.</p>
      <p style={{fontSize:12,color:C.muted}}>Recorded results can still differ in fatigue and measurement conditions. These comparisons do not adjust for unlogged climbing.</p>
      {available.map(({grip,hand,results})=><section key={`${grip}-${hand}`} style={{marginTop:16}}>
        <div style={{fontWeight:700}}>{grip} · {hand==='L'?'Left':'Right'}</div>
        {results.map(([key,result])=><div key={key} style={{marginTop:10}}>
          <div><b>{key==='force'?'More force at a similar duration':key==='duration'?'Longer holds at a similar force':'Repeated effort at similar force and rest'}</b> — {result.label}</div>
          <div style={{fontSize:12}}>{format(key,result.previous)} → {format(key,result.recent)} · {result.from} to {result.to}</div>
          {result.best!=null && <div style={{fontSize:12,color:C.muted}}>Best recorded under similar conditions (all recorded dates): {format(key,result.best)}</div>}
          {result.anchor && <div style={{fontSize:12,color:C.muted}}>{key==='force'?`Around ${Math.round(result.anchor.duration)} s`: `Around ${fmtW(result.anchor.load,unit)} ${unit}`}{key==='repeat'?` · ${Math.round(result.anchor.rest)} s rest · second-rep duration as a percentage of the opener`:''}</div>}
          {result.legacy && <div style={{fontSize:12,color:C.muted}}>Includes older force averages with measurement uncertainty.</div>}
        </div>)}
      </section>)}
      {incomplete && <p style={{fontSize:12,color:C.muted}}>Other comparisons need more recent, comparable sessions and will appear when available.</p>}
      <details style={{fontSize:12,color:C.muted,marginTop:12}}>
        <summary style={{cursor:'pointer'}}>How comparisons work</summary>
        <p>Small changes within 5% are labeled broadly unchanged. This is a descriptive guide, not a statistical test. Comparable conditions and recording methods cannot be fully verified from older records. Recent repeated-effort comparisons require recorded actual rest; older records may use planned rest.</p>
      </details>
    </>}
  </Card>;
}

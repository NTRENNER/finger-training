import React, {useMemo} from 'react';
import {Card} from '../../ui/components.js';
import {C} from '../../ui/theme.js';
import {fmtW} from '../../ui/format.js';
import {measuredProgress} from '../../model/measuredProgress.js';
import {ymdLocal} from '../../util.js';

export function MeasuredProgressSection({history,grips=[],hands=['L','R'],unit='kg',today=ymdLocal()}) {
  const groups=useMemo(()=>grips.flatMap(grip=>hands.map(hand=>({grip,hand,
    results:Object.entries(measuredProgress(history,grip,hand,today)).filter(([,r])=>r.state!=='insufficient')
  }))),[history,grips,hands,today]);
  const available=groups.filter(g=>g.results.length>0);
  const incomplete=groups.some(g=>g.results.length<3);
  const format=(key,v)=>key==='force'?`${fmtW(v,unit)} ${unit}`:key==='duration'?`${Math.round(v)} s`:`${Math.round(v*100)}%`;
  return <Card style={{marginBottom:16}}>
    <div style={{fontWeight:700}}>Measured progress</div>
    {available.length===0 ? <p style={{fontSize:14,color:C.muted,marginBottom:0}}>
      Not enough recent, comparable sessions to show a trend yet. After time away or with limited data, this is expected—it does not mean your performance has declined. Trends will appear here as comparable sessions accumulate.
    </p> : <>
      <p style={{fontSize:12,color:C.muted}}>Latest three comparable sessions versus the previous three, within 90 days. These are measured results, not changes in the fitted curve.</p>
      {available.map(({grip,hand,results})=><section key={`${grip}-${hand}`} style={{marginTop:16}}>
        <div style={{fontWeight:700}}>{grip} · {hand==='L'?'Left':'Right'}</div>
        {results.map(([key,result])=><div key={key} style={{marginTop:10}}>
          <div><b>{key==='force'?'More force at a similar duration':key==='duration'?'Longer holds at a similar force':'Repeated effort at similar force and rest'}</b> — {result.label}</div>
          <div style={{fontSize:12}}>{format(key,result.previous)} → {format(key,result.recent)} · {result.from} to {result.to}</div>
          {result.best!=null && <div style={{fontSize:12,color:C.muted}}>Best recorded in this comparison: {format(key,result.best)}</div>}
          {result.anchor && <div style={{fontSize:12,color:C.muted}}>{key==='force'?`Around ${Math.round(result.anchor.duration)} s`: `Around ${fmtW(result.anchor.load,unit)} ${unit}`}{key==='repeat'?` · ${Math.round(result.anchor.rest)} s rest · second-rep duration as a percentage of the opener`:''}</div>}
          {result.legacy && <div style={{fontSize:12,color:C.muted}}>Includes older force averages with measurement uncertainty.</div>}
        </div>)}
      </section>)}
      {incomplete && <p style={{fontSize:12,color:C.muted}}>Other comparisons need more recent, comparable sessions and will appear when available.</p>}
      <details style={{fontSize:12,color:C.muted,marginTop:12}}>
        <summary style={{cursor:'pointer'}}>How comparisons work</summary>
        <p>Small changes within 5% are labeled broadly unchanged. This is a descriptive guide, not a statistical test. Comparable conditions cannot be fully verified from older records. Repeated-effort comparisons require recorded actual rest.</p>
      </details>
    </>}
  </Card>;
}

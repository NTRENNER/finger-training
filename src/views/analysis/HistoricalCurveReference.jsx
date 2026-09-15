import React, {useMemo,useState} from 'react';
import {ResponsiveContainer,ComposedChart,Line,Area,XAxis,YAxis,Tooltip,CartesianGrid} from 'recharts';
import {freshFitReps, effectiveLoad} from '../../model/load.js';
import {ymdLocal} from '../../util.js';
import {historicalCurve} from '../../model/historicalCurve.js';
import {toDisp} from '../../ui/format.js';
import {C} from '../../ui/theme.js';
import {GRIP_COLORS} from '../../ui/grip-colors.js';

export function HistoricalCurveReference({history,grip,hand='pooled',unit='lbs'}) {
  const today=ymdLocal(new Date());
  const [selection,setSelection]=useState(null);
  const scope=`${grip}|${hand}`;
  const dates=useMemo(()=>[...new Set([...freshFitReps(history || [],{preserveAllBases:true})
    .filter(r=>r.grip===grip && (hand==='pooled' || r.hand===hand) && r.date && r.date<=today && effectiveLoad(r)>0 && r.actual_time_s>0)
    .map(r=>r.date),today])].sort(),[history,grip,hand,today]);
  const chosen=selection?.scope===scope && dates.includes(selection.date) ? selection.date : today;
  const reference=useMemo(()=>historicalCurve(history,grip,hand,chosen),[history,grip,hand,chosen]);
  const latest=useMemo(()=>historicalCurve(history,grip,hand,today),[history,grip,hand,today]);
  if(!latest) return null;
  const color=GRIP_COLORS[grip] || C.purple;
  const data=(reference?.points || []).map(p=>({...p,force:toDisp(p.force,unit),range:p.range?.map(v=>toDisp(v,unit))}));
  return <section aria-label={`${grip} historical curve`} style={{margin:'16px 0'}}>
    <strong style={{color}}>{grip} · Historical curve</strong>
    <div style={{color:C.muted}}>Viewing: <b>{chosen===today ? `Today · ${today}` : chosen}</b></div>
    {reference ? <><p style={{color:C.muted}}>Last evidence: {reference.date} · {reference.sessions} independent sessions.
      {reference.age>30 ? ' Stale at this date — confidence in ability at this date is low.' : ' Recent evidence at this date; confidence also depends on session count and duration coverage.'}</p>
    {reference.transition && <p>Updated recording method: {reference.newSessions} new session{reference.newSessions===1?'':'s'}. Your historical curve stays visible while a comparable baseline develops.</p>}
    <ResponsiveContainer width="100%" height={230}>
      <ComposedChart data={data} margin={{top:8,right:20,bottom:20,left:10}}>
        <CartesianGrid stroke={C.border} strokeDasharray="3 3" />
        <XAxis dataKey="time" type="number" domain={['dataMin','dataMax']} tickFormatter={v=>Math.round(v)} unit="s" stroke={C.muted}/>
        <YAxis unit={` ${unit}`} stroke={C.muted}/>
        <Tooltip formatter={(v)=>Array.isArray(v)?v.map(n=>n.toFixed(1)).join('–')+' '+unit:Number(v).toFixed(1)+' '+unit} labelFormatter={v=>`${Number(v).toFixed(0)} seconds`}/>
        {reference.hasBand && <Area dataKey="range" name="Historical fit interval" stroke="none" fill={color} fillOpacity={0.15} isAnimationActive={false}/>}
        <Line dataKey="force" name="Historical force" stroke={color} strokeDasharray="6 4" dot={false} isAnimationActive={false}/>
      </ComposedChart>
    </ResponsiveContainer>
    <p style={{color:C.muted,fontSize:12}}>{reference.hasBand ? 'Shading: 90% session-bootstrap interval for the historical fit. It does not account for changes during time away.' : 'Too few independent sessions for an uncertainty band.'} New workouts across several durations strengthen the updated curve; historical and updated recording methods are kept separate.</p>
    </> : <p style={{color:C.muted}}>Not enough evidence to fit a curve at this date. Later sessions are not included.</p>}
    <label style={{display:'block',marginTop:12}}>
      Historical date · {chosen}
      <input aria-label={`${grip} historical curve date`} type="range" min={0} max={dates.length-1}
        step={1} value={dates.indexOf(chosen)} onChange={e=>setSelection({scope,date:dates[Number(e.target.value)]})}
        style={{width:'100%',accentColor:color}}/>
    </label>
  </section>;
}

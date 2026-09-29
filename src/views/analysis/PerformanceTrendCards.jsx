import React,{useMemo,useState} from 'react';
import {ResponsiveContainer,ComposedChart,Line,Bar,XAxis,YAxis,Tooltip,CartesianGrid,ReferenceLine} from 'recharts';
import {Card} from '../../ui/components.js';
import {C} from '../../ui/theme.js';
import {GRIP_COLORS} from '../../ui/grip-colors.js';
import {DateRangeSlider} from '../../ui/DateRangeSlider.jsx';
import {buildPerformanceTrends,DEFAULT_PERFORMANCE_TREND_MODEL} from '../../model/performanceTrends.js';
import {suggestCookedFromClimbs} from '../../model/climbingFatigue.js';
const fmtDate = ts=>new Date(ts).toISOString().slice(5,10);

export function PerformanceTrendCards({history,grips,handView='pooled',activities=[],normalizeOn=false,trendModel=DEFAULT_PERFORMANCE_TREND_MODEL}) {
  const rows=useMemo(()=>buildPerformanceTrends(history,grips,handView,{model:trendModel}),[history,grips,handView,trendModel]);
  const [window,setWindow]=useState(null),[climbing,setClimbing]=useState(false);
  const dates=rows.map(r=>r.date);
  const start=window?Math.max(0,dates.findIndex(d=>d>=window[0])):0;
  const last=window?dates.findLastIndex(d=>d<=window[1]):dates.length-1;
  const end=Math.max(start,last);
  const visible=useMemo(()=>rows.slice(start,end+1).map(r=>({...r,
    climbLoad:climbing?suggestCookedFromClimbs(activities,r.date)?.cooked??null:null})),[rows,start,end,activities,climbing]);
  const laterHolds=visible.reduce((sum,r)=>sum+grips.reduce((n,g)=>n+(r[`${g}_laterHolds`]||0),0),0);
  const ready=grips.filter(g=>rows.some(r=>Number.isFinite(r[`${g}_long`])));
  if (!rows.length) return <Card style={{marginBottom:16}}><h3>Performance trends</h3><p style={{color:C.muted}}>More training dates needed. Trends appear after five eligible training dates per hand. For a single hand, select Left or Right above.</p></Card>;
  const chart=(kind)=>!visible.some(r=>grips.some(g=>Number.isFinite(r[`${g}_${kind}`])))?<p style={{color:C.muted}}>No comparable points in this date range.</p>:<ResponsiveContainer width="100%" height={270}>
    <ComposedChart data={visible} margin={{top:12,right:16,bottom:10,left:0}}>
      <CartesianGrid stroke={C.border} strokeDasharray="3 3"/>
      <XAxis type="number" dataKey="timestamp" domain={['dataMin','dataMax']} scale="time" tickFormatter={fmtDate} tick={{fill:C.muted,fontSize:11}} minTickGap={32}/>
      <YAxis yAxisId="trend" unit="%" width={58} tickFormatter={v=>Number(v.toFixed(1))} tick={{fill:C.muted,fontSize:11}} domain={kind==='short'?([lo,hi])=>{const span=Math.max(5,Math.abs(lo||0),Math.abs(hi||0));return [-Math.ceil(span),Math.ceil(span)];}:([lo,hi])=>[Math.min(-5,(lo||0)-1),Math.max(5,(hi||0)+1)]}/>
      <YAxis yAxisId="climb" domain={[0,40]} orientation="right" width={0} hide/>
      <ReferenceLine yAxisId="trend" y={0} stroke={C.muted} strokeDasharray="5 5"/>
      <Tooltip labelFormatter={ts=>new Date(ts).toISOString().slice(0,10)} contentStyle={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8}}
        formatter={(v,name)=>[name==='Climbing load'?`${v}/10`:`${v>=0?'+':''}${Number(v).toFixed(1)}%`,name]}/>
      {climbing&&<Bar yAxisId="climb" dataKey="climbLoad" name="Climbing load" fill={C.orange} opacity={.4} barSize={6} isAnimationActive={false}/>}
      {grips.map(g=><Line key={g} yAxisId="trend" dataKey={`${g}_${kind}`} name={g} stroke={GRIP_COLORS[g]||C.blue}
        strokeWidth={kind==='long'?3:2} dot={{r:3}} connectNulls type="linear" isAnimationActive={false}/>)}
    </ComposedChart>
  </ResponsiveContainer>;
  return <section aria-label="Performance trends">
    <Card style={{marginBottom:16}}>
      <h3 style={{marginTop:0}}>Long-term performance trend</h3>
      <div style={{display:'flex',gap:20,flexWrap:'wrap'}}>{grips.map(g=><span key={g} style={{color:GRIP_COLORS[g]||C.blue}}>━ {g}</span>)}</div>
      <p style={{color:C.muted,lineHeight:1.5}}>Estimated whole-curve capacity, relative to your first established estimate. Each point uses the training recorded by that date.</p>
      {trendModel!=='original'&&<p style={{color:C.muted,fontSize:13}}>Sessions after earlier finger training that day receive less weight, including training on another grip.</p>}
      {trendModel==='contextRobust'&&<p style={{color:C.yellow}}>Research preview: unusually high and low results also have reduced influence. This additional smoothing is experimental.</p>}
      {normalizeOn&&<p style={{color:C.muted,fontSize:13}}>These performance trends use measured force. The bodyweight toggle applies to the other curve charts.</p>}
      {!ready.length?<p>More data needed to compare both hands. Try a single-hand view.</p>:chart('long')}
      <DateRangeSlider dates={dates} start={start} end={end} onChange={(a,b)=>setWindow([dates[a],dates[b]])}/>
      <button onClick={()=>setWindow(null)} style={{background:C.bg,color:C.text,border:`1px solid ${C.border}`,borderRadius:8,padding:12,minHeight:44}}>Show all dates</button>
      <details style={{marginTop:16}}><summary style={{cursor:'pointer',padding:'12px 0'}}>Chart details and overlays</summary>
        <label style={{display:'flex',gap:10,alignItems:'center',minHeight:44}}><input type="checkbox" checked={climbing} onChange={e=>setClimbing(e.target.checked)}/>Show climbing load</label>
        <p style={{color:C.muted,lineHeight:1.5}}>The longer trend uses a 90-day half-life: older training gradually receives less weight. Both-hand capacity weights the two hands equally. These are experimental, unadjusted-for-bodyweight estimates; they do not change your workout recommendations. Thinly tested durations remain uncertain.</p>
        {climbing&&<p style={{color:C.muted}}>Orange bars show estimated climbing load around each training date, including the previous day. They give context, not proof of what caused a change.</p>}
      </details>
    </Card>
    <Card style={{marginBottom:16}}><h3 style={{marginTop:0}}>Short-term performance trend</h3>
      <p style={{color:C.muted,lineHeight:1.5}}>How opening holds compared with the curve estimated before that day, at the same hold duration. Above zero means more force than expected; below means less. This is variation, not a recovery diagnosis.</p>
      {laterHolds>0&&<p style={{color:C.muted,fontSize:13}}>{laterHolds} opening holds in this date range followed earlier finger training that day. These results may reflect accumulated fatigue; they remain part of the short-term chart.</p>}
      {chart('short')}
      <div style={{display:'flex',gap:20,flexWrap:'wrap'}}>{grips.map(g=><span key={g} style={{color:GRIP_COLORS[g]||C.blue}}>━ {g}</span>)}</div>
      <p style={{color:C.muted,fontSize:13}}>Both charts show {dates[start]} through {dates[end]}. Only eligible opening holds within previously measured durations are compared. Same-day results cannot alter that day’s expected curve.</p>
    </Card>
  </section>;
}

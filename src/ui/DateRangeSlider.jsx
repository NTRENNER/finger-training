import React from 'react';
import './DateRangeSlider.css';

export function DateRangeSlider({dates,start,end,onChange}) {
  if (!dates.length) return null;
  const max=dates.length-1, left=max?start/max*100:0, right=max?end/max*100:100;
  return <div className="date-window">
    <div className="date-window-heading"><strong>Date range</strong><span aria-live="polite">Showing {end-start+1} of {dates.length} training dates</span></div>
    <div className="date-window-track" style={{'--range-left':`${left}%`,'--range-right':`${right}%`}}>
      <div className="date-window-selection" />
      <input type="range" aria-label="Start date" aria-valuetext={dates[start]} min={0} max={Math.max(1,max)} value={start}
        disabled={!max} onChange={e=>onChange(Math.min(Number(e.target.value),Math.max(0,end-1)),end)} />
      <input type="range" aria-label="End date" aria-valuetext={dates[end]} min={0} max={Math.max(1,max)} value={end}
        disabled={!max} onChange={e=>onChange(start,Math.min(max,Math.max(Number(e.target.value),start+1)))} />
    </div>
    <div className="date-window-labels"><label>From<input aria-label="From date" type="date" min={dates[0]} max={dates[end]} value={dates[start]}
      onChange={e=>{const i=dates.findIndex(d=>d>=e.target.value);if(e.target.value&&i>=0)onChange(Math.min(i,Math.max(0,end-1)),end);}} /></label>
      <label>Through<input aria-label="Through date" type="date" min={dates[start]} max={dates[max]} value={dates[end]}
      onChange={e=>{const i=dates.findLastIndex(d=>d<=e.target.value);if(e.target.value&&i>=0)onChange(start,Math.min(max,Math.max(i,start+1)));}} /></label></div>
  </div>;
}

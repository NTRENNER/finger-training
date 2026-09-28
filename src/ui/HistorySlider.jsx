import React from 'react';
import './HistorySlider.css';

// A shared history control: two handles select a window; one selects an as-of date.
export function HistorySlider({max, start=null, end, onStartChange, onEndChange,
  startLabel='Start date', endLabel='End date', startText, endText, color='#58a6ff'}) {
  const left=max && start!=null ? start/max*100 : 0;
  const right=max ? end/max*100 : 100;
  return <div className="history-slider" style={{'--history-color':color,
    '--history-left':`${left}%`, '--history-right':`${right}%`}}>
    <div className="history-slider-rail"><div className="history-slider-selection" /></div>
    {start!=null && <input type="range" aria-label={startLabel} aria-valuetext={startText}
      min={0} max={Math.max(1,max)} step={1} value={start} disabled={!max}
      onChange={e=>onStartChange(Number(e.target.value))} />}
    <input type="range" aria-label={endLabel} aria-valuetext={endText}
      min={0} max={Math.max(1,max)} step={1} value={end} disabled={!max}
      onChange={e=>onEndChange(Number(e.target.value))} />
  </div>;
}

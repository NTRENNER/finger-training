import React from 'react';
import './DateRangeSlider.css';
import {HistorySlider} from './HistorySlider.jsx';

export function DateRangeSlider({dates,start,end,onChange}) {
  if (!dates.length) return null;
  const max=dates.length-1;
  return <div className="date-window">
    <div className="date-window-heading"><strong>Date range</strong><span aria-live="polite">Showing {end-start+1} of {dates.length} training dates</span></div>
    <HistorySlider max={max} start={start} end={end} startText={dates[start]} endText={dates[end]}
      onStartChange={value=>onChange(Math.min(value,Math.max(0,end-1)),end)}
      onEndChange={value=>onChange(start,Math.min(max,Math.max(value,start+1)))} />
    <div className="date-window-labels">
      <span>From <time dateTime={dates[start]}>{dates[start]}</time></span>
      <span>Through <time dateTime={dates[end]}>{dates[end]}</time></span>
    </div>
  </div>;
}

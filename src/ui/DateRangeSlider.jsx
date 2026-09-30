import React from 'react';
import './DateRangeSlider.css';
import {HistorySlider} from './HistorySlider.jsx';

// Keep at least two dates when available, including after deletion shrinks
// a remembered window to its last date. A single remaining date is disabled.
export function normalizeHistoryWindow(start, end, max) {
  if (max <= 0) return [0, 0];
  const last = Math.max(1, Math.min(max, Number.isFinite(end) ? end : max));
  return [Math.max(0, Math.min(last - 1, Number.isFinite(start) ? start : 0)), last];
}

export function DateRangeSlider({dates,start,end,onChange}) {
  if (!dates.length) return null;
  const max=dates.length-1;
  [start,end]=normalizeHistoryWindow(start,end,max);
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

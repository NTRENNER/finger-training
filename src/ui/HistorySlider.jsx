import React, { useRef } from 'react';
import './HistorySlider.css';

// Two native keyboard-accessible controls share a pointer surface. Selecting
// the nearest handle here prevents the later-painted thumb stealing touches
// from Start when their 40px touch targets overlap.
export function HistorySlider({max, start=null, end, onStartChange, onEndChange,
  startLabel='Start date', endLabel='End date', startText, endText, color='#58a6ff'}) {
  const startRef = useRef(null), endRef = useRef(null), drag = useRef(null);
  const left=max && start!=null ? start/max*100 : 0;
  const right=max ? end/max*100 : 100;
  const pointerValue = event => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(max, (event.clientX - bounds.left - 20) / Math.max(1, bounds.width - 40) * max));
  };
  const update = (handle, value) => (handle === 'start' ? onStartChange : onEndChange)(Math.round(value));
  const stop = event => {
    if (!drag.current || drag.current.id !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <div className={`history-slider${start!=null ? ' history-slider-range' : ''}`}
    onPointerDown={event => {
      if (start == null || !max || (event.button != null && event.button !== 0) || drag.current) return;
      event.preventDefault();
      const value = pointerValue(event);
      const handle = value <= (start + end) / 2 ? 'start' : 'end';
      drag.current = { id: event.pointerId, handle };
      (handle === 'start' ? startRef : endRef).current.focus();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      update(handle, value);
    }}
    onPointerMove={event => { if (drag.current && drag.current.id === event.pointerId) update(drag.current.handle, pointerValue(event)); }}
    onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={() => { drag.current = null; }}
    style={{'--history-color':color, '--history-left':`${left}%`, '--history-right':`${right}%`}}>
    <div className="history-slider-rail"><div className="history-slider-selection" /></div>
    {start!=null && <input ref={startRef} type="range" aria-label={startLabel} aria-valuetext={startText}
      min={0} max={Math.max(1,max)} step={1} value={start} disabled={!max}
      onChange={e=>onStartChange(Number(e.target.value))} />}
    <input ref={endRef} type="range" aria-label={endLabel} aria-valuetext={endText}
      min={0} max={Math.max(1,max)} step={1} value={end} disabled={!max}
      onChange={e=>onEndChange(Number(e.target.value))} />
  </div>;
}

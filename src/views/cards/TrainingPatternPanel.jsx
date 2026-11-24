import React, { useState } from 'react';
import { C } from '../../ui/theme.js';
import { toDisp } from '../../ui/format.js';
import './TrainingPatternPanel.css';

const count = (n, word, plural = `${word}s`) => `${n} ${n === 1 ? word : plural}`;
const minutes = seconds => (seconds / 60).toFixed(1);
const dateLabel = (date, options) => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { ...options, timeZone: 'UTC' });

export function TrainingPatternPanel({ pattern, unit = 'lbs' }) {
  const [selection, setSelection] = useState(null);
  if (!pattern) return null;
  const { totals, days } = pattern;
  const selected = days.find(d => d.date === selection)
    || days.filter(d => d.reps || d.climbingEntries).at(-1) || days.at(-1);
  const loadingUnit = `${unit}·s`;
  return <section aria-label="Training pattern" style={{ borderTop: `1px solid ${C.border}`, marginTop: 16, paddingTop: 14 }}>
    <h3 style={{ fontSize: 15, margin: '0 0 4px' }}>Training pattern</h3>
    <p style={{ color: C.muted, fontSize: 12, margin: '0 0 12px' }}>Last 7 days · {dateLabel(pattern.start, { month: 'short', day: 'numeric' })}–{dateLabel(pattern.end, { month: 'short', day: 'numeric' })}</p>
    <div className="training-pattern-stats">
      {[[totals.trainingDays, 'Training days'], [totals.blocks, 'Identified blocks'], [totals.reps, 'Recorded reps']].map(([value, label]) => <div key={label} role="group" aria-label={label}>
        <strong style={{ fontSize: 24 }}>{value}</strong><div style={{ color: C.muted, fontSize: 12 }}>{label}</div>
      </div>)}
    </div>
    {totals.unidentifiedReps > 0 && <p style={{ color: C.muted, fontSize: 12 }}>Block identity is missing for {count(totals.unidentifiedReps, 'rep')}; those reps still count toward training days and recorded work.</p>}
    <details style={{ marginTop: 8 }}>
      <summary style={{ minHeight: 44, padding: '12px 0', boxSizing: 'border-box', cursor: 'pointer', color: C.blue, fontSize: 13 }}>See days and blocks</summary>
      <div className="training-pattern-days" aria-label="Recorded training days">
        {days.map(day => <button key={day.date} type="button" aria-pressed={selected.date === day.date}
          aria-label={`${day.date}: ${count(day.blocks.filter(b => b.identified).length, 'identified block')}${day.unidentifiedReps ? ', block identity unknown for some reps' : ''}${day.climbingEntries ? ', climbing logged' : ''}`}
          onClick={() => setSelection(day.date)} style={{ borderColor: selected.date === day.date ? C.blue : C.border }}>
          <span style={{ color: C.muted, fontSize: 11 }}>{dateLabel(day.date, { weekday: 'short' })}</span>
          <strong>{dateLabel(day.date, { day: 'numeric' })}</strong>
          <span style={{ color: C.blue, fontSize: 11 }}>{day.reps ? day.unidentifiedReps
            ? `${day.blocks.filter(b => b.identified).length || '?'}${day.blocks.some(b => b.identified) ? '+' : ''} blocks`
            : count(day.blocks.length, 'block') : '—'}</span>
          {day.climbingEntries > 0 && <span style={{ color: C.purple, fontSize: 10 }}>Climbing</span>}
        </button>)}
      </div>
      <div aria-live="polite" style={{ marginTop: 12, fontSize: 13 }}>
        <strong>{dateLabel(selected.date, { weekday: 'long', month: 'short', day: 'numeric' })}</strong>
        {selected.blocks.map(block => <div key={block.key} style={{ padding: '10px 0', borderBottom: `1px solid ${C.border}` }}>
          <div>{block.grip} · {block.identified ? block.protocols.join(' / ') : 'Block identity unknown'}</div>
          <div style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>{count(block.reps, 'rep')}{block.identified ? ` · ${count(block.sets, 'set')} across hands` : ''} · {minutes(block.workSeconds)} min recorded activity</div>
        </div>)}
        {selected.climbingEntries > 0 && <p>Climbing logged · {count(selected.climbingEntries, 'entry', 'entries')}</p>}
        {!selected.reps && !selected.climbingEntries && <p style={{ color: C.muted }}>No training logged on this date.</p>}
      </div>
      <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.6, marginTop: 12 }}>
        <div>{count(totals.sets, 'identified set')} across hands · {minutes(totals.workSeconds)} min recorded activity{totals.attempts > totals.reps ? ` · includes ${count(totals.attempts - totals.reps, 'redo attempt')}` : ''}</div>
        <div>Measured load × time: {Math.round(toDisp(totals.measuredKgS, unit)).toLocaleString()} {loadingUnit}
          {totals.estimatedKgS > 0 ? ` · estimated from entered loads: ${Math.round(toDisp(totals.estimatedKgS, unit)).toLocaleString()} ${loadingUnit}` : ''}</div>
        {totals.unknownLoadSeconds > 0 && <div>{minutes(totals.unknownLoadSeconds)} min has no known load; it is excluded from load × time.</div>}
        {totals.uncertain && <div>Some activity recordings are incomplete or have estimated timing.</div>}
        {pattern.spacingDays.length > 0 && <div>Recorded gaps between training days: {pattern.spacingDays.join(', ')} days.</div>}
        {pattern.sharedClimbingDays > 0 && <div>Climbing and fingers share {count(pattern.sharedClimbingDays, 'date')}. Their order is not established by this view.</div>}
        {pattern.byGrip.map(g => <div key={g.grip}>{g.grip}: {count(g.trainingDays, 'day')} · {count(g.blocks, 'identified block')}</div>)}
        {pattern.byProtocol.map(p => <div key={p.protocol}>{p.protocol}: {count(p.blocks, 'identified block')} · {count(p.reps, 'rep')}</div>)}
      </div>
    </details>
  </section>;
}

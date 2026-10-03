import React, { useMemo } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { historicalForceRecords, historicalForceTimeline } from '../../model/historicalForceRecords.js';
import { Card } from '../../ui/components.jsx';
import { C } from '../../ui/theme.js';
import { GRIP_COLORS } from '../../ui/grip-colors.js';
import { bwOnDate, fmt1, toDisp } from '../../ui/format.js';

export function SustainedMaxCard({ history = [], unit = 'lbs', normalizeOn = false, bodyWeight = null, bwLog = [] }) {
  const records = useMemo(() => historicalForceRecords(history), [history]);
  const timeline = useMemo(() => historicalForceTimeline(records).map(point => {
    const converted = { ...point };
    records.forEach((_, index) => {
      const value = point[`series${index}`];
      converted[`series${index}`] = value == null ? null : toDisp(value, unit);
    });
    return converted;
  }), [records, unit]);
  const display = record => {
    const bw = bwOnDate(bwLog, record.date)?.kg ?? bodyWeight;
    return normalizeOn && bw > 0 ? `${(record.kg / bw).toFixed(2)} × BW` : `${fmt1(toDisp(record.kg, unit))} ${unit}`;
  };
  return <Card style={{ marginBottom: 16 }}>
    <h3 style={{ marginTop: 0 }}>Best max of at least 2s</h3>
    {records.length ? <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        {records.map(r => <div key={`${r.grip}-${r.hand}`} style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: 12 }}>
          <div style={{ color: GRIP_COLORS[r.grip] || C.blue }}>{r.grip} · {r.hand === 'L' ? 'Left hand' : 'Right hand'}</div>
          <div style={{ fontSize: 26, fontWeight: 800, color: C.blue }}>{display(r.best)}</div>
          <div style={{ color: C.muted, fontSize: 12 }}>{r.best.date} · {fmt1(r.best.durationS)}s</div>
        </div>)}
      </div>
      <div role="img" aria-label={`All-time best force history in ${unit}; solid lines show left hands, dashed lines show right hands.`}
        style={{ height: 300, marginTop: 24, minWidth: 0 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={timeline} margin={{ top: 12, right: 18, bottom: 8, left: 4 }}>
            <CartesianGrid stroke={C.border} strokeDasharray="3 3" />
            <XAxis dataKey="timestamp" type="number" scale="time" domain={['dataMin', 'dataMax']}
              tickFormatter={value => new Date(value).toISOString().slice(5, 10)} stroke={C.muted} minTickGap={35} />
            <YAxis stroke={C.muted} width={58} tickFormatter={value => `${Math.round(value)}`} label={{ value: unit, angle: -90, position: 'insideLeft', fill: C.muted }} />
            <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8 }}
              labelFormatter={value => new Date(value).toISOString().slice(0, 10)}
              formatter={(value, name, item) => {
                const record = item.payload[`record${String(item.dataKey).replace('series', '')}`];
                return [`${fmt1(value)} ${unit} · ${fmt1(record.durationS)}s · ${record.date}`, name];
              }} />
            {records.map((r, index) => <Line key={`${r.grip}-${r.hand}`} dataKey={`series${index}`}
              name={`${r.grip} · ${r.hand === 'L' ? 'Left hand' : 'Right hand'}`} stroke={GRIP_COLORS[r.grip] || C.blue}
              strokeDasharray={r.hand === 'R' ? '6 4' : undefined} strokeWidth={2.5}
              type="stepAfter" dot={timeline.length === 1 ? { r: 4 } : false} activeDot={{ r: 4 }} isAnimationActive={false} />)}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div aria-label="Chart legend" style={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: '8px 20px', marginTop: 8 }}>
        {records.map(r => <span key={`${r.grip}-${r.hand}`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: GRIP_COLORS[r.grip] || C.blue }}>
          <svg width="40" height="12" aria-hidden="true" style={{ flexShrink: 0 }}>
            <line x1="0" y1="6" x2="40" y2="6" stroke="currentColor" strokeWidth="2.5"
              strokeDasharray={r.hand === 'R' ? '6 4' : undefined} />
          </svg>
          {r.grip}: {r.hand === 'L' ? 'Left hand' : 'Right hand'}
        </span>)}
      </div>
    </> : <p style={{ color: C.muted }}>No qualifying holds yet.</p>}
  </Card>;
}

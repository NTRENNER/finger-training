import React, { useMemo } from 'react';
import { sustainedMaxRecords } from '../../model/sustainedMax.js';
import { Card } from '../../ui/components.jsx';
import { C } from '../../ui/theme.js';
import { GRIP_COLORS } from '../../ui/grip-colors.js';
import { bwOnDate, fmt1, toDisp } from '../../ui/format.js';

export function SustainedMaxCard({ history = [], unit = 'lbs', normalizeOn = false, bodyWeight = null, bwLog = [] }) {
  const records = useMemo(() => sustainedMaxRecords(history), [history]);
  const display = record => {
    const bw = bwOnDate(bwLog, record.date)?.kg ?? bodyWeight;
    return normalizeOn && bw > 0 ? `${(record.kg / bw).toFixed(2)} × BW` : `${fmt1(toDisp(record.kg, unit))} ${unit}`;
  };
  return <Card style={{ marginBottom: 16 }}>
    <h3 style={{ marginTop: 0 }}>Best two-second force</h3>
    <p style={{ color: C.muted }}>Your highest average force over two continuous seconds, for each grip and hand.
      Any recorded hold can set a new best, including later sets and Chaos Machine holds.</p>
    {records.length ? <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
      {records.map(r => <div key={`${r.grip}-${r.hand}`} style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: 12 }}>
        <div style={{ color: GRIP_COLORS[r.grip] || C.blue }}>{r.grip} · {r.hand === 'L' ? 'Left hand' : 'Right hand'}</div>
        <div style={{ fontSize: 26, fontWeight: 800, color: C.blue }}>{display(r)}</div>
        <div style={{ color: C.muted, fontSize: 12 }}>{r.date}</div>
      </div>)}
    </div> : <p>No verified two-second measurement yet. Your next recorded holds will start this record.
      Older instantaneous peaks remain in your workout history.</p>}
    <p style={{ color: C.muted, fontSize: 12, marginBottom: 0 }}>A record proves force sustained for at least two seconds;
      it does not establish time to failure. Lower results never erase your best.</p>
  </Card>;
}

import React, { useMemo, useCallback } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { historicalForceRecords, historicalForceTimeline } from '../../model/historicalForceRecords.js';
import { Card, CardTitle } from '../../ui/components.jsx';
import { ChartLegend } from '../../ui/ChartLegend.jsx';
import { CHART } from '../../ui/chartStyles.js';
import { C } from '../../ui/theme.js';
import { GRIP_COLORS } from '../../ui/grip-colors.js';
import { bwOnDate, fmt1, toDisp } from '../../ui/format.js';

export function SustainedMaxCard({ history = [], unit = 'lbs', normalizeOn = false, bodyWeight = null, bwLog = [] }) {
  const relative = normalizeOn && bodyWeight > 0;
  const forceUnit = relative ? '× BW' : unit;
  const valueForRecord = useCallback(record => {
    const bw = bwOnDate(bwLog, record.date)?.kg ?? bodyWeight;
    return relative ? record.kg / bw : record.kg;
  }, [relative, bwLog, bodyWeight]);
  const records = useMemo(() => historicalForceRecords(history, valueForRecord), [history, valueForRecord]);
  const displayValue = useCallback(record => relative ? valueForRecord(record) : toDisp(record.kg, unit), [relative, valueForRecord, unit]);
  const formatValue = value => relative ? Number(value).toFixed(2) : fmt1(value);
  const timeline = useMemo(() => historicalForceTimeline(records).map(point => {
    const converted = { ...point };
    records.forEach((_, index) => {
      const record = point[`record${index}`];
      converted[`series${index}`] = record ? displayValue(record) : null;
    });
    return converted;
  }), [records, displayValue]);
  return <Card style={{ marginBottom: 16 }}>
    <CardTitle>Best max of at least 2s</CardTitle>
    {records.length ? <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        {records.map(r => <div key={`${r.grip}-${r.hand}`} style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: 12 }}>
          <div style={{ color: GRIP_COLORS[r.grip] || C.blue, fontSize: 12, fontWeight: 700 }}>{r.grip} · {r.hand === 'L' ? 'Left hand' : 'Right hand'}</div>
          <div style={{ fontSize: 26, fontWeight: 800, color: C.blue }}>{formatValue(displayValue(r.best))} {forceUnit}</div>
          <div style={{ color: C.muted, fontSize: 12 }}>{r.best.date} · {fmt1(r.best.durationS)}s</div>
        </div>)}
      </div>
      <div role="img" aria-label={`All-time best force history in ${forceUnit}; solid lines show left hands, dashed lines show right hands.`}
        style={{ height: CHART.height, marginTop: 16, minWidth: 0 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={timeline} margin={CHART.margin}>
            <CartesianGrid stroke={C.border} strokeDasharray="3 3" />
            <XAxis dataKey="timestamp" type="number" scale="time" domain={['dataMin', 'dataMax']}
              tickFormatter={value => new Date(value).toISOString().slice(5, 10)} tick={CHART.tick} interval="preserveStartEnd" minTickGap={32} />
            <YAxis tick={CHART.tick} width={64} unit={` ${forceUnit}`} tickFormatter={value => relative ? Number(value.toFixed(2)) : Math.round(value)} />
            <Tooltip contentStyle={CHART.tooltip}
              labelFormatter={value => new Date(value).toISOString().slice(0, 10)}
              formatter={(value, name, item) => {
                const record = item.payload[`record${String(item.dataKey).replace('series', '')}`];
                return [`${formatValue(value)} ${forceUnit} · ${fmt1(record.durationS)}s · ${record.date}`, name];
              }} />
            {records.map((r, index) => <Line key={`${r.grip}-${r.hand}`} dataKey={`series${index}`}
              name={`${r.grip} · ${r.hand === 'L' ? 'Left hand' : 'Right hand'}`} stroke={GRIP_COLORS[r.grip] || C.blue}
              strokeDasharray={r.hand === 'R' ? '6 4' : undefined} strokeWidth={2.5}
              type="stepAfter" dot={timeline.length === 1 ? { r: 4 } : false} activeDot={{ r: 4 }} isAnimationActive={false} />)}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <ChartLegend items={records.map(r => ({ key: `${r.grip}-${r.hand}`,
        label: `${r.grip}: ${r.hand === 'L' ? 'Left hand' : 'Right hand'}`,
        color: GRIP_COLORS[r.grip] || C.blue, dashed: r.hand === 'R' }))} />
    </> : <p style={{ color: C.muted }}>No qualifying holds yet.</p>}
  </Card>;
}

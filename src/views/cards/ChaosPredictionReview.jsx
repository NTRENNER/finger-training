import React, { useMemo, useState } from 'react';
import { summarizeMixedPredictions } from '../../model/mixedLoadPrediction.js';
import { C } from '../../ui/theme.js';
import { Btn } from '../../ui/components.js';

const groupLabel = key => key.split('|').map(part => {
  const labels = { all: 'Overall', adaptive_targets: 'Adjusted targets',
    'context:first_recorded': 'First recorded finger work',
    'context:after_training': 'After earlier finger training', 'context:unknown': 'Training order unknown',
    'hand:left': 'Left hand', 'hand:right': 'Right hand' };
  if (labels[part]) return labels[part];
  if (part.startsWith('position:')) return `Hold ${part.split(':')[1]}`;
  return part.replace(/^(grip|domain):/, '').replace(/_/g, ' ');
}).join(' · ');

export function ChaosPredictionReview({ history = [] }) {
  const report = useMemo(() => summarizeMixedPredictions(history), [history]);
  const [dimension, setDimension] = useState('all');
  const rows = Object.entries(report.groups).filter(([key]) =>
    dimension === 'all' ? key.endsWith('|all') : key.includes(`|${dimension}:`));
  const fmt = n => n == null ? '—' : `${n.toFixed(1)}s`;
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'chaos-prediction-review.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <details style={{ margin: '20px 0' }}>
    <summary style={{ cursor: 'pointer', fontWeight: 700 }}>Chaos Machine · target-time research</summary>
    <p style={{ color: C.muted, lineHeight: 1.5 }}>Advance forecast error compares the estimate saved before a hold
      with its result. Target-time miss asks whether the adjusted weight delivered the intended duration.
      Both require measured force within 10% of plan and rest within 2 seconds. Each training date counts once.</p>
    <label>Compare Chaos results by
      <select value={dimension} onChange={e => setDimension(e.target.value)} style={{ display: 'block', width: '100%', margin: '8px 0', padding: '10px 12px', background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, font: 'inherit' }}>
        {Object.entries({ all: 'Overall', grip: 'Device', hand: 'Hand', domain: 'Domain', position: 'Hold number',
          context: 'Earlier finger training that day' }).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </label>
    {!rows.length ? <p>No comparable saved Chaos forecasts yet.</p> : rows.map(([key, score]) =>
      <section key={key} style={{ margin: '16px 0' }}>
        <strong>{groupLabel(key)}</strong>
        <p style={{ color: C.muted }}>{score.days} training dates · {score.holds} holds · {score.advance_days} dates match the plan</p>
        <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', minWidth: 340, textAlign: 'left', borderSpacing: 8 }}>
          <thead><tr><th>Check</th><th>Typical miss</th><th>Bias</th></tr></thead>
          <tbody><tr><th scope="row">Advance forecast</th><td>{fmt(score.advance_mae_s)}</td><td>{fmt(score.advance_bias_s)}</td></tr>
            <tr><th scope="row">Intended target time</th><td>{fmt(score.target_mae_s)}</td><td>{fmt(score.target_bias_s)}</td></tr></tbody>
        </table></div>
        <p style={{ color: C.muted, fontSize: 13 }}>Large forecast misses: {fmt(score.advance_rmse_s)}.
          Target-time evidence: {score.target_days} dates. Positive forecast bias means too optimistic;
          positive target bias means the hold lasted longer than intended.</p>
      </section>)}
    <p style={{ color: C.muted, fontSize: 13 }}>Versions and adjusted versus original targets stay separate.
      Fallback targets do not test load adjustment. Actual-load/rest diagnostics and exclusions remain in the download.
      Ten new dates is a review checkpoint, not proof of accuracy. No automatic model changes.</p>
    <Btn onClick={download}>Download Chaos review</Btn>
  </details>;
}

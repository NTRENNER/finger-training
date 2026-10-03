import React from 'react';
import { C } from './theme.js';

export function ChartLegend({ items }) {
  return <ul aria-label="Chart legend" style={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap',
    gap: '8px 16px', padding: 0, margin: '12px 0', listStyle: 'none', fontSize: 12, color: C.muted }}>
    {items.map(item => <li key={item.key || item.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <svg width="32" height="12" aria-hidden="true" style={{ flexShrink: 0, color: item.color }}>
        {item.kind === 'bar' ? <rect x="12" y="1" width="8" height="10" fill="currentColor" opacity="0.6" />
          : <line x1="0" y1="6" x2="32" y2="6" stroke="currentColor" strokeWidth="2.5" strokeDasharray={item.dashed ? '6 4' : undefined} />}
      </svg>
      {item.label}
    </li>)}
  </ul>;
}

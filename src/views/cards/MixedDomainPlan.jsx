import React from 'react';
import { C } from '../../ui/theme.js';
import { fmtW } from '../../ui/format.js';
import { MIXED_DOMAIN_ZONES, MIXED_DOMAIN_LABELS, mixedDomainSteps } from '../../model/mixedDomain.js';

export function MixedDomainPlan({ plan, hands, unit, multiplier, onOpeningChange }) {
  return <section aria-label="Whole curve beta plan" style={{ marginBottom: 20 }}>
    <p style={{ fontSize: 16, lineHeight: 1.5 }}>Five holds per hand. A different load each hold. Rest 30 seconds between holds.</p>
    <label style={{ display: 'block', marginBottom: 6 }}>
      First domain
      <select value={plan.steps[0].zone} onChange={e => onOpeningChange(e.target.value)}
        style={{ display: 'block', width: '100%', minHeight: 48, marginTop: 8, padding: 10,
          background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 16 }}>
        {MIXED_DOMAIN_ZONES.map(z => <option key={z} value={z}>{MIXED_DOMAIN_LABELS[z]}</option>)}
      </select>
    </label>
    <p style={{ margin: '0 0 16px', color: C.muted, fontSize: 13 }}>Rotates automatically for your next beta session.</p>
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${hands.length}, minmax(0, 1fr))`, gap: 16 }}>
      {hands.map(hand => <div key={hand} style={{ minWidth: 0 }}>
        <strong>{hand === 'L' ? 'Left hand' : 'Right hand'}</strong>
        <ol style={{ paddingLeft: 18, lineHeight: 1.5, fontSize: 14 }}>
          {mixedDomainSteps(plan, hand).map((step, i) => <li key={step.zone} style={{ padding: '8px 0' }}>
            <div style={{ overflowWrap: 'anywhere' }}>{MIXED_DOMAIN_LABELS[step.zone]}{i === 0 ? ' · first' : ''}</div>
            <strong style={{ fontSize: 22, color: C.blue }}>{fmtW(step.loadByHand[hand] * multiplier, unit)} {unit}</strong>
            <div style={{ color: C.muted, fontSize: 13 }}>{step.targetTime}s fresh reference</div>
          </li>)}
        </ol>
      </div>)}
    </div>
    <p style={{ color: C.muted, lineHeight: 1.5 }}>The times choose the loads; they are not countdowns. Later holds will usually be shorter. Maintain each target force until failure.</p>
    <p style={{ color: C.muted, lineHeight: 1.5 }}>Your first measured hold can update the curve. Later holds are saved as fatigued work. This beta has no precise tired-hold forecast and does not advance or reset your 4–6 rep progression.</p>
  </section>;
}

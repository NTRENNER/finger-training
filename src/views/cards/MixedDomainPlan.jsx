import React from 'react';
import './MixedDomainPlan.css';
import { C } from '../../ui/theme.js';
import { fmtW } from '../../ui/format.js';
import { MIXED_DOMAIN_ZONES, MIXED_DOMAIN_LABELS, mixedDomainSteps } from '../../model/mixedDomain.js';

export function MixedDomainPlan({ plan, hands, unit, multiplier, onOpeningChange, goalConfig = {} }) {
  const targetSeconds = (plan.steps.reduce((sum, step) => sum + step.targetTime, 0) + 4 * 30) * hands.length;
  const targetEstimate = `${Math.floor(targetSeconds / 60)}:${String(targetSeconds % 60).padStart(2, '0')}`;
  return <section aria-label="Chaos Machine beta plan" style={{ marginBottom: 20 }}>
    <p style={{ fontSize: 16, lineHeight: 1.5 }}>Five holds per hand. A different load each hold. Rest 30 seconds between holds.</p>
    <p style={{ color: C.muted, lineHeight: 1.5 }}>
      Later loads are estimated from your measured pulls and rest, then fixed for each hold.
      If measurements are missing, the original load is shown. You can still change it.
      About {targetEstimate}{hands.length === 2 ? ' for both hands' : ' for one hand'} if you reach every target, including rests. Setup and hand changes add time.
    </p>
    <label style={{ display: 'block', marginBottom: 6 }}>
      First domain
      <select value={plan.steps[0].zone} onChange={e => onOpeningChange(e.target.value)}
        style={{ display: 'block', width: '100%', minHeight: 48, marginTop: 8, padding: 10,
          background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 16 }}>
        {MIXED_DOMAIN_ZONES.map(z => <option key={z} value={z}>{MIXED_DOMAIN_LABELS[z]}</option>)}
      </select>
    </label>
    <p style={{ margin: '0 0 16px', color: C.muted, fontSize: 13 }}>Rotates automatically for your next beta session.</p>
    <div className="mixed-plan-hands" style={{ '--mixed-plan-columns': hands.length }}>
      {hands.map(hand => <div key={hand} style={{ minWidth: 0 }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>{hand === 'L' ? 'Left hand' : 'Right hand'}</h3>
        <ol className="mixed-plan-holds" aria-label={`${hand === 'L' ? 'Left' : 'Right'} hand holds`}>
          {mixedDomainSteps(plan, hand).map((step, i) => {
            const domain = goalConfig[step.zone];
            return <li key={step.zone} className="mixed-plan-hold"
              style={{ background: C.bg, border: `1px solid ${C.border}` }}>
              <div className="mixed-plan-hold-heading">
                <span style={{ color: domain?.color || C.text, fontSize: 14, fontWeight: 700 }}>
                  {i + 1}. {domain?.emoji} {MIXED_DOMAIN_LABELS[step.zone]}
                </span>
                <span style={{ fontSize: 20, fontWeight: 700, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                  {step.targetTime}s
                </span>
              </div>
              <strong style={{ display: 'block', marginTop: 8, fontSize: 24, lineHeight: 1.2, color: C.blue }}>
                {fmtW(step.loadByHand[hand] * multiplier, unit)} <span style={{ fontSize: 14 }}>{unit}</span>
              </strong>
              <div style={{ color: C.muted, fontSize: 12, marginTop: 6 }}>
                {i === 0 ? 'First hold · Fresh reference' : 'Starting reference · adjusted before this hold'}
              </div>
            </li>;
          })}
        </ol>
      </div>)}
    </div>
    <p style={{ color: C.muted, lineHeight: 1.5 }}>Aim for approximately the displayed times. Keep the load steady and hold until failure; reaching the target does not stop the timer.</p>
    <p style={{ color: C.muted, lineHeight: 1.5 }}>Your first measured hold can update the curve. Later holds are saved as fatigued work. These estimates are experimental. Your 4–6 rep progression is unchanged.</p>
  </section>;
}
